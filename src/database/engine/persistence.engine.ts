// persistence.manager.ts
import { Injectable, Logger, Inject, InternalServerErrorException } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetsDataGateway } from '../services/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { BaseEngine } from '../engines/Base.Engine';
import { ClassType } from '@database/types/query.types';
import { ManipulateEngine } from './manipulateEngine';
import { BaseEntity } from '@database/entities/base.entity';
import { GLOBAL_RELATION_REGISTRY, RELATION_METADATA_KEY, RelationOptions } from '@database/decorators/relation.decorator';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { GettersEngine } from './getters.engine';
import { getColumnLetter } from '@database/utils/tools';
import { RepositoryContext } from '@database/repositories/repository.context';
import { PRIMARY_KEY_METADATA_KEY } from '@database/decorators/primarykey.decorator';
import { TABLE_COLUMN_DETAILS_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';



@Injectable()
export class PersistenceEngine implements IPersistenceEngine {

    private readonly logger = new Logger(PersistenceEngine.name);

    constructor(
        private readonly gateway: SheetsDataGateway,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine,
        private readonly mapper: SheetMapper,
        private readonly googleSpreadsheetService: GoogleAutenticarService,
        private readonly gettersEngine: GettersEngine,

    ) {

    }



    // En PersistenceEngine (que hereda de BaseEngine)
    private async exists<T extends object>(entityClass: new () => T, id: string | number): Promise<boolean> {
        try {
            // Usamos el ctx que ya viene en la base para llegar al GettersEngine
            await this.ctx.gettersEngine.getRowIndexById(entityClass, id);
            return true;
        } catch {
            return false;
        }
    }
    private async verifyRestrictions(dep: any, parentId: any, ctx: RepositoryContext) {
        const children = await ctx.gettersEngine.findAll(dep.childSheet);
        const hasChildren = children.some(c => c[dep.joinColumn] === parentId);

        if (hasChildren) {
            throw new Error(
                `No se puede eliminar: Existen registros en '${dep.childSheet}' vinculados a este ID.`
            );
        }
    }






    /**
     * Obtiene los datos, priorizando el caché.
     */
    async fetchRows(sheetName: string): Promise<any[][]> {
        const cacheKey = `sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${sheetName}`;
        const cached = await this.cacheManager.get<any[][]>(cacheKey);

        if (cached) return cached;

        const rows = await this.gateway.getValues(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!A:Z`);
        if (rows && rows.length > 0) {
            await this.cacheManager.set(cacheKey, rows, 300); // 5 min de TTL
        }
        return rows || [];
    }
    /**
    * Elimina una entidad mediante Soft Delete.
    * Busca la columna marcada como 'isDeleteControl', la pone en 'false' y actualiza la fila.
    * Gestiona automáticamente las dependencias de eliminación (CASCADE).
    * @param entityClass La clase de la entidad a eliminar
    * @param id El ID de la entidad a eliminar
    * @returns void
    */
    // persistence.engine.ts

    /**
     * Borrado lógico con soporte de cascada
     */
    async delete<T extends object>(entityClass: new () => T, id: string | number, ctx: RepositoryContext): Promise<void> {
        const entityName = entityClass.name;

        // 1. GESTIÓN DE CASCADA: Revisar si hay hijos que dependan de este ID
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];
        for (const dep of dependencies) {
            if (dep.onDelete === 'CASCADE') {
                // Buscamos los registros hijos que tengan el FK igual al ID que estamos borrando
                const children = await ctx.gettersEngine.findAll(dep.childEntity);
                const childrenToDelete = children.filter(c => String(c[dep.joinColumn]) === String(id));

                for (const child of childrenToDelete) {
                    // LLAMADA RECURSIVA: Aplica la misma lógica a los hijos
                    // Buscamos la PK del hijo para poder identificarlo
                    const childPkProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, dep.childEntity);
                    await this.delete(dep.childEntity, child[childPkProp], ctx);
                }
            }
        }

        // 2. EJECUCIÓN DEL SOFT DELETE EN LA ENTIDAD ACTUAL
        await this.applySoftDelete(entityClass, id, ctx);
    }

    private async applySoftDelete<T>(entityClass: new () => T, id: string | number, ctx: RepositoryContext): Promise<void> {
        const details = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, entityClass.prototype);
        const columnsList = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, entityClass.prototype);

        // A. Encontrar la columna de control (isDeleteControl: true)
        const statusProp = Object.keys(details).find(key => details[key].isDeleteControl);
        if (!statusProp) {
            throw new Error(`La entidad ${entityClass.name} no define una columna @Column({ isDeleteControl: true })`);
        }

        // B. Obtener el rowIndex real usando el ID
        const rowIndex = await ctx.gettersEngine.getRowIndexById(entityClass, id);

        // C. Calcular la letra de la columna de estado
        const colIndex = columnsList.indexOf(statusProp);
        const columnLetter = ctx.mapper.getColumnLetter(colIndex);

        // D. Actualización Batch en Google Sheets
        const range = `${entityClass.name}!${columnLetter}${rowIndex}`;
        await ctx.gateway.updateCellsBatch(ctx.options.spreadsheetId, [
            { range, value: false } // Marcamos como inactivo
        ]);

        // Limpiar caché para que las futuras consultas no vean el dato viejo
        ctx.gettersEngine.clearCache(entityClass.name);
    }

    /**
     * Guardar o actualizar (Upsert)
     */
    async save<T extends object>(entityClass: new () => T, entity: T, ctx: RepositoryContext): Promise<T> {
        const pkProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, entityClass);
        const id = entity[pkProp];

        if (id) {
            // Lógica de Update...
            return await this.update(entityClass, id, entity, ctx);
        } else {
            // Lógica de Insert (con AutoIncrement si aplica)...
            return await this.create(entityClass, entity, ctx);
        }
    }

    /**
    * Actualiza múltiples celdas en una sola petición HTTP
    * @param spreadsheetId ID del documento
    * @param updates Array de objetos { range: 'Hoja1!A2', value: 'nuevo_valor' }
    */
    async updateCellsBatch(spreadsheetId: string, updates: { range: string, value: any }[]): Promise<void> {
        try {
            const data = updates.map(u => ({
                range: u.range,
                values: [[u.value]] // Google requiere un array de arrays para los valores
            }));

            await this.googleSpreadsheetService.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: data
                }
            });

            this.logger.log(`BatchUpdate exitoso: ${updates.length} celdas actualizadas.`);
        } catch (error) {
            this.logger.error(`Error en BatchUpdate: ${error.message}`);
            throw new InternalServerErrorException('No se pudo realizar la actualización por lotes.');
        }
    }

    /**
     * Escribe o actualiza datos y limpia el caché correspondiente.
     */
    async writeRow(sheetName: string, range: string, values: any[]): Promise<void> {
        await this.gateway.updateSheet(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!${range}`, [values]);
        await this.clearCache(sheetName);
    }
    /*
    * Descripcion: Agrega una nueva fila a la hoja
    * Parametros: 
    *   sheetName: Nombre de la hoja
    *   values: Valores a agregar
    * Retorna: void
    */
    async appendRow(sheetName: string, values: any[]): Promise<void> {
        await this.manipulateEngine.appendObject(
            this.optionsDatabase.defaultSpreadsheetId,
            `${sheetName}!A:A`,
            [values]);
        await this.clearCache(sheetName);
    }
    /*
    * Descripcion: Limpia el caché de la hoja
    * Parametros: 
    *   sheetName: Nombre de la hoja
    * Retorna: void
    */
    /**
 * Invalida todos los niveles de caché relacionados con una hoja específica.
 * Se ubica en PersistenceEngine porque este motor conoce la estructura 
 * de almacenamiento en Google Sheets.
 */
    /**
 * Invalida todos los niveles de caché para una entidad específica.
 * Este método centraliza la "limpieza de rastro" después de cualquier mutación.
 */
    public async clearCache(sheetName: string): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // Definimos las llaves que queremos limpiar
        const keys = [
            `sheet_data:${spreadsheetId}:${sheetName}`, // Data cruda (infraestructura)
            `list:${sheetName}`,                        // Lista de entidades (dominio)
        ];

        try {
            // Ejecución en paralelo para máxima velocidad
            await Promise.all(keys.map(key => this.cacheManager.del(key)));

            this.logger.debug(`[Cache] Memoria invalidada para la hoja: "${sheetName}"`);
        } catch (error) {
            this.logger.error(`[Cache] Error al intentar limpiar caché de ${sheetName}: ${error.message}`);
            // No lanzamos error para no romper la ejecución principal (create/update)
            // ya que el caché eventualmente expirará por TTL.
        }
    }

    /**
     * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
     */
    async create<T extends object>(entity: T): Promise<T> {
        // 1. Usamos el EntityClass que ya tenemos en la clase base
        const sheetName = this.EntityClass.name;

        // 2. Obtenemos headers (Usando el servicio de Google que ya tiene caché)
        const rawData = await this.gettersEngine.getOrFetchSheet(sheetName);
        const headers = rawData && rawData.length > 0 ? rawData[0] : [];

        if (headers.length === 0) {
            throw new Error(`No se pudieron obtener los encabezados para la hoja: ${sheetName}`);
        }

        // 3. Preparación de ID (Opcional: Si no viene, podrías generarlo aquí)
        // const entityWithId = this.ensureId(entity);

        // 4. Convertimos la entidad a una fila plana (Array)
        // SheetMapper.mapToRow debe ser el inverso de mapToEntity
        const row = SheetMapper.mapToRow(headers, entity);

        // 5. Guardamos en Google Sheets
        // Importante: mandamos [row] porque appendRows espera una matriz de datos
        await this.gateway.appendRows(
            this.optionsDatabase.defaultSpreadsheetId,
            `${sheetName}!A1`,
            [row]
        );

        // 6. LIMPIEZA DE CACHÉ (Vital para la consistencia)
        await this.clearCache(sheetName);

        return entity;
    }





}