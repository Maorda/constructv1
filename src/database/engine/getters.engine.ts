import { OperatorsGettersHandleUtil } from '@database/utils/operators/operators.getters';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';



import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ExpressionEngine } from '@database/engines/expressionEngine';
import { DocumentQuery } from '@database/engines/document.query';
import { CompareEngine } from '@database/engines/compare.engine';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { PersistenceEngine } from './persistence.engine';
import { IGettersEngine } from '@database/interfaces/engine/IGettersEngine';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { ColumnOptions } from '@database/decorators/column.decorator';

import { FilterQuery } from '@database/types/query.types';
import { SheetResponse } from '@database/interfaces/sheet.response';
import { withRetry } from '@database/utils/tools';
import { QueryOptions } from '@database/interfaces/engine/IQueryEngine';
import {
    SHEETS_TABLE_NAME,
    SHEETS_COLUMN_DETAILS,
    SHEETS_COLUMN_LIST,
    SHEETS_PRIMARY_KEY,
    SHEETS_DELETE_CONTROL,
    SHEETS_ALL_RELATIONS,
    SHEETS_RELATIONS_LIST
} from '../constants/metadata.constants'; // Tu nuevo archivo de símbolos
import { RelationOptions } from '@database/decorators/relation.sub.collections.decorator';
import { SheetEntityBinder } from '@database/engines/shereUtilsEngine/SheetEntityBinder';
import { SheetDataTransformer } from '@database/engines/shereUtilsEngine/SheetDataTransformer';
import { SheetsDataGateway } from '@database/gatewayManager/sheetDataGateway';

/*
Su misión principal es la Extracción y Transformación. En términos técnicos, 
cumple cuatro funciones críticas:
Orquestación de la Lectura: Decide si debe pedir datos frescos a Google o si puede confiar 
en el Caché Vivo o en el Caché de Emergencia (la lógica de resiliencia que armamos antes).
Mapeo de Filas a Objetos: Google Sheets devuelve arreglos de arreglos (string[][]). 
El GettersEngine usa los metadatos de tus decoradores @Column para transformar esa "matriz plana" 
en una lista de objetos TypeScript (T[]) con los tipos de datos correctos.
Indexación de Búsqueda: Implementa métodos para encontrar filas específicas rápidamente,
como findById o findRowIndexById, localizando exactamente en qué número de fila de la hoja 
de cálculo vive un registro.
Filtrado Inicial: Puede aplicar filtros básicos (como excluir filas vacías o registros 
marcados como eliminados) antes de entregar la data al repositorio.
*/
// Definimos un TTL largo para emergencias (ej. 24 horas)
const EMERGENCY_TTL = 24 * 60 * 60 * 1000;

@Injectable()
export class GettersEngine<T extends object> implements IGettersEngine<T> {
    private readonly logger = new Logger(GettersEngine.name);
    private readonly resolvedSheetName: string;  // El nombre final de la hoja
    private readonly columnDetailsMap: Record<string, ColumnOptions>;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private readonly relations: string[];
    public readonly deleteControlProp: string | null;

    constructor(
        private readonly entityClass: new () => T,

        private readonly expressionEngine: ExpressionEngine,
        private readonly compareEngine: CompareEngine,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gateway: SheetsDataGateway<T>,
        private readonly binder: SheetEntityBinder,

    ) {
        const prototype = this.entityClass.prototype;
        const constructor = this.entityClass;

        // 🟢 UNIFICACIÓN ABSOLUTA: El Gateway es la fuente de verdad del nombre físico de la pestaña
        this.resolvedSheetName = this.gateway.sheetName;

        // 2. ESTRUCTURA DE COLUMNAS (Desde el prototipo)
        this.columnDetailsMap = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, prototype) || {};

        // 3. IDENTIDAD Y CONTROL (Desde el constructor)
        this.primaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, constructor) || 'id';
        this.deleteControlProp = Reflect.getMetadata(SHEETS_DELETE_CONTROL, constructor) || null;

        // 4. RELACIONES (Lista de nombres de propiedades)
        this.relations = Reflect.getMetadata(SHEETS_RELATIONS_LIST, prototype) || [];

        this.logger.debug(`[${this.resolvedSheetName}] Motor listo. PK: ${this.primaryKeyProp}, Columnas: ${Object.keys(this.columnDetailsMap).length}`);
    }
    /**
     * FIND: El método definitivo que orquesta todo.
     */
    async find(
        filter: FilterQuery<T> = {},
        options: {
            projection?: any,
            sort?: Record<string, 1 | -1>,
            limit?: number,
            skip?: number,
            includeInactive?: boolean
        } = {}
    ): Promise<Partial<T>[]> {

        // 1. OBTENCIÓN Y MAPEO INICIAL
        const all = await this.findAll(true); // Traemos todo (interno) con __row

        // 2. FILTRADO CON TU COMPARE ENGINE (Campos y Lógica $and/$or)
        let results = all.filter(record => this.compareEngine.applyFilter(record, filter));

        // 3. FILTRADO DE SOFT DELETE (Estado ACTIVO/INACTIVO)
        if (!options.includeInactive && this.deleteControlProp) {
            results = results.filter(entity => {
                const status = String((entity as any)[this.deleteControlProp] || '').toUpperCase();
                return status !== 'INACTIVO' && status !== 'ELIMINADO';
            });
        }

        // 4. ORDENAMIENTO (Tu applySort)
        if (options.sort) {
            results = this.compareEngine.applySort(results, options.sort);
        }

        // 5. PAGINACIÓN (Tu applyPagination)
        if (options.limit !== undefined || options.skip !== undefined) {
            results = this.compareEngine.applyPagination(results, options.limit, options.skip);
        }

        // 6. PROYECCIÓN FINAL (Tu applyProjection con ExpressionEngine)
        return results.map(record => this.applyProjection(record, options.projection || {}));
    }
    /**
     * Helper para encontrar el índice de una fila (0-based, sin contar headers) 
     * basándose en el valor de la Primary Key.
     */
    // En GettersEngine.ts

    async findRowIndexById(id: string | number): Promise<number> {
        // Adiós a la lógica de headers, búsqueda de metadatos y bucles for.
        return await this.gateway.findRowIndex(id);
    }

    public processRecord(data: any, record: any): any {
        return this.expressionEngine.execute(data, record);
    }


    async findAllEntities(): Promise<T[]> {

        return await this.gateway.getAllEntities(this.entityClass);
    }


    async findOne(filter: FilterQuery<T> = {}, projection: any = {}): Promise<Partial<T> | null> {
        const results = await this.find(filter, { projection, limit: 1 });
        return results.length > 0 ? results[0] : null;
    }
    /**
 * Método de uso interno para los motores. 
 * SIEMPRE devuelve la entidad completa T para no perder metadatos (__row).
 */

    async findInternal(
        filter: FilterQuery<T>,
        compareEngine: CompareEngine,
        options: QueryOptions = {}
    ): Promise<any[]> {
        // 1. Obtener toda la data
        let records = await this.findAll();
        if (!records || records.length === 0) return [];

        // 2. FILTRADO (Criterio de búsqueda)
        records = records.filter(r => compareEngine.applyFilter(r, filter));

        // 3. SORT (Ordenamiento)
        if (options.sort) {
            records = this.applySort(records, options.sort);
        }

        // 4. OFFSET & LIMIT (Paginación)
        // El orden es importante: primero saltamos (offset), luego cortamos (limit)
        if (options.offset !== undefined || options.limit !== undefined) {
            records = this.applyPagination(records, options.offset, options.limit);
        }

        return records;
    }

    async findAllRaw(): Promise<T[]> {
        // El motor ahora solo hace una petición de negocio: "dame los datos"
        return await this.gateway.getEntitiesWithResilience(this.entityClass);
    }



    /**
 * Busca todos los registros de la hoja.
 * Implementa caché de capa superior (objetos ya mapeados).
 */
    // getters.engine.ts

    async findAll(projection: any = {}, includeInactive: boolean = false): Promise<Partial<T>[]> {
        // 1. Obtención de datos: El Gateway se encarga de la resiliencia, 
        // fetch, parseo, hidratación de entidades y asignación de __row.
        const entities = await this.gateway.getEntitiesWithResilience(this.entityClass);

        // 2. Filtro de Estado (Lógica de negocio/Política de acceso)
        // Esto se queda aquí porque es una política de la aplicación, no de la base de datos.
        let result = entities;
        if (!includeInactive && this.deleteControlProp) {
            result = entities.filter(entity => {
                const status = String((entity as any)[this.deleteControlProp] || '').toUpperCase();
                return status !== 'INACTIVO' && status !== 'ELIMINADO';
            });
        }

        // 3. Proyección (Lógica de presentación)
        // Transformamos las entidades completas al formato solicitado por el usuario.
        return result.map(entity => this.applyProjection(entity, projection));
    }

    /**
 * Único método necesario para limpiar el caché de esta entidad.
 * Se llama automáticamente después de un SAVE o manualmente vía Webhook.
 */
    async clearCache(): Promise<void> {
        // El motor ya no sabe qué es un 'cacheKey' ni qué formato tiene.
        // Solo delega la responsabilidad al Gateway.
        await this.gateway.clearCache();
    }

    /**
 * Busca un registro por su Identificador (PK) usando la data en memoria.
 * Aprovecha el caché global de la hoja y asegura la integridad del puntero físico.
 */
    async findById(rowId: string | number): Promise<T | null> {
        // 1. REUTILIZACIÓN TOTAL
        const entities = await this.findAll();

        if (!entities || entities.length === 0) return null;

        // 2. IDENTIFICACIÓN DINÁMICA DE LA PK
        // Asegúrate de que pkProp obtenga el nombre del campo (ej: 'id')
        const pkProp = this.primaryKeyProp;

        // 3. BÚSQUEDA EN MEMORIA
        const entity = entities.find(
            (item) => String((item as any)[pkProp]) === String(rowId)
        );

        if (!entity) {
            this.logger.debug(`Registro con ID ${rowId} no encontrado.`);
            return null;
        }

        // SOLUCIÓN AL ERROR DE TIPO:
        // Usamos unknown como puente para asegurar a TS que el objeto 
        // cumple con la interfaz de T.
        return entity as unknown as T;
    }

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

    /**
 * Localiza la fila física exacta en Google Sheets para un ID específico.
 * Utilizado por el PersistenceEngine para actualizaciones quirúrgicas (Deltas).
 */
    async getRowIndexById(id: string | number): Promise<number> {
        // 1. Reutilizamos findAll() para garantizar que los datos estén frescos o en caché
        const allRecords = await this.findAll();

        if (allRecords.length === 0) return -1;

        // 2. Buscar el índice en el array de entidades
        // Usamos this.primaryKeyProp inicializado en el constructor
        const recordIndex = allRecords.findIndex(record =>
            String((record as any)[this.primaryKeyProp]) === String(id)
        );

        // 3. Manejo de registro no encontrado
        if (recordIndex === -1) {
            this.logger.warn(`Registro con ID ${id} no localizado en ${this.resolvedSheetName}`);
            return -1; // Retornamos -1 en lugar de lanzar excepción para un manejo más fluido
        }

        /**
         * 4. CÁLCULO DEL ÍNDICE REAL (Google Sheets 1-based + Header)
         * recordIndex (0) -> Fila de datos 1 -> Fila 2 de Sheets
         */
        return recordIndex + 2;
    }

    async populateAll<T extends object>(entity: T): Promise<T> {
        // Usamos 'this.relations' que ya inicializaste en el constructor
        if (!this.relations || this.relations.length === 0) return entity;

        await Promise.all(
            this.relations.map(relName => this.populate(entity, relName as keyof T))
        );

        return entity;
    }

    /**
             * @description: Este metodo es el que se encarga de manejar las operaciones de insercion en hojas relacionadas.
             * @param entity: Entidad padre.
             * @param relationName: Nombre de la relacion.
             * @returns: void
             */
    // En GettersEngine.ts

    async populate<T extends object>(entity: T, relationName: keyof T): Promise<T> {
        const options: RelationOptions = Reflect.getMetadata(
            SHEETS_ALL_RELATIONS,
            this.entityClass.prototype,
            relationName as string
        );

        if (!options) {
            this.logger.warn(`Propiedad "${String(relationName)}" no configurada como relación.`);
            return entity;
        }

        // El motor solo delega la búsqueda de la relación al Gateway
        const localValue = (entity as any)[options.localField];
        const TargetClass = options.targetEntity();

        (entity as any)[relationName] = await this.gateway.getRelatedEntities(
            options,
            localValue,
            TargetClass
        );

        return entity;
    }

    /**
 * Versión optimizada para GettersEngine o un BaseEngine compartido.
 */
    async fetchRows(): Promise<any[][]> {
        // El motor no sabe nada de Keys, TTLs, o Managers.
        // Solo sabe que el Gateway le entregará los datos.
        return await this.gateway.getRawRows(this.resolvedSheetName);
    }

    /**
 * Busca un único registro devolviendo la data "interna" (incluyendo __row).
 * Es la base para la hidratación de Documentos Vivos.
 */
    /**
   * Localiza un registro único inyectándole el motor de comparación.
   */
    async findOneInternal(
        filter: FilterQuery<T>,
        compareEngine: CompareEngine
    ): Promise<any | null> {
        const allRecords = await this.findAll();

        if (!allRecords || allRecords.length === 0) return null;

        // Buscamos el registro que coincida con el filtro
        const record = allRecords.find((r: any) =>
            compareEngine.applyFilter(r, filter)
        );

        return record || null;
    }

    private applySort(records: any[], sort: { field: string; order: 'ASC' | 'DESC' }): any[] {
        const { field, order } = sort;

        return [...records].sort((a, b) => {
            const valA = a[field];
            const valB = b[field];

            if (valA === valB) return 0;

            const comparison = valA > valB ? 1 : -1;
            return order === 'ASC' ? comparison : -comparison;
        });
    }

    private applyPagination(records: any[], offset: number = 0, limit?: number): any[] {
        const start = offset;
        const end = limit ? start + limit : undefined;

        return records.slice(start, end);
    }


}




