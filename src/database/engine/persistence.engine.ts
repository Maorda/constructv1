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



@Injectable()
export class PersistenceEngine extends BaseEngine {
    private readonly logger = new Logger(PersistenceEngine.name);
    private isSynced = false;

    constructor(
        entityClass: ClassType,
        private readonly gateway: SheetsDataGateway,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine,
        private readonly mapper: SheetMapper,
        private readonly googleSpreadsheetService: GoogleAutenticarService,
        private readonly gettersEngine: GettersEngine

    ) {
        super(entityClass)
    }
    /**
     * Sincroniza el esquema de la hoja de Google Sheets.
     * Compara las cabeceras actuales con las definidas en los decoradores de la Entidad.
     */
    async syncSchema(force: boolean = false): Promise<void> {

        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // 1. Obtener definición de columnas desde el código
        const expectedHeaders = SheetMapper.getColumnHeaders(this.EntityClass);
        const cleanExpected = expectedHeaders.map(h => String(h || '').trim());

        if (cleanExpected.length === 0) {
            this.logger.error(`❌ Error: No se encontraron decoradores @Column en ${this.EntityClass.name}`);
            return;
        }

        try {
            // --- PASO A: VALIDACIÓN Y CREACIÓN DE PESTAÑA ---
            const metadata = await this.gateway.getSpreadsheetMetadata();
            const sheetExists = metadata.sheets.some(s => s.properties.title === this.EntityClass.name);

            if (!sheetExists) {
                this.logger.warn(`Pestaña "${this.EntityClass.name}" no existe. Creándola...`);
                await this.gateway.createSheet(spreadsheetId, this.EntityClass.name);
                force = true; // Forzamos escritura de cabeceras en la nueva hoja
            }

            // --- PASO B: CHEQUEO DE CABECERAS ---
            let currentHeaders: any[] = [];
            if (!force) {
                const range = `${this.EntityClass.name}!A1:Z1`;
                const response = await this.gateway.getValues(spreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }

            // Comparación inteligente (Ignora mayúsculas/minúsculas para decidir si sincronizar)
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) =>
                    String(currentHeaders[i] || '').trim().toUpperCase() !== h.toUpperCase()
                );

            if (isDesync) {
                this.logger.warn(`✍️ Sincronizando cabeceras en "${this.EntityClass.name}"...`);

                // Escribimos respetando el Case original del código
                await this.gateway.updateRowRaw(
                    spreadsheetId,
                    `${this.EntityClass.name}!A1`,
                    [cleanExpected]
                );

                await this.cacheManager.del(`sheet_data:${spreadsheetId}:${this.EntityClass.name}`);
                this.logger.log(`✅ Esquema de "${this.EntityClass.name}" actualizado.`);
            } else {
                this.logger.log(`✅ Esquema de "${this.EntityClass.name}" al día.`);
            }

        } catch (error) {
            this.logger.error(`❌ Error en syncSchema [${this.EntityClass.name}]: ${error.message}`);
            if (error.response?.data) {
                this.logger.error('Detalle técnico Google:', JSON.stringify(error.response.data));
            }
        }
    }
    /*
    *Descripcion: Asegura que el esquema de la hoja de Google Sheets esté sincronizado
    * Parametros: 
    *   none
    * Retorna: void
    */
    async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.syncSchema();
        this.isSynced = true;
    }


    /**
     * getHeaders Estricto: 
     * Obtiene los encabezados UNICAMENTE de lo definido en los decoradores de la Entidad.
     */
    async getHeaders(): Promise<string[]> {

        const cacheKey = `headers_strict:${this.EntityClass.name}`;

        // 1. Intentar obtener de caché
        const cached = await this.cacheManager.get<string[]>(cacheKey);
        if (cached) return cached;

        // 2. Obtener encabezados mediante SheetMapper (vía metadatos de Reflection)
        // Esto asegura que el orden y los nombres sean los que TÚ definiste en el código
        const headers = SheetMapper.getColumnHeaders(this.EntityClass);

        if (!headers || headers.length === 0) {
            throw new Error(`La entidad ${this.EntityClass.name} no tiene columnas decoradas con @Column.`);
        }

        // 3. Guardar en caché
        await this.cacheManager.set(cacheKey, headers, 3600000); // 1 hora
        return headers;
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

    async delete<T extends BaseEntity>(entityClass: new () => T, id: string | number): Promise<void> {
        const entityName = entityClass.name;

        // 1. OBTENER METADATA DE RELACIONES (Tu registro global)
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];

        for (const dep of dependencies) {
            if (dep.onDelete === 'CASCADE') {
                // Buscamos los hijos para aplicarles el softDelete también
                const children = await this.gettersEngine.findAll(dep.childEntity);
                const childrenToDisable = children.filter(c => c[dep.joinColumn] === id);

                for (const child of childrenToDisable) {
                    // LLAMADA RECURSIVA: Borra a los hijos (y a los hijos de los hijos)
                    await this.delete(dep.childEntity, Number(child[dep.joinColumn]) as number);
                }
            }
        }

        // 2. EJECUTAR EL SOFT DELETE USANDO DECORADORES
        await this.applySoftDelete(entityClass, id);
    }

    private async applySoftDelete<T>(entityClass: new () => T, id: string | number): Promise<void> {
        // Buscamos cuál es la columna decorada como 'activo' o 'status'
        // Asumimos que el decorador @Column guarda un flag 'isDeleteControl' o similar
        const columns = Reflect.getMetadata('SHEETS_COLUMNS', entityClass.prototype) || {};
        const statusKey = Object.keys(columns).find(key => columns[key].isDeleteControl);

        if (!statusKey) {
            throw new Error(`La entidad ${entityClass.name} no tiene una columna de control de estado.`);
        }

        const sheetName = entityClass.name;
        const rowIndex = await this.gettersEngine.getRowIndexById(entityClass, id);

        // Usamos tu lógica de Batch Update para cambiar el valor a 'false'
        const columnLetter = getColumnLetter(columns[statusKey].index);
        const range = `${sheetName}!${columnLetter}${rowIndex}`;

        await this.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, [
            { range, value: false }
        ]);
        this.clearCache(sheetName)
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