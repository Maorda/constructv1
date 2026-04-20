// relation.manager.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { SheetMapper } from '@database/mappers/sheet.mapper';
import { getPrimaryKeyColumnName } from '@database/decorators/primarykey.decorator';
import { IdGenerator } from '@database/utils/id.generator';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GoogleSpreedsheetService } from '@database/services/google.spreedsheet.service';
import { PersistenceEngine } from './persistence.engine';
import { ManipulateEngine } from './manipulateEngine';
import { CompareEngine } from './compare.engine';

@Injectable()
export abstract class RelationalEngine<T extends object> {
    private readonly logger = new Logger(RelationalEngine.name);

    protected abstract readonly EntityClass: new () => T;
    @Inject(CACHE_MANAGER) private cacheManager: Cache
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    public sheetName: string;
    protected headers: string[] = [];
    private isSynced = false;
    private CompareEngine = new CompareEngine<T>();
    constructor(
        protected readonly persistence: PersistenceEngine, // <--- Única dependencia de datos
        protected readonly googleSheets: GoogleSpreedsheetService,
        protected readonly manipulateEngine: ManipulateEngine,
    ) { }
    async populate(entity: T, relationName: keyof T): Promise<T> {
        await this.ensureSchema();
        const options: RelationOptions = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            this.EntityClass.prototype,
            relationName as string
        );
        if (!options) {
            this.logger.warn(`Propiedad "${String(relationName)}" no es una relación válida.`);
            return entity;
        }
        // USO DEL MÉTODO OPTIMIZADO
        const relRows = await this.persistence.getOrFetchSheet(options.targetSheet);
        if (!relRows || relRows.length <= 1) {
            entity[relationName] = (options.isMany ? [] : null) as any;
            return entity;
        }
        const headers = relRows[0] as string[];
        const joinColIndex = headers.indexOf(options.joinColumn);
        const localValue = entity[options.localField];
        const TargetClass = options.targetEntity();
        if (joinColIndex === -1) {
            this.logger.error(`Columna "${options.joinColumn}" no existe en "${options.targetSheet}"`);
            return entity;
        }
        const dataRows = relRows.slice(1);
        const normalize = (val: any) => String(val).trim();
        if (options.isMany) {
            entity[relationName] = dataRows
                .filter(row => normalize(row[joinColIndex]) === normalize(localValue))
                .map(row => SheetMapper.mapToEntity(headers, row, TargetClass)) as any;
        } else {
            const foundRow = dataRows.find(row => normalize(row[joinColIndex]) === normalize(localValue));
            entity[relationName] = foundRow
                ? SheetMapper.mapToEntity(headers, foundRow, TargetClass) as any
                : null;
        }
        return entity;
    }

    async populateAll(entity: T): Promise<T> {
        const relations: string[] = Reflect.getMetadata(
            'sheets:all_relations',
            this.EntityClass.prototype
        ) || [];

        if (relations.length === 0) return entity;

        // Ejecutamos todos los populate en paralelo
        // Gracias al CacheManager, si dos relaciones piden la misma 'targetSheet'
        // casi al mismo tiempo, la segunda aprovechará el resultado de la primera.
        await Promise.all(
            relations.map(relName => this.populate(entity, relName as keyof T))
        );

        return entity;
    }
    /**
         * MÉTODO DE APOYO: Maneja la lógica de insertar en pestañas relacionadas
         */
    async handlePushOperation(
        parentEntity: T,
        pushQuery: Record<string, any>,
        arrayFilters: any[] = []
    ): Promise<void> {
        const target = Object.getPrototypeOf(parentEntity);

        for (const path in pushQuery) {
            // 1. RESOLUCIÓN DE IDENTIFICADORES Y METADATOS
            const isPositional = path.includes('.$[');
            const relationName = path.split('.')[0];
            let effectiveParentId = (parentEntity as any).id;

            const options = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype, relationName);
            if (!options) continue;

            const TargetClass = options.targetEntity();
            const rawValue = pushQuery[path];

            // 2. MANEJO DE $EACH (Normalización)
            const itemsToPush = (rawValue && typeof rawValue === 'object' && rawValue.$each)
                ? rawValue.$each
                : (Array.isArray(rawValue) ? rawValue : [rawValue]);

            // 3. RESOLUCIÓN DE FK (FILTROS POSICIONALES)
            if (isPositional) {
                const identifier = path.match(/\$\[(.*?)]/)?.[1];
                const filterMatch = arrayFilters.find(f => Object.keys(f)[0].startsWith(identifier));
                if (filterMatch) {
                    effectiveParentId = Object.values(filterMatch)[0];
                }
            }

            // 4. PREPARACIÓN DEL LOTE (BATCH PREPARATION)
            const processedItems: any[] = [];
            const subPushTasks: { savedChild: any, subPush: any }[] = [];

            for (const item of itemsToPush) {
                const { $push: subPush, ...cleanItem } = item;

                // Aplicamos tu potente ManipulateEngine (executePipeline)
                const mutatedItem = this.manipulateEngine.execute(cleanItem, parentEntity);

                const entityToSave = {
                    ...mutatedItem,
                    [getPrimaryKeyColumnName(TargetClass)]: IdGenerator.generate(),
                    [options.joinColumn]: effectiveParentId
                };

                processedItems.push(entityToSave);

                // Si hay niveles más profundos, los guardamos para la fase 6
                if (subPush) {
                    subPushTasks.push({ savedChild: entityToSave, subPush });
                }
            }

            // 5. PERSISTENCIA EN LOTE (Una sola llamada a Google Sheets)
            if (processedItems.length > 0) {
                await this.saveManyInOtherSheet(options.targetSheet, TargetClass, processedItems);
            }

            // 6. RECURSIVIDAD (Procesar nietos si existen)
            if (subPushTasks.length > 0) {
                await Promise.all(subPushTasks.map(task =>
                    this.handlePushOperation(task.savedChild, task.subPush, arrayFilters)
                ));
            }

            // 7. INVALIDACIÓN DE CACHÉ
            await this.cacheManager.del(`sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${options.targetSheet}`);
        }
    }
    async handlePullOperation(parentEntity: T, pullQuery: Record<string, any>): Promise<void> {
        const target = Object.getPrototypeOf(parentEntity);

        for (const path in pullQuery) {
            const relation = Reflect.getMetadata(RELATION_METADATA_KEY, target, path);
            if (!relation) continue;

            const criteria = pullQuery[path];
            // Aseguramos que usamos la PK correcta del padre para el filtro de FK
            const fkValue = (parentEntity as any).id;

            const rawRows = await this.googleSheets.getValues(
                this.optionsDatabase.defaultSpreadsheetId,
                `${relation.targetSheet}!A:Z`
            );

            if (!rawRows || rawRows.length <= 1) continue;

            const headers = rawRows[0];
            const rowsToKeep: any[][] = [headers];
            let deletedCount = 0;

            for (const row of rawRows.slice(1)) {
                // CORRECCIÓN DEL ERROR DE TIPADO:
                // Mapeamos a la clase destino y forzamos el tipo a T (o any) para applyFilter
                const entity = SheetMapper.mapToEntity(headers, row, relation.targetEntity()) as T;

                const matchesFK = (entity as any)[relation.joinColumn] === fkValue;

                // Normalizamos criteria para que siempre sea un objeto
                const normalizedCriteria = (typeof criteria !== 'object' || criteria === null)
                    ? { [(entity as any).id]: criteria }
                    : criteria;

                // Invocación segura
                const matchesCriteria = this.CompareEngine.applyFilter(entity, normalizedCriteria);

                if (matchesFK && matchesCriteria) {
                    deletedCount++;
                } else {
                    rowsToKeep.push(row);
                }
            }

            if (deletedCount > 0) {
                await this.googleSheets.updateSheet(
                    this.optionsDatabase.defaultSpreadsheetId,
                    relation.targetSheet,
                    rowsToKeep
                );

                this.logger.log(`$pull: ${deletedCount} registros eliminados en ${relation.targetSheet}`);
                await this.cacheManager.del(`sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${relation.targetSheet}`);
            }
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
        const targetHeaders = await this.persistence.getHeaders(TargetClass);

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
        await this.googleSheets.appendRows(
            this.optionsDatabase.defaultSpreadsheetId,
            `${sheetName}!A1`,
            rowsValues
        );

        // 6. Retornamos las entidades enriquecidas para mantener la trazabilidad en la recursividad
        return enrichedEntities;
    }

    /**
       * Garantiza que los encabezados estén cargados en memoria.
       * Si ya existen, no hace nada; si no, los trae de la API.
       */
    async ensureSchemaTemporal(): Promise<void> {
        if (this.headers.length > 0) return;

        // Obtenemos solo la primera fila (los encabezados) para ahorrar cuota
        const rows = await this.googleSheets.getValues(this.optionsDatabase.defaultSpreadsheetId, `${this.sheetName}!1:1`);

        if (!rows || rows.length === 0) {
            throw new Error(`No se pudieron encontrar encabezados en la pestaña ${this.sheetName}`);
        }

        this.headers = rows[0] as string[];
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
        await this.syncSchema();
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
        const targetHeaders = await this.persistence.getHeaders(TargetClass);

        // 2. Convertir la entidad a fila (Array plano) respetando el orden de los headers
        // Usamos el Mapper para asegurar que fechas y números se formateen para Google
        const rowValues = SheetMapper.mapToRow(targetHeaders, entity);

        // 3. Insertar usando appendRow (más rápido y predecible que appendObject)
        // El rango suele ser 'NombrePestaña!A1' para que Google busque la siguiente fila libre
        await this.googleSheets.appendObject(
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



    /*
    *Descripcion: Sincroniza el esquema de la hoja de Google Sheets
    * Parametros: 
    *   force: Si es true, fuerza la escritura de las cabeceras
    * Retorna: void
    */
    async syncSchema(force: boolean = false): Promise<void> {
        const expectedHeaders = SheetMapper.getColumnHeaders(this.EntityClass);
        // Definimos cleanExpected: Limpiamos y convertimos a Mayúsculas
        const cleanExpected = expectedHeaders.map(h => String(h || '').trim().toUpperCase());
        // DIAGNÓSTICO 1: ¿Qué estamos intentando escribir?
        this.logger.debug(`[${this.sheetName}] Cabeceras esperadas: ${JSON.stringify(cleanExpected)}`);
        if (cleanExpected.length === 0) {
            this.logger.error(`❌ Error: No se encontraron decoradores @Column en ${this.EntityClass.name}`);
            return;
        }
        try {
            let currentHeaders: any[] = [];
            // Solo leemos si no estamos forzando la creación
            if (!force) {
                const range = `${this.sheetName}!A1:Z1`;
                const response = await this.googleSheets.getValues(this.optionsDatabase.defaultSpreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }
            // Comparamos normalizando
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) => String(currentHeaders[i] || '').trim().toUpperCase() !== h);
            if (isDesync) {
                this.logger.warn(`✍️ Escribiendo cabeceras en "${this.sheetName}"...`);
                // DIAGNÓSTICO 2: Verificamos antes de disparar la API
                console.log(`Enviando a Google -> SpreadsheetId: ${this.optionsDatabase.defaultSpreadsheetId}, Range: ${this.sheetName}!A1`);
                await this.googleSheets.updateRow(
                    this.optionsDatabase.defaultSpreadsheetId,
                    `${this.sheetName}!A1`,
                    [cleanExpected] // Debe ser una matriz: [ ["COL1", "COL2"] ]
                );
                this.logger.log(`✅ ¡Cabeceras enviadas a "${this.sheetName}" con éxito!`);
            } else {
                this.logger.log(`✅ Esquema de "${this.sheetName}" está al día.`);
            }
        } catch (error) {
            // DIAGNÓSTICO 3: Captura de error específico de la API
            this.logger.error(`❌ Error en syncSchema para ${this.sheetName}: ${error.message}`);
            if (error.response?.data) {
                console.error('Detalle de Google:', JSON.stringify(error.response.data, null, 2));
            }
        }
    }



}