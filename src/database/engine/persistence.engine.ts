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
import { getColumnLetter, withRetry } from '@database/utils/tools';
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
        private readonly googleSpreadsheetService: GoogleAutenticarService,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef, // <--- Para localizar repositorios hijos

    ) {
        this.resolvedSheetName = Reflect.getMetadata(TABLE_NAME_KEY, this.entityClass)
            || NamingStrategy.formatSheetName(this.entityClass.name);

        this.primaryKeyProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, this.entityClass.prototype) || 'id';
        this.columnDetails = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, this.entityClass.prototype) || {};

        // CORRECCIÓN 1: Inicialización del control de borrado lógico
        this.deleteControlProp = Reflect.getMetadata(DELETE_CONTROL_METADATA_KEY, this.entityClass.prototype) || null;
    }
    /**
      * SAVE: Determina automáticamente si debe Crear o Actualizar.
      */
    async save(entity: T): Promise<T> {
        const idValue = (entity as any)[this.primaryKeyProp];
        return idValue ? await this.update(idValue, entity) : await this.create(entity);
    }
    /**
     * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
     */
    async create(entity: T): Promise<T> {
        const headers = await this.refreshHeaders();
        const row = SheetMapper.mapToRow(headers, entity, this.columnDetails);

        try {
            await this.gateway.appendRows(
                this.optionsDatabase.defaultSpreadsheetId,
                `${this.resolvedSheetName}!A1`,
                [row]
            );

            await this.clearCache(this.resolvedSheetName);

            // Asignación de __row aproximada para compatibilidad
            const rawData = await this.gettersEngine.getOrFetchSheet(this.resolvedSheetName);
            (entity as any).__row = Math.max(0, rawData.length - 2);

            return entity;
        } catch (error) {
            this.logger.error(`Error al crear entidad en ${this.resolvedSheetName}: ${error.message}`);
            throw new InternalServerErrorException('Error en la persistencia física de Google Sheets.');
        }
    }
    /**
     * UPDATE: Busca la fila por ID y actualiza todas sus celdas.
     */
    async update(id: string | number, entity: T): Promise<T> {
        const rowIndex = await this.gettersEngine.findRowIndexById(id);
        if (rowIndex === -1) {
            throw new NotFoundException(`No se encontró el registro con ID ${id}`);
        }

        // CORRECCIÓN 2: Delegar al BatchUpdate parcial en lugar de reescribir toda la fila
        // Aquí pasamos la entidad completa. Si tienes el 'delta' integrado en tu Document, 
        // deberías pasar solo los cambios, pero esta función maneja la entidad plana temporalmente.
        const changes = this.manipulateEngine.prepareForSave(entity);
        await this.updatePartialBatch(rowIndex, changes);

        return entity;
    }

    /**
     * DELETE: Procesa cascada y decide entre borrado lógico o físico.
     */
    async delete(id: string | number): Promise<void> {
        const rowIndex = await this.gettersEngine.findRowIndexById(id);
        if (rowIndex === -1) return;

        await this.executeAutoCascade(id);

        if (this.deleteControlProp) {
            await this.updateLogicalStatus(rowIndex, 'ELIMINADO'); // O la fecha actual
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
            throw new Error("No se puede actualizar una entidad sin índice de fila (__row).");
        }
        await this.updatePartialBatch(rowIndex, changes);
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
    // --- MÉTODOS PRIVADOS DE INFRAESTRUCTURA ---

    private async clearCache(sheetName: string): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const keys = [
            `sheet_data:${spreadsheetId}:${sheetName}`,
            `list:${sheetName}`,
        ];
        try {
            await Promise.all(keys.map(key => this.cacheManager.del(key)));
        } catch (error) {
            this.logger.error(`[Cache] Error al limpiar ${sheetName}: ${error.message}`);
        }
    }


    /**
 * Actualización masiva de celdas basada en propiedades de la entidad.
 * @param rowIndex El índice de la fila (0 para la primera fila de datos, después del header).
 * @param changes Objeto parcial con los campos a actualizar { sueldo: 1500, estado: 'PAGADO' }.
 */
    async updatePartialBatch(rowIndex: number, changes: Partial<T>): Promise<void> {
        await this.refreshHeaders();

        const updates = Object.entries(changes).map(([propKey, value]) => {
            const config = this.columnDetails[propKey];
            return {
                range: this.getCellRange(propKey, rowIndex),
                value: value,
                type: config?.type
            };
        });

        await this.updateCellsBatch(updates);
    }

    /**
     * El método core que realiza la petición física.
     */
    // persistence.manager.ts

    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;

        const data = updates.map(u => ({
            range: u.range,
            values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
        }));

        try {
            // ENVOLVEMOS LA LLAMADA CON withRetry
            await withRetry(async () => {
                return await this.googleSpreadsheetService.sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                    requestBody: {
                        valueInputOption: 'USER_ENTERED',
                        data: data
                    }
                });
            }, 3, 1500); // 3 intentos, empezando con 1.5 segundos de espera

            await this.clearCache(this.resolvedSheetName);

        } catch (error) {
            const status = error?.status || error?.response?.status;
            if (status === 429) {
                this.logger.error("Se ha agotado la cuota de la API de Google Sheets. Espera un momento.");
            } else {
                this.logger.error(`Fallo definitivo tras reintentos: ${error.message}`);
            }
            throw new InternalServerErrorException('No se pudo sincronizar con Google Sheets tras varios intentos.');
        }
    }

    /**
     * Asegura que tengamos los headers más recientes de la hoja.
     */
    private async refreshHeaders(): Promise<string[]> {
        const rawData = await this.gettersEngine.getOrFetchSheet(this.resolvedSheetName);
        this.currentHeaders = (rawData && rawData.length > 0) ? rawData[0] : [];
        if (this.currentHeaders.length === 0) throw new Error(`Headers no encontrados en ${this.resolvedSheetName}`);
        return this.currentHeaders;
    }

    /**
     * Resuelve la coordenada A1 para una propiedad específica y un índice de fila.
     */
    private getCellRange(propKey: string, rowIndex: number): string {
        const config = this.columnDetails[propKey];
        const headerName = config?.name || propKey;
        const colIndex = this.currentHeaders.findIndex(h => h.trim().toLowerCase() === headerName.toLowerCase());

        if (colIndex === -1) throw new Error(`Columna ${headerName} no encontrada.`);

        return `${this.resolvedSheetName}!${this.indexToColumnLetter(colIndex)}${rowIndex + 2}`;
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

    private async executeAutoCascade(parentId: string | number): Promise<void> {
        const dependencies = GLOBAL_RELATION_REGISTRY.get(this.entityClass.name);
        if (!dependencies) return;

        for (const dep of dependencies) {
            try {
                const childRepo = this.moduleRef.get(dep.childRepository, { strict: false });
                if (childRepo?.engine) {
                    await this.deleteChildrenManually(childRepo.engine, dep.joinColumn, parentId);
                }
            } catch (error) {
                this.logger.error(`Error en cascada ${dep.childSheet}: ${error.message}`);
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
                        range: { sheetId, dimension: 'ROWS', startIndex: rowIndex + 1, endIndex: rowIndex + 2 }
                    }
                }]
            }
        });
    }


    /**
     * Actualiza solo la celda de control (Borrado Lógico).
     */
    private async updateLogicalStatus(rowIndex: number, value: string): Promise<void> {
        if (!this.deleteControlProp) return;
        const headers = await this.refreshHeaders();
        const config = this.columnDetails[this.deleteControlProp];
        const headerName = config?.name || this.deleteControlProp;
        const colIndex = headers.findIndex(h => h.trim().toLowerCase() === headerName.toLowerCase());

        if (colIndex === -1) return;

        const range = `${this.indexToColumnLetter(colIndex)}${rowIndex + 2}`;
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
        const allData = await childEngine.gettersEngine.findAllEntities(childEngine.entityClass);
        const children = allData.filter((item: any) => String(item[joinColumn]) === String(parentId));

        for (const child of children) {
            const childPk = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, childEngine.entityClass.prototype) || 'id';
            if (child[childPk]) await childEngine.delete(child[childPk]);
        }
    }

    /**
    * Crea físicamente el registro en Google Sheets y retorna la entidad mapeada con su ubicación.
    * Útil para procesos que requieren manipular la entidad inmediatamente después de crearla.
    */
    async createPhysicalEntity(entity: T): Promise<T> {
        const sheetName = this.resolvedSheetName;

        try {
            // 1. Sincronizamos encabezados para asegurar un mapeo fiel a la realidad de la hoja
            const headers = await this.refreshHeaders();

            // 2. Convertimos el objeto en una fila (Array) usando el Mapper
            // (Asumiendo que mapToRow usa la configuración de columnas precargada)
            const row = SheetMapper.mapToRow(headers, entity, this.columnDetails);

            // 3. Persistencia física mediante Append (agrega al final de la hoja)
            await this.gateway.appendRows(
                this.optionsDatabase.defaultSpreadsheetId,
                `${sheetName}!A1`,
                [row]
            );

            // 4. Invalidamos el caché para que la siguiente lectura refleje el cambio
            await this.clearCache(sheetName);

            // 5. Calculamos el índice de la fila recién creada
            // Obtenemos la data actualizada para saber cuántas filas hay ahora
            const rawData = await this.gettersEngine.getOrFetchSheet(sheetName);

            /**
             * El índice de fila (__row) para el motor es base 0 respecto a los DATOS.
             * En Sheets, la fila física sería: (rawData.length).
             * El índice para findAllEntities sería: (rawData.length - 2).
             */
            const newRowIndex = rawData.length - 2;
            (entity as any).__row = newRowIndex;

            this.logger.log(`[CreatePhysical] ${sheetName}: Nuevo registro en índice de datos ${newRowIndex}`);

            return entity;
        } catch (error) {
            this.logger.error(`Error al crear entidad física en ${sheetName}: ${error.message}`);
            throw new InternalServerErrorException('Error en la persistencia física de Google Sheets.');
        }
    }




}

