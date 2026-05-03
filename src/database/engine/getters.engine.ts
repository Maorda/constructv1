import { OperatorsGettersHandleUtil } from '@database/utils/operators/operators.getters';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { BaseEngine } from '../engines/Base.Engine';
import { ClassType, EntityFilterQuery } from '@database/types/query.types';
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ExpressionEngine } from '@database/engines/expressionEngine';
import { DocumentQuery } from '@database/engines/document.query';
import { CompareEngine } from '@database/engines/compare.engine';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { RELATION_METADATA_KEY, RelationOptions } from '@database/decorators/relation.decorator';
import { PersistenceEngine } from './persistence.engine';
import { IGettersEngine } from '@database/interfaces/engine/IGettersEngine';


@Injectable()
export class GettersEngine implements IGettersEngine {
    private readonly logger = new Logger(GettersEngine.name);

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache, //Decidir si la data se saca de memoria o de Google.
        private readonly expressionEngine: ExpressionEngine,
        private readonly compareEngine: CompareEngine,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gateway: SheetsDataGateway,
        private readonly persistenceEngine: PersistenceEngine,


    ) { }

    async findAllRaw<T>(): Promise<T[]> {
        const sheetName = this.EntityClass.name;
        const rawRows = await this.getOrFetchSheet(sheetName);

        if (!rawRows || rawRows.length <= 1) return [];

        const headers = rawRows[0];
        const dataRows = rawRows.slice(1);

        // Usamos el mapRowToEntity con los 3 parámetros que especificaste
        return dataRows.map(row =>
            SheetMapper.mapRowToEntity(headers, row, this.EntityClass)
        );
    }
    /**
        * Busca un único documento. 
        * Retorna un DocumentQuery para permitir .select() y .populate()
        */
    /**
     * Busca un único documento basado en un filtro.
     * @param filter Criterios de búsqueda (ej: { dni: '12345' })
     * @returns Una instancia de DocumentQuery para encadenar .select() o .populate()
     */

    // getters.engine.ts

    async findOne<T>(filter: EntityFilterQuery<T>): Promise<T | null> {
        // 1. Obtener todos los registros (usando caché si existe)
        const allRecords = await this.findAll(this.EntityClass);

        // 2. Usar el CompareEngine para encontrar el que coincida
        const record = allRecords.find(r => this.compareEngine.applyFilter(r, filter));

        return record || null;
    }
    /**
        * MÉTODO DE TU SCRIPT (Optimizado)
        * Se encarga de la comunicación técnica y el caché de la API.
        */
    /**
   * Obtiene los datos de una hoja con lógica de caché para optimizar el rendimiento.
   */
    public async getOrFetchSheet(sheetName: string): Promise<any[][] | null> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const cacheKey = `sheet_data:${spreadsheetId}:${sheetName}`;

        // 1. Intentar obtener del caché
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) return cachedData;

        // 2. Si no hay caché, pedir a Google Sheets
        // Usamos un rango amplio A:Z o ajustado dinámicamente
        const freshData = await this.gateway.getValues(spreadsheetId, `${sheetName}!A:Z`);

        if (freshData && freshData.length > 0) {
            // 3. Guardar en caché (ejemplo: 10 segundos para alta concurrencia)
            await this.cacheManager.set(cacheKey, freshData, 10000);
        }

        return freshData;
    }

    /**
 * Busca todos los registros de la hoja.
 * Implementa caché de capa superior (objetos ya mapeados).
 */
    async findAll<T extends object>(entityClass: new () => T): Promise<T[]> {
        // 2. El nombre de la hoja ahora viene de la clase que pasamos
        const sheetName = entityClass.name;
        const cacheKey = `list:${sheetName}`;

        // Intentar obtener de caché
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        const rows = await this.getOrFetchSheet(sheetName);

        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapeo con aserción de tipo
        const entities = dataRows.map(row => {
            // mapRowToEntity debe devolver T. 
            // Usamos "as T" para asegurar a TS que el objeto cumple con la interfaz de la entidad
            return SheetMapper.mapRowToEntity(headers, row, entityClass) as T;
        });

        await this.cacheManager.set(cacheKey, entities);

        return dataRows.map(row => {
            // Pasamos entityClass en cada iteración
            return SheetMapper.mapRowToEntity(headers, row, entityClass);
        });
    }

    /**
         * WEBHOOK: Método para invalidar cache desde el controlador
         */
    async invalidateCache(sheetName: string, rowId?: string) {
        if (rowId) {
            await this.cacheManager.del(`row:${sheetName}:${rowId}`);
        }
        await this.cacheManager.del(`list:${sheetName}`);
        this.logger.log(`Cache limpiado para: ${sheetName}`);
    }
    async validateCache<T extends object>(sheetName: string, rowId: string) {
        const cached = await this.cacheManager.get(`row:${sheetName}:${rowId}`);
        if (cached) return cached;
        const rows = await this.getOrFetchSheet(sheetName);
        if (!rows || rows.length <= 1) return [];
        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);
        const entity = dataRows.map(row => {
            return SheetMapper.mapRowToEntity(headers, row, this.EntityClass) as T;
        });
        await this.cacheManager.set(`row:${sheetName}:${rowId}`, entity);
        return entity;
    }


    async findOneBy<T extends object>(sheetName: string, rowId: string) {
        const cacheKey = `row:${sheetName}:${rowId}`;

        // Intentar obtener de caché
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        const rows = await this.getOrFetchSheet(sheetName);

        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapeo con aserción de tipo
        const entities = dataRows.map(row => {
            // mapRowToEntity debe devolver T. 
            // Usamos "as T" para asegurar a TS que el objeto cumple con la interfaz de la entidad
            return SheetMapper.mapRowToEntity(headers, row, this.EntityClass) as T;
        });

        await this.cacheManager.set(cacheKey, entities);

        return dataRows.map(row => {
            // Pasamos entityClass en cada iteración
            return SheetMapper.mapRowToEntity(headers, row, this.EntityClass);
        });
    }





    /**
     * Procesa un objeto buscando operadores de extracción (getters).
     * @param data El DTO o fragmento de datos a procesar.
     * @param record El registro fuente (la fila de la base de datos o Sheets).
     */
    public execute(data: any, record: any): any {
        if (!data || typeof data !== 'object') return data;
        if (Array.isArray(data)) return data.map(item => this.execute(item, record));

        const result = { ...data };

        for (const key in result) {
            const value = result[key];

            // Verificamos si el valor es un objeto operador (ej: { $year: ... })
            if (this.isOperatorObject(value)) {
                const operatorKey = Object.keys(value)[0]; // "$year"
                const pureKey = operatorKey.substring(1);  // "year"

                if (OperatorsGettersHandleUtil.getters.hasOwnProperty(pureKey)) {
                    // 1. Resolvemos el valor ($fecha -> valor de la columna)
                    const resolvedValue = this.resolveValue(value[operatorKey], record);

                    // 2. Ejecutamos el getter de la utilidad y asignamos
                    result[key] = OperatorsGettersHandleUtil.getters[pureKey](resolvedValue);
                    continue;
                }
            }

            // Si es un objeto normal, recursión
            if (value && typeof value === 'object') {
                result[key] = this.execute(value, record);
            }
        }

        return result;
    }

    private isOperatorObject(obj: any): boolean {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const keys = Object.keys(obj);
        return keys.length === 1 && keys[0].startsWith('$');
    }

    private resolveValue(val: any, record: any): any {
        if (typeof val === 'string' && val.startsWith('$')) {
            const fieldName = val.substring(1);
            return record && record.hasOwnProperty(fieldName) ? record[fieldName] : null;
        }
        return val;
    }

    /**
* Lógica interna para "podar" los campos del objeto según la Projection.
* Se define como protected para que DocumentQuery (que tiene acceso al service)
* pueda invocarlo durante la resolución de la consulta.
*/
    public applyProjection<T extends object>(record: T, projection: any): Partial<T> {
        const projectionKeys = Object.keys(projection);
        if (projectionKeys.length === 0) return record;

        const projectedRecord: any = {};

        // Identificamos si es un esquema de inclusión (si hay algún 1 o true)
        const isInclusion = projectionKeys.some(
            key => projection[key] === 1 || projection[key] === true
        );

        if (isInclusion) {
            projectionKeys.forEach((key) => {
                const val = projection[key];

                // Si es 1 o true, copiamos el valor original
                if (val === 1 || val === true) {
                    projectedRecord[key] = (record as any)[key];
                }
                // NUEVO: Si es una expresión (objeto o $), usamos el ExpressionEngine
                else if (typeof val === 'object' || (typeof val === 'string' && val.startsWith('$'))) {
                    projectedRecord[key] = this.expressionEngine.evaluate(val, record);
                }
            });

            // Mantenemos tu lógica de seguridad para el ID
            if (projection['id'] !== 0 && (record as any).id) {
                projectedRecord.id = (record as any).id;
            }
        } else {
            // Lógica de Exclusión
            Object.keys(record as object).forEach((key) => {
                if (projection[key] !== 0 && projection[key] !== false) {
                    projectedRecord[key] = (record as any)[key];
                }
            });

            // También permitimos agregar campos calculados aunque sea exclusión
            projectionKeys.forEach(key => {
                if (typeof projection[key] === 'object') {
                    projectedRecord[key] = this.expressionEngine.evaluate(projection[key], record);
                }
            });
        }

        return projectedRecord;
    }

    async getRowIndexById<T>(entityClass: new () => T, id: string | number): Promise<number> {
        const entityName = entityClass.name;

        // 1. Obtener toda la data de la pestaña (vía caché o Google)
        // Usamos el método findAll que ya tenemos para aprovechar la caché global
        const allRecords = await this.findAll(this.EntityClass);

        // 2. Buscar el registro que coincida con el ID
        // Buscamos el índice en el array (0-based)
        const recordIndex = allRecords.findIndex(record => String(record.id) === String(id));

        if (recordIndex === -1) {
            throw new Error(`No se encontró el registro con ID ${id} en la tabla ${entityName}`);
        }

        /**
         * 3. CALCULAR EL ROW INDEX REAL DE GOOGLE SHEETS
         * +1 porque los arrays de JS empiezan en 0 y Google Sheets en 1.
         * +1 porque la fila 1 de Google Sheets suele ser la de encabezados.
         * Resultado: recordIndex + 2
         */
        const googleSheetsRowIndex = recordIndex + 2;

        return googleSheetsRowIndex;
    }

    async populateAll<T>(entity: T): Promise<T> {
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
             * @description: Este metodo es el que se encarga de manejar las operaciones de insercion en hojas relacionadas.
             * @param entity: Entidad padre.
             * @param relationName: Nombre de la relacion.
             * @returns: void
             */
    async populate<T>(entity: T, relationName: keyof T): Promise<T> {
        await this.persistenceEngine.ensureSchema();
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
        const relRows = await this.getOrFetchSheet(options.targetSheet);
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




}