import { OperatorsGettersHandleUtil } from '@database/utils/operators/operators.getters';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { BaseEngine } from '../engines/Base.Engine';
import { ClassType, EntityFilterQuery } from '@database/types/query.types';
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ExpressionEngine } from '@database/engines/expressionEngine';
import { DocumentQuery } from '@database/engines/document.query';


@Injectable()
export class GettersEngine extends BaseEngine {
    private readonly logger = new Logger(GettersEngine.name);

    constructor(
        entityClass: ClassType,
        private readonly gateway: SheetsDataGateway, // <--- Inyectar Gateway
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache, //Decidir si la data se saca de memoria o de Google.
        private readonly expressionEngine: ExpressionEngine,
    ) { super(entityClass); }

    async findAllRaw<T>(): Promise<T[]> {
        const sheetName = this.EntityClass.name;
        const rawRows = await this.gateway.getOrFetchSheet(sheetName);

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
    findOne<T extends object>(filter: EntityFilterQuery<T> = {}): DocumentQuery<T> {
        // 1. Usamos el maletín de herramientas (ctx) que ya tiene el servicio base.
        // 2. Pasamos 'this' (el servicio actual) para que DocumentQuery pueda llamar a 
        //    metodos como applyProjection o executePopulate.

        return new DocumentQuery<T>(
            this.EntityClass,
            filter,
            this.ctx, // <--- Aquí ya van googleSheets, queryEngine, manipulateEngine, etc.
            this      // El servicio que implementa IBaseService
        );
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

        const rows = await this.gateway.getOrFetchSheet(sheetName);

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
            return SheetMapper.mapRowToEntity(headers, row, this.EntityClass);
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
        const rows = await this.gateway.getOrFetchSheet(sheetName);
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

        const rows = await this.gateway.getOrFetchSheet(sheetName);

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


}