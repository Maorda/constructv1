// persistence.manager.ts
import { Injectable, Logger, Inject, InternalServerErrorException, NotFoundException } from '@nestjs/common';
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
import { ColumnOptions, TABLE_COLUMN_DETAILS_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { TABLE_NAME_KEY } from '@database/decorators/table.decorator';
import { ModuleRef } from '@nestjs/core';


export class PersistenceEngine<T extends object> implements IPersistenceEngine<T> {

    private readonly logger = new Logger(PersistenceEngine.name);
    private readonly resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private currentHeaders: string[] = [];
    private readonly deleteControlProp: string | null;


    constructor(
        private readonly entityClass: new () => T,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine<T>,
        private readonly mapper: SheetMapper<T>,
        private readonly googleSpreadsheetService: GoogleAutenticarService,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef, // <--- Para localizar repositorios hijos

    ) {
        // 1. Resolvemos el nombre de la hoja (usando @Table)
        this.resolvedSheetName = Reflect.getMetadata(TABLE_NAME_KEY, this.entityClass)
            || NamingStrategy.formatSheetName(this.entityClass.name);

        // 2. Pre-cargamos la Primary Key (evita Reflect.getMetadata en cada save)
        this.primaryKeyProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, this.entityClass.prototype) || 'id';

        // 3. Pre-cargamos el mapa de detalles para conversiones rápidas antes de enviar a Google Sheets
        this.columnDetails = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, this.entityClass.prototype) || {};
    }
    /**
      * SAVE: Determina automáticamente si debe Crear o Actualizar.
      */
    async save(entity: T): Promise<T> {
        // Extraemos el valor de la Primary Key (ej: el valor de entity.id)
        const idValue = (entity as any)[this.primaryKeyProp];

        // Si tiene ID, intentamos actualizar; si no, creamos.
        if (idValue) {
            // Lógica de Update (puedes delegar a un método update interno)
            return await this.update(idValue, entity);
        } else {
            return await this.create(entity);
        }
    }
    /**
     * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
     */
    async create(entity: T): Promise<T> {
        const sheetName = this.resolvedSheetName;

        // 1. Obtener encabezados desde el motor de lectura (Aprovecha el caché)
        const rawData = await this.gettersEngine.getOrFetchSheet(sheetName);
        const headers = rawData && rawData.length > 0 ? rawData[0] : [];

        if (headers.length === 0) {
            throw new InternalServerErrorException(`Estructura de hoja no encontrada: ${sheetName}`);
        }

        // 2. Mapeo Profesional (Inverso)
        // Usamos el SheetMapper con el mapa de detalles que ya conoce los tipos (Soles, Fechas, etc.)
        const row = SheetMapper.mapToRow(headers, entity, this.columnDetails);

        try {
            // 3. Persistencia física
            await this.gateway.appendRows(
                this.optionsDatabase.defaultSpreadsheetId,
                `${sheetName}!A1`,
                [row]
            );

            // 4. Mantenimiento de Caché
            // Invalida la lista para que el usuario vea su nuevo registro inmediatamente
            await this.clearCache(sheetName);

            return entity;
        } catch (error) {
            throw new InternalServerErrorException('Error al persistir en Google Sheets.');
        }
    }
    /**
     * UPDATE: Busca la fila por ID y actualiza todas sus celdas.
     */
    async update(id: string | number, entity: T): Promise<T> {
        const sheetName = this.resolvedSheetName;

        // 1. Buscamos la fila donde reside este ID
        const rowIndex = await this.gettersEngine.findRowIndexById(id);
        if (rowIndex === -1) {
            throw new NotFoundException(`No se encontró el registro con ID ${id} en ${sheetName}`);
        }

        // 2. Obtenemos headers y mapeamos la entidad a una fila completa
        await this.refreshHeaders();
        const row = SheetMapper.mapToRow(this.currentHeaders, entity, this.columnDetails);

        try {
            // 3. Calculamos el rango de la fila (A{n}:Z{n})
            const lastColLetter = this.indexToColumnLetter(this.currentHeaders.length - 1);
            const range = `A${rowIndex + 2}:${lastColLetter}${rowIndex + 2}`;

            // 4. Persistencia física
            await this.gateway.updateSheet(
                this.optionsDatabase.defaultSpreadsheetId,
                `${sheetName}!${range}`,
                [row]
            );

            await this.clearCache(sheetName);
            return entity;
        } catch (error) {
            this.logger.error(`Error al actualizar fila ${rowIndex + 2}: ${error.message}`);
            throw new InternalServerErrorException('Error al actualizar en Google Sheets.');
        }
    }

    /**
     * DELETE: Procesa cascada y decide entre borrado lógico o físico.
     */
    async delete(id: string | number): Promise<void> {
        const rowIndex = await this.gettersEngine.findRowIndexById(id);
        if (rowIndex === -1) return;

        // 1. CASCADA: El motor busca hijos y los elimina primero
        await this.executeAutoCascade(id);

        // 2. ELIMINACIÓN
        if (this.deleteControlProp) {
            await this.updateLogicalStatus(rowIndex, 'ELIMINADO');
        } else {
            await this.executePhysicalDelete(rowIndex);
        }

        await this.clearCache(this.resolvedSheetName);
    }
    /**
      * EXISTS: Verifica si un ID ya está presente en la columna de Primary Key.
      */
    async exists(id: string | number): Promise<boolean> {
        const index = await this.gettersEngine.findRowIndexById(id);
        return index !== -1;
    }
    /**
 * Actualiza parcialmente una entidad usando su índice de fila interno.
 */
    async updateEntity(entity: T, changes: Partial<T>): Promise<void> {
        const rowIndex = (entity as any).__row;

        if (rowIndex === undefined) {
            throw new Error("No se puede actualizar una entidad que no tiene un índice de fila (__row).");
        }

        // Ejecutamos la actualización parcial que ya configuramos con BatchUpdate
        await this.updatePartialBatch(rowIndex, changes);

        // Opcional: Actualizamos el objeto en memoria para que refleje los cambios
        Object.assign(entity, changes);
    }

    /*
      * Descripcion: Limpia el caché de la hoja, Invalida todos 
      * los niveles de caché relacionados con una hoja específica
      * Se ubica en PersistenceEngine porque este motor conoce la estructura 
      * de almacenamiento en Google Sheets.
      * Parametros: 
      *   sheetName: Nombre de la hoja
      * Retorna: void
    */
    /**
 * 
 */
    private async clearCache(sheetName: string): Promise<void> {
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
     * Escribe o actualiza datos y limpia el caché correspondiente.
     */
    private async updateRow(sheetName: string, range: string, values: any[]): Promise<void> {
        await this.gateway.updateSheet(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!${range}`, [values]);
        await this.clearCache(sheetName);
    }

    /**
 * Actualización masiva de celdas basada en propiedades de la entidad.
 * @param rowIndex El índice de la fila (0 para la primera fila de datos, después del header).
 * @param changes Objeto parcial con los campos a actualizar { sueldo: 1500, estado: 'PAGADO' }.
 */
    async updatePartialBatch(rowIndex: number, changes: Partial<T>): Promise<void> {
        // 1. Sincronizar headers para saber en qué columnas están las propiedades
        await this.refreshHeaders();

        // 2. Construir el array de actualizaciones traduciendo propKeys a Rangos A1
        const updates = Object.entries(changes).map(([propKey, value]) => {
            const config = this.columnDetails[propKey];
            return {
                range: this.getCellRange(propKey, rowIndex), // Ahora currentHeaders ya existe
                value: value,
                type: config?.type
            };
        });

        // 3. Ejecutar el BatchUpdate que ya definimos
        await this.updateCellsBatch(updates);
    }

    /**
     * El método core que realiza la petición física.
     */
    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;

        try {
            const data = updates.map(u => ({
                range: u.range,
                values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
            }));

            await this.googleSpreadsheetService.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: data
                }
            });

            // Limpiar caché para que la siguiente lectura sea verídica
            await this.cacheManager.del(`sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${this.resolvedSheetName}`);

        } catch (error) {
            throw new InternalServerErrorException('Error al sincronizar celdas por lote.');
        }
    }

    /**
     * Asegura que tengamos los headers más recientes de la hoja.
     */
    private async refreshHeaders(): Promise<string[]> {
        const rawData = await this.gettersEngine.getOrFetchSheet(this.resolvedSheetName);
        this.currentHeaders = (rawData && rawData.length > 0) ? rawData[0] : [];

        if (this.currentHeaders.length === 0) {
            throw new Error(`No se pudieron obtener los encabezados de ${this.resolvedSheetName}`);
        }
        return this.currentHeaders;
    }

    /**
     * Resuelve la coordenada A1 para una propiedad específica y un índice de fila.
     */
    private getCellRange(propKey: string, rowIndex: number): string {
        // 1. Obtener la configuración de la columna para saber su nombre en Excel
        const config = this.columnDetails[propKey];
        const headerName = config?.name || propKey;

        // 2. Encontrar el índice de la columna en los headers actuales
        // (Esta lista de headers deberías tenerla cacheada o pasarla como argumento)
        const colIndex = this.currentHeaders.findIndex(
            h => h.trim().toLowerCase() === headerName.toLowerCase()
        );

        if (colIndex === -1) throw new Error(`Columna ${headerName} no encontrada en la hoja.`);

        // 3. Convertir índice (0, 1, 2...) a letra (A, B, C... AA, AB...)
        const colLetter = this.indexToColumnLetter(colIndex);

        // 4. Retornar rango (rowIndex + 2 porque la fila 1 son headers y Excel es base 1)
        return `${this.resolvedSheetName}!${colLetter}${rowIndex + 2}`;
    }

    /**
     * Convierte un índice numérico a letras de columna de Excel (0 -> A, 26 -> AA).
     */
    private indexToColumnLetter(index: number): string {
        let temp = index;
        let letter = '';
        while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
        }
        return letter;
    }

    /**
     * Procesa las relaciones registradas en GLOBAL_RELATION_REGISTRY
     */
    private async handleCascade(parentId: string | number): Promise<void> {
        const entityName = this.entityClass.name;
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName);

        if (!dependencies || dependencies.length === 0) return;

        for (const dep of dependencies) {
            try {
                // Obtenemos el repositorio/servicio hijo dinámicamente
                const childRepo = this.moduleRef.get(dep.childRepository, { strict: false });

                if (childRepo && typeof childRepo.deleteByParent === 'function') {
                    this.logger.debug(`[Cascade] Limpiando ${dep.childSheet} para el padre ID ${parentId}`);
                    await childRepo.deleteByParent(dep.joinColumn, parentId);
                }
            } catch (error) {
                this.logger.error(`Error en cascada hacia ${dep.childSheet}: ${error.message}`);
            }
        }
    }

    /**
     * Borrado físico de la fila (el método que ya teníamos)
     */
    private async executePhysicalDelete(rowIndex: number): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const sheetId = await this.gateway.getSheetIdByName(spreadsheetId, this.resolvedSheetName);

        await this.googleSpreadsheetService.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId,
                            dimension: 'ROWS',
                            startIndex: rowIndex + 1,
                            endIndex: rowIndex + 2
                        }
                    }
                }]
            }
        });
    }
    /**
      * CASCADA AUTÓNOMA: Busca dependencias en el Registro Global.
      */
    private async executeAutoCascade(parentId: string | number): Promise<void> {
        const entityName = this.entityClass.name;
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName);

        if (!dependencies || dependencies.length === 0) return;

        for (const dep of dependencies) {
            try {
                // Localizamos el repositorio del hijo
                const childRepo = this.moduleRef.get(dep.childRepository, { strict: false });

                // Si el repositorio tiene una instancia del motor expuesta
                if (childRepo && childRepo.engine) {
                    await this.deleteChildrenManually(childRepo.engine, dep.joinColumn, parentId);
                }
            } catch (error) {
                this.logger.error(`Error en cascada hacia ${dep.childSheet}: ${error.message}`);
            }
        }
    }

    /**
     * Actualiza solo la celda de control (Borrado Lógico).
     */
    private async updateLogicalStatus(rowIndex: number, value: string): Promise<void> {
        if (!this.deleteControlProp) return;

        // CORRECCIÓN TS: refreshHeaders ahora devuelve string[]
        const headers = await this.refreshHeaders();

        const config = this.columnDetails[this.deleteControlProp];
        const headerName = config?.name || this.deleteControlProp;

        const colIndex = headers.findIndex(h => h.trim().toLowerCase() === headerName.toLowerCase());

        if (colIndex === -1) throw new Error(`Columna de control ${headerName} no encontrada.`);

        const colLetter = this.indexToColumnLetter(colIndex);
        const range = `${colLetter}${rowIndex + 2}`;

        await this.gateway.updateSheet(
            this.optionsDatabase.defaultSpreadsheetId,
            `${this.resolvedSheetName}!${range}`,
            [[value]]
        );
    }

    /**
     * Helper para que el motor limpie hijos basándose en una columna de unión
     */
    private async deleteChildrenByQuery(childEngine: any, joinColumn: string, parentId: any): Promise<void> {
        // 1. Obtener toda la data de la hoja hija
        const childData = await childEngine.findAll();

        // 2. Filtrar los que pertenecen al padre
        const toDelete = childData.filter((item: any) => String(item[joinColumn]) === String(parentId));

        // 3. Mandar a eliminar cada uno (esto disparará la cascada recursivamente)
        for (const item of toDelete) {
            const childPk = Reflect.getMetadata('primaryKey', childEngine.entityClass);
            if (item[childPk]) {
                await childEngine.delete(item[childPk]);
            }
        }
    }
    /**
     * Busca y elimina registros hijos que coincidan con el ID del padre.
     */
    private async deleteChildrenManually(childEngine: PersistenceEngine<any>, joinColumn: string, parentId: any): Promise<void> {
        // Obtenemos todos los datos de la hoja hija
        const allData = await childEngine.gettersEngine.findAllEntities(childEngine.entityClass);

        // Filtramos los que pertenecen a este padre
        const children = allData.filter((item: any) => String(item[joinColumn]) === String(parentId));

        for (const child of children) {
            const childPk = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, childEngine.entityClass.prototype) || 'id';
            const childId = child[childPk];
            if (childId) {
                await childEngine.delete(childId); // Recursividad para niveles N...
            }
        }
    }




}

