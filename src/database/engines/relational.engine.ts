// relation.manager.ts
import { Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { GLOBAL_RELATION_REGISTRY, RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { ModuleRef } from '@nestjs/core';
import { BaseEngine } from './Base.Engine';
import { ClassType } from "@database/types/query.types";
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { CompareEngine } from './compare.engine';
import { PersistenceEngine } from '@database/engine/persistence.engine';
import { GettersEngine } from '@database/engine/getters.engine';
import { getColumnLetter } from '@database/utils/tools';
import { BaseServiceInterface } from '@database/interfaces/base.service.interface';
export class RelationalEngine extends BaseEngine {
    private readonly logger = new Logger(RelationalEngine.name);
    @Inject(CACHE_MANAGER) private cacheManager: Cache
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    public sheetName: string;
    protected headers: string[] = [];
    private isSynced = false;
    private _targetEntityName: string;
    constructor(
        entityClass: ClassType,
        private readonly gateway: SheetsDataGateway,
        private readonly compareEngine: CompareEngine,
        private readonly persistenceEngine: PersistenceEngine,
        private readonly gettersEngine: GettersEngine,
        private readonly moduleRef: ModuleRef,
        private readonly relationalEngine: RelationalEngine,

    ) {
        super(entityClass);
    }


    /**
         * MÉTODO DE APOYO: Maneja la lógica de insertar en pestañas relacionadas
         */
    async handlePullOperation<T>(parentEntity: T, pullQuery: Record<string, any>): Promise<void> {
        const target = Object.getPrototypeOf(parentEntity);

        for (const path in pullQuery) {
            const relation = Reflect.getMetadata(RELATION_METADATA_KEY, target, path);
            if (!relation) continue;

            const criteria = pullQuery[path];
            const fkValue = (parentEntity as any).id;

            // Llamamos al servicio para obtener los valores crudos
            const rawRows = await this.gateway.getValues(
                this.optionsDatabase.defaultSpreadsheetId,
                `${relation.targetSheet}!A:Z`
            );

            if (!rawRows || rawRows.length <= 1) continue;

            const headers = rawRows[0];
            const rowsToKeep: any[][] = [headers];
            let deletedCount = 0;

            for (const row of rawRows.slice(1)) {
                const entity = SheetMapper.mapToEntity(headers, row, relation.targetEntity()) as T;
                const matchesFK = (entity as any)[relation.joinColumn] === fkValue;

                const normalizedCriteria = (typeof criteria !== 'object' || criteria === null)
                    ? { [(entity as any).id]: criteria }
                    : criteria;

                const matchesCriteria = this.compareEngine.applyFilter(entity, normalizedCriteria);

                if (matchesFK && matchesCriteria) {
                    deletedCount++;
                } else {
                    rowsToKeep.push(row);
                }
            }

            if (deletedCount > 0) {
                // INYECCIÓN LIMPIA: Usamos el método del servicio sin exponer googleAuthService
                await this.gateway.updateSheet(
                    this.optionsDatabase.defaultSpreadsheetId,
                    relation.targetSheet,
                    rowsToKeep
                );

                this.logger.log(`$pull: ${deletedCount} registros eliminados en ${relation.targetSheet}`);

                // Limpieza de caché delegada o directa
                const cacheKey = `sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${relation.targetSheet}`;
                await this.cacheManager.del(cacheKey);
            }
        }
    }
    /**
* Sobrescribe una hoja completa con un nuevo set de datos.
* Útil para operaciones de reestructuración como $pull o ordenamiento.
*/
    async update(spreadsheetId: string, sheetName: string, rows: any[][]): Promise<void> {
        try {
            // 1. Limpiamos primero la hoja para evitar que queden datos antiguos
            // si el nuevo set de datos tiene menos filas que el anterior.
            // Usamos el método clearRange que definimos anteriormente.
            await this.gateway.clearRange(spreadsheetId, `${sheetName}!A:Z`);

            // 2. Preparamos la actualización masiva
            // Usamos el endpoint update para escribir desde la celda A1
            const range = `${sheetName}!A1`;

            await this.gateway.updateSheet(
                spreadsheetId,
                range,
                rows
            );

            this.logger.log(`Hoja '${sheetName}' actualizada exitosamente con ${rows.length} filas.`);
        } catch (error) {
            this.logger.error(`Error crítico al actualizar la hoja ${sheetName}: ${error.message}`);
            throw new InternalServerErrorException(
                `No se pudo sincronizar la operación de limpieza en Google Sheets.`
            );
        }
    }
    /**
 * Guarda múltiples entidades en una pestaña destino con soporte de auditoría.
 */
    private async saveManyInOtherSheet(
        sheetName: string,
        TargetClass: any,
        entities: any[]
    ): Promise<any[]> {
        // 1. Obtener encabezados de la pestaña destino (estricto por Clase)
        const targetHeaders = await this.persistenceEngine.getHeaders();

        // 2. Preparar la fecha de auditoría (una sola para todo el lote para consistencia)
        const timestamp = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });

        // 3. Enriquecer las entidades con datos de auditoría
        const enrichedEntities = entities.map(entity => {
            return {
                ...entity,
                // Inyectamos campos de auditoría si no vienen ya definidos
                creadoEn: entity.creadoEn || timestamp,
                actualizadoEn: timestamp,
                // Si manejas un contexto de usuario global, podrías inyectarlo aquí:
                // creadoPor: this.contextService.getUserId() || 'SYSTEM'
            };
        });

        // 4. Convertir las entidades enriquecidas a filas planas (Array de Arrays)
        const rowsValues = enrichedEntities.map(entity =>
            SheetMapper.mapToRow(targetHeaders, entity)
        );

        // 5. Inserción masiva optimizada
        await this.gateway.appendRows(
            this.optionsDatabase.defaultSpreadsheetId,
            `${sheetName}!A1`,
            rowsValues
        );

        // 6. Retornamos las entidades enriquecidas para mantener la trazabilidad en la recursividad
        return enrichedEntities;
    }


    /*
    *Descripcion: Asegura que el esquema de la hoja de Google Sheets esté sincronizado
    * Parametros: 
    *   none
    * Retorna: void
    */
    private async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.persistenceEngine.syncSchema();
        this.isSynced = true;
    }
    /**
 * Guarda una entidad en una pestaña diferente a la del repositorio actual.
 * Ideal para operaciones de $push (relaciones).
 */
    /**
 * Guarda una entidad en una pestaña diferente a la del repositorio actual.
 */
    private async saveInOtherSheet(sheetName: string, TargetClass: any, entity: any): Promise<any> {
        // 1. Obtener encabezados de forma estricta usando la Clase Destino
        // Esto resuelve el error ts(2345)
        const targetHeaders = await this.persistenceEngine.getHeaders();

        // 2. Convertir la entidad a fila (Array plano) respetando el orden de los headers
        // Usamos el Mapper para asegurar que fechas y números se formateen para Google
        const rowValues = SheetMapper.mapToRow(targetHeaders, entity);

        // 3. Insertar usando appendRow (más rápido y predecible que appendObject)
        // El rango suele ser 'NombrePestaña!A1' para que Google busque la siguiente fila libre
        await this.gateway.appendRows(
            this.optionsDatabase.defaultSpreadsheetId,
            `${sheetName}!A1`,
            rowValues
        );

        // 4. Invalidar el caché
        // Asegúrate de que esta clave coincida con la de tu findAll()
        const cacheKey = `sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${sheetName}`;
        await this.cacheManager.del(cacheKey);

        return entity;
    }


    /**
     * MI PROPUESTA (Conectada con tu script)
     * Se encarga de la lógica de negocio relacional.
     */
    async fetchRelation(parentId: string, relation: any): Promise<any> {
        // 1. Usamos tu lógica de caché para obtener las filas
        const rawRows = await this.gettersEngine.getOrFetchSheet(relation.targetSheet);
        if (!rawRows || rawRows.length === 0) return relation.type === 'one-to-many' ? [] : null;

        // 2. Extraemos cabeceras y mapeamos a objetos
        const headers = rawRows[0];
        const dataRows = rawRows.slice(1);

        const mappedRecords = dataRows.map(row => {
            const obj: any = {};
            headers.forEach((header, index) => {
                obj[header] = row[index];
            });
            return obj;
        });

        // 3. Filtramos por la Foreign Key (FK)
        const results = mappedRecords.filter(record =>
            String(record[relation.joinColumn]) === String(parentId)
        );

        return relation.type === 'one-to-many' ? results : (results[0] || null);
    }


    /**
 * Localiza un registro, su posición física y convierte los datos
 * soportando: string, number, boolean, date y currency.
 */
    protected async findRawWithIndex<T>(id: string): Promise<{ record: T | null; rowIndex: number }> {
        const sheetName = this.EntityClass.name;
        const rawRows = await this.gettersEngine.getOrFetchSheet(sheetName);

        if (!rawRows || rawRows.length === 0) return { record: null, rowIndex: -1 };

        const headers = rawRows[0];
        const dataRows = rawRows.slice(1);
        const idColIndex = headers.indexOf('id');

        if (idColIndex === -1) throw new Error(`Columna 'id' no encontrada en ${sheetName}`);

        const dataIndex = dataRows.findIndex(row => String(row[idColIndex]) === String(id));
        if (dataIndex === -1) return { record: null, rowIndex: -1 };

        const rawRecord = dataRows[dataIndex];
        const record = new this.EntityClass();

        headers.forEach((header, i) => {
            const rawValue = rawRecord[i];

            // Obtenemos el tipo definido en tu decorador personalizado (ej: @Column({ type: 'currency' }))
            // Si no existe, intentamos obtener el tipo de diseño de TS
            const customType = Reflect.getMetadata('column:type', this.EntityClass.prototype, header);
            const designType = Reflect.getMetadata('design:type', this.EntityClass.prototype, header);

            if (rawValue === undefined || rawValue === null || rawValue === '') {
                (record as any)[header] = null;
                return;
            }

            // Lógica de conversión según tu lista de tipos
            switch (customType || designType) {
                case 'number':
                case Number:
                    (record as any)[header] = Number(rawValue);
                    break;

                case 'currency':
                    // Limpiamos símbolos (S/, $, ,) para asegurar que sea un número operable
                    const cleanValue = String(rawValue).replace(/[S/$,\s]/g, '');
                    (record as any)[header] = parseFloat(cleanValue) || 0;
                    break;

                case 'date':
                case Date:
                    (record as any)[header] = new Date(rawValue);
                    break;

                case 'boolean':
                case Boolean:
                    const val = String(rawValue).toLowerCase();
                    (record as any)[header] = val === 'true' || val === '1' || val === 'si';
                    break;

                case 'string':
                case String:
                default:
                    (record as any)[header] = String(rawValue);
                    break;
            }
        });

        return {
            record,
            rowIndex: dataIndex + 2
        };
    }


    async updateRow<T>(id: string, updatedData: Partial<T>): Promise<T> {
        const sheetName = this.EntityClass.name;

        // 1. OBTENER ESTADO ACTUAL (Usamos el caché de getOrFetchSheet para ser veloces)
        // Buscamos la fila y su índice real en la hoja
        const { record: originalRecord, rowIndex } = await this.findRawWithIndex(id);

        if (!originalRecord) throw new NotFoundException(`Registro con ID ${id} no encontrado en ${sheetName}`);

        // 2. PROCESAR CAMBIOS (ManipulateEngine)
        // Aquí es donde procesamos operadores como $set, $inc o transformaciones de moneda
        const finalEntity = Object.assign(new this.EntityClass(), originalRecord, updatedData);

        // 3. CALCULAR DELTA (Optimización de celdas)
        const headers = await this.persistenceEngine.getHeaders();
        const delta = SheetMapper.getDeltaUpdate(headers, originalRecord, finalEntity);

        if (delta.length > 0) {
            // 4. ACTUALIZACIÓN EN BATCH
            const batchUpdates = delta.map(change => ({
                range: `${sheetName}!${getColumnLetter(change.colIndex)}${rowIndex}`,
                value: change.value
            }));

            await this.persistenceEngine.updateCellsBatch(
                this.optionsDatabase.defaultSpreadsheetId,
                batchUpdates
            );

            // 5. SINCRONIZACIÓN RELACIONAL (RelationalEngine)
            // Si el ID cambió (poco común pero posible), el RelationalEngine debe 
            // actualizar las Foreign Keys en otras hojas (Cascading Update).
            if (updatedData['id' as keyof T] && updatedData['id' as keyof T] !== id) {
                // IMPORTANTE: Enviamos el nombre de la clase para que el motor busque en el registro global
                await this.handleCascadeUpdate(
                    this.EntityClass.name,
                    id,
                    String(updatedData['id' as keyof T])
                );
            }
        }
        // 6. LIMPIEZA DE CACHÉ
        await this.cacheManager.del(`row:${sheetName}:${id}`);
        await this.cacheManager.del(`sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${sheetName}`);
        return finalEntity;
    }



    // src/database/engines/relational.engine.ts

    /**
     * Actualiza todas las llaves foráneas en hojas relacionadas cuando un ID principal cambia.
     * @param oldId El ID original (ej: DNI anterior)
     * @param newId El nuevo ID (ej: DNI corregido)
     */

    // src/database/engines/relational.engine.ts

    async handleCascadeUpdate(entityName: string, oldId: string, newId: string): Promise<void> {
        // Buscamos en el mapa global usando el nombre que recibimos
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];

        this.logger.log(`Iniciando cascada para ${entityName}: ${oldId} -> ${newId}`);

        for (const dep of dependencies) {
            const childService = this.moduleRef.get(dep.childService, { strict: false });

            // Buscamos registros que dependen del ID viejo
            const relatedRecords = await childService.findAll();
            const affected = relatedRecords.filter(r => String(r[dep.joinColumn]) === String(oldId));

            if (affected.length > 0) {
                // Actualizamos solo la FK en los hijos
                for (const record of affected) {
                    await childService.updateRow(record.id, { [dep.joinColumn]: newId });
                }
            }
        }
    }


    /**
    * Resuelve relaciones, incluyendo rutas anidadas (ej: 'asistencias.local')
    */
    public async executePopulate(record: any, path: string): Promise<any> {
        if (!record) return record;

        const [currentPath, ...rest] = path.split('.');
        const remainingPath = rest.join('.');

        // Usamos los metadatos de la entidad
        const relation = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype, currentPath);
        if (!relation) return record;

        // Delegamos la búsqueda física al motor relacional (unidireccionalidad)
        let relatedData = await this.relationalEngine.fetchRelation(record.id, relation);

        if (remainingPath && relatedData) {
            // Obtenemos el servicio hermano desde el moduleRef (que está en el ctx)
            const targetService = this.moduleRef.get<BaseServiceInterface<any>>(relation.targetService);

            if (Array.isArray(relatedData)) {
                relatedData = await Promise.all(
                    relatedData.map(item => targetService.executePopulate(item, remainingPath))
                );
            } else {
                relatedData = await targetService.executePopulate(relatedData, remainingPath);
            }
        }

        return { ...record, [currentPath]: relatedData };
    }

    /**
     * Resuelve las relaciones solicitadas (populate) para una entidad o lista de entidades.
     */
    async resolve<T>(entityClass: new () => T, data: any | any[], path: string): Promise<any> {
        if (!data) return data;

        // Si es un array de resultados, procesamos cada uno
        if (Array.isArray(data)) {
            return await Promise.all(data.map(item => this.resolve(entityClass, item, path)));
        }

        const ctx = this.getContext();
        const parts = path.split('.'); // Soporte para 'supervisores.cuadrillas'
        const currentField = parts[0];
        const remainingPath = parts.slice(1).join('.');

        // 1. Obtener la configuración de la relación desde la metadata de la propiedad
        const options: RelationOptions = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            entityClass.prototype,
            currentField
        );

        if (!options) return data;

        // 2. Ejecutar la búsqueda del/los hijo(s)
        const TargetClass = options.targetEntity();
        const localValue = data[options.localField];

        if (!localValue) return data;

        let relatedResult: any;

        if (options.isMany) {
            // Caso: Una Obra tiene MUCHOS Supervisores
            // Buscamos en la pestaña destino donde la joinColumn coincida con nuestro ID
            const allItems = await ctx.gettersEngine.findAll(TargetClass);
            relatedResult = allItems.filter(item => item[options.joinColumn] === localValue);
        } else {
            // Caso: Un Supervisor tiene UNA Obra
            relatedResult = await ctx.gettersEngine.findOneById(TargetClass, localValue);
        }

        // 3. Convertir resultados en "Documentos Vivos" (SheetDocument)
        if (relatedResult) {
            if (Array.isArray(relatedResult)) {
                relatedResult = relatedResult.map(item => {
                    const doc = ctx.mapper.mapRowToEntity(item, TargetClass);
                    doc.setContext(ctx);
                    return doc;
                });
            } else {
                const doc = ctx.mapper.mapRowToEntity(relatedResult, TargetClass);
                doc.setContext(ctx);
                relatedResult = doc;
            }
        }

        // 4. RECURSIVIDAD: Si hay más niveles (ej. .cuadrillas), seguimos bajando
        if (remainingPath && relatedResult) {
            relatedResult = await this.resolve(TargetClass, relatedResult, remainingPath);
        }

        // Asignamos el resultado al objeto original
        data[currentField] = relatedResult;
        return data;
    }
}


}