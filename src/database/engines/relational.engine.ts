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

@Injectable()
export abstract class RelationalEngine<T extends object> {
    private readonly logger = new Logger(RelationalEngine.name);
    protected abstract readonly EntityClass: new () => T;
    @Inject(CACHE_MANAGER) private cacheManager: Cache
    @Inject('DATABASE_OPTIONS') protected readonly options: DatabaseModuleOptions
    public sheetName: string;
    protected headers: string[] = [];
    private isSynced = false;
    constructor(
        protected readonly persistence: PersistenceEngine, // <--- Única dependencia de datos
        protected readonly googleSheets: GoogleSpreedsheetService
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
        pushData: Record<string, any>,
        arrayFilters: any[] = []
    ): Promise<void> {
        for (const path in pushData) {
            // 1. Resolución de Identificadores: "periodos.$[periodo].panelFotografico"
            const isPositional = path.includes('.$[');
            const relationName = path.split('.')[0];
            let effectiveParentId = (parentEntity as any).id;

            if (isPositional) {
                // Extraemos "periodo" del string $[periodo]
                const identifier = path.match(/\$\[(.*?)]/)?.[1];

                // Buscamos en arrayFilters: { "periodo.id": "ID_DEL_PERIODO" }
                const filterMatch = arrayFilters.find(f => Object.keys(f)[0].startsWith(identifier));

                if (filterMatch) {
                    // El nuevo "padre" para este push es el ID del periodo filtrado
                    effectiveParentId = Object.values(filterMatch)[0];
                }
            }

            // 2. Manejo de $each (Inserción múltiple)
            const rawValue = pushData[path];
            const itemsToPush = rawValue?.$each ? rawValue.$each : (Array.isArray(rawValue) ? rawValue : [rawValue]);

            const options = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype, relationName);
            if (!options) continue;

            const TargetClass = options.targetEntity();

            // 3. Persistencia de los hijos (Panel Fotográfico, etc.)
            await Promise.all(itemsToPush.map(async (item) => {
                const { $push: subPush, ...cleanItem } = item;

                const entityToSave = {
                    ...cleanItem,
                    [getPrimaryKeyColumnName(TargetClass)]: IdGenerator.generate(),
                    [options.joinColumn]: effectiveParentId // Aquí inyectamos la FK correcta
                };

                const savedChild = await this.saveInOtherSheet(options.targetSheet, TargetClass, entityToSave);

                // Recursividad si hay niveles aún más profundos
                if (subPush) {
                    await this.handlePushOperation(savedChild, subPush, arrayFilters);
                }
            }));

            await this.cacheManager.del(`sheet_data:${this.options.defaultSpreadsheetId}:${options.targetSheet}`);
        }
    }

    /**
       * Garantiza que los encabezados estén cargados en memoria.
       * Si ya existen, no hace nada; si no, los trae de la API.
       */
    async ensureSchemaTemporal(): Promise<void> {
        if (this.headers.length > 0) return;

        // Obtenemos solo la primera fila (los encabezados) para ahorrar cuota
        const rows = await this.googleSheets.getValues(this.options.defaultSpreadsheetId, `${this.sheetName}!1:1`);

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
    private async saveInOtherSheet(sheetName: string, TargetClass: any, entity: any): Promise<any> {
        // 1. Obtener encabezados de la pestaña destino (usando caché para no saturar la API)
        const targetHeaders = await this.persistence.getHeaders(sheetName);

        // 2. Convertir la entidad a fila usando el Mapper y los headers destino
        const rowValues = SheetMapper.entityToRow(entity, targetHeaders);

        // 3. Insertar en la pestaña correspondiente
        await this.googleSheets.appendRow(
            this.options.defaultSpreadsheetId,
            `${sheetName}!A:A`,
            rowValues
        );

        // 4. Invalidar el caché de esa pestaña específica
        await this.cacheManager.del(`sheet_data:${this.options.defaultSpreadsheetId}:${sheetName}`);
        return entity; // <--- CRITICO: Retornar el objeto para la recursividad
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
                const response = await this.googleSheets.getValues(this.options.defaultSpreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }
            // Comparamos normalizando
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) => String(currentHeaders[i] || '').trim().toUpperCase() !== h);
            if (isDesync) {
                this.logger.warn(`✍️ Escribiendo cabeceras en "${this.sheetName}"...`);
                // DIAGNÓSTICO 2: Verificamos antes de disparar la API
                console.log(`Enviando a Google -> SpreadsheetId: ${this.options.defaultSpreadsheetId}, Range: ${this.sheetName}!A1`);
                await this.googleSheets.updateRow(
                    this.options.defaultSpreadsheetId,
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