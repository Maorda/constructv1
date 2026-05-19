import { OperatorsGettersHandleUtil } from '@database/utils/operators/operators.getters';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';


import { SheetsDataGateway } from '@database/services/sheetDataGateway';
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
        private readonly entityClass: new () => T, // Garantiza compatibilidad total con el Mapper
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache, //Decidir si la data se saca de memoria o de Google.
        private readonly expressionEngine: ExpressionEngine,
        private readonly compareEngine: CompareEngine,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gateway: SheetsDataGateway<T>,

        private readonly mapper: SheetMapper<T>,
    ) {
        const prototype = this.entityClass.prototype;
        const constructor = this.entityClass;

        // 1. RESOLVER NOMBRE DE LA HOJA (Prioridad: @Table > Lógica automática)
        this.resolvedSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, constructor) ||
            this.entityClass.name.replace(/(Entity|Model|Repository)$/, '').toUpperCase();

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
    async findRowIndexById(id: string | number): Promise<number> {
        const response = await this.getOrFetchSheet();
        if (!response.data || response.data.length <= 1) return -1;

        const rawData = response.data;
        // Accedemos al mapa centralizado de detalles para obtener el nombre real de la cabecera
        const pkConfig = this.columnDetailsMap[this.primaryKeyProp];
        const pkHeaderName = pkConfig?.name || this.primaryKeyProp;

        const headers = rawData[0];
        const pkColIndex = headers.findIndex(
            h => h?.toString().trim().toLowerCase() === pkHeaderName.toLowerCase()
        );

        if (pkColIndex === -1) return -1;

        for (let i = 1; i < rawData.length; i++) {
            if (rawData[i][pkColIndex]?.toString() === id?.toString()) {
                return i + 1; // Retornamos el índice físico de Google Sheets (base 1)
            }
        }
        return -1;
    }

    /**
     * Obtiene todos los registros de una hoja y los transforma en entidades.
     * @param entityClass La clase de la entidad (ej. Obrero)
     * @returns Array de instancias de la entidad T
     */
    /**
     * Obtiene todas las entidades mapeadas sin necesidad de pasar la clase.
     */
    /**
     * Obtiene y mapea todas las filas a entidades.
     * Sincronizado con SheetMapper.mapFromRow(headers, row, EntityClass)
     */
    async findAllEntities(): Promise<T[]> {
        // 1. Obtener la respuesta de la caché o de la API
        const response = await this.getOrFetchSheet();

        // 2. Validación de datos crudos
        if (!response.data || response.data.length <= 1) {
            return [];
        }

        const rawRows = response.data;
        const headers = rawRows[0]; // La primera fila siempre son las cabeceras
        const dataRows = rawRows.slice(1); // El resto son los datos de los trabajadores/obras

        /**
         * REFACTORIZACIÓN:
         * Ahora usamos la instancia de 'this.mapper' que ya tiene inyectada 
         * la entidad y el gateway. Ya no necesitamos pasar 'this.entityClass' 
         * ni 'this.columnDetails' porque el mapper ya los conoce.
         */
        return dataRows.map((row, index) => {
            // Cálculo de la fila física en Google Sheets:
            // index 0 de dataRows + 2 (1 del header + 1 por ser base 1) = Fila 2
            const physicalRowIndex = index + 2;

            const entity = this.mapper.mapRowToEntity(
                headers,
                row,
                physicalRowIndex
            );

            /**
             * NOTA: El método mapRowToEntity que refactorizamos antes ya 
             * inyecta internamente (entity as any).__row = physicalRowIndex.
             * Así que esta parte queda cubierta automáticamente por el mapper.
             */

            return entity;
        });
    }

    async findAllRaw(): Promise<T[]> {
        // 1. Desestructuramos la respuesta del motor de resiliencia
        const { data, isEmergency } = await this.getOrFetchSheet();

        // 2. Validación de integridad
        if (!data || data.length <= 1) {
            return [];
        }

        // 3. Separación de metadatos de la hoja
        const headers = data[0];
        const dataRows = data.slice(1);

        if (isEmergency) {
            this.logger.warn(`[GettersEngine] Sirviendo datos crudos desde el caché de emergencia para ${this.resolvedSheetName}`);
        }

        // 4. Mapeo con corrección de punteros
        return dataRows.map((row, index) => {
            /**
             * Calculamos el número de fila física (base 1):
             * index 0 de dataRows es la fila 2 de Sheets (Fila 1 = Headers)
             */
            const sheetRowIndex = index + 2;

            return this.mapper.mapRowToEntity(
                headers,
                row,
                sheetRowIndex
            );
        });
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



    /**
     * FIND ONE: Reutiliza find pero limita a 1
     */
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
    /**
        * MÉTODO DE TU SCRIPT (Optimizado)
        * Se encarga de la comunicación técnica y el caché de la API.
        */
    /**
   * Obtiene los datos de una hoja con lógica de caché para optimizar el rendimiento.
   */
    public async getOrFetchSheet(): Promise<SheetResponse> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const cacheKey = `sheet_data:${spreadsheetId}:${this.resolvedSheetName}`;
        const emergencyKey = `emergency_data:${spreadsheetId}:${this.resolvedSheetName}`;

        // 1. Intentar obtener del caché normal (Capa de Velocidad)
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) {
            return { data: cachedData, isEmergency: false };
        }

        try {
            // 2. Consulta a Google Sheets con Reintentos (Resiliencia de Red)
            const freshData = await withRetry(async () => {
                return await this.gateway.getAllRows(this.resolvedSheetName);
            }, 3, 1000);

            // 3. Si Google responde pero la hoja está vacía
            if (!freshData || freshData.length === 0) {
                await this.cacheManager.set(cacheKey, [], 5000);
                return { data: null, isEmergency: false };
            }

            // 4. Persistencia Exitosa (Normal y Emergencia)
            await this.cacheManager.set(cacheKey, freshData, 10000); // 10s TTL
            await this.cacheManager.set(emergencyKey, freshData, 24 * 60 * 60 * 1000); // 24h TTL

            return { data: freshData, isEmergency: false };

        } catch (error) {
            // --- 5. CAPA DE EMERGENCIA (CIRCUIT BREAKER) ---
            this.logger.error(`Falló la conexión con Google para ${this.resolvedSheetName}. Buscando respaldo...`);

            const emergencyData = await this.cacheManager.get<any[][]>(emergencyKey);

            if (emergencyData) {
                this.logger.warn(`Operando en modo offline para la hoja: ${this.resolvedSheetName}`);
                return {
                    data: emergencyData,
                    isEmergency: true // <--- Aquí avisamos al sistema que la data es antigua
                };
            }

            // Si no hay absolutamente nada, lanzamos el error
            throw new InternalServerErrorException('No hay conexión con Google Sheets ni datos de respaldo.');
        }
    }

    /**
 * Busca todos los registros de la hoja.
 * Implementa caché de capa superior (objetos ya mapeados).
 */
    // getters.engine.ts

    async findAll(projection: any = {}, includeInactive: boolean = false): Promise<Partial<T>[]> {
        // 1. Obtener datos crudos
        const rawData = await this.fetchRows();
        if (!rawData || rawData.length <= 1) return [];

        const headers = rawData[0];
        const rows = rawData.slice(1);

        // 2. Mapeo completo inicial (Necesario para tener los datos que evaluará el expressionEngine)
        const entities = rows.map((row, index) => {
            return this.mapper.mapRowToEntity(
                headers,
                row,
                index + 2,
            );
        });

        // 3. Filtro de Estado (Soft Delete)
        // Lo hacemos ANTES de la proyección para asegurar que deleteControlProp exista
        let filteredEntities = entities;
        if (!includeInactive && this.deleteControlProp) {
            filteredEntities = entities.filter(entity => {
                const status = String((entity as any)[this.deleteControlProp] || '').toUpperCase();
                return status !== 'INACTIVO' && status !== 'ELIMINADO';
            });
        }

        // 4. Aplicar TU proyección (Tu script refactorizado)
        // Si la proyección está vacía, devuelve el record completo
        return filteredEntities.map(entity =>
            this.applyProjection(entity, projection)
        );
    }

    /**
 * Único método necesario para limpiar el caché de esta entidad.
 * Se llama automáticamente después de un SAVE o manualmente vía Webhook.
 */
    async clearCache() {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const cacheKey = `sheet_data:${spreadsheetId}:${this.resolvedSheetName}`;

        await this.cacheManager.del(cacheKey);
        this.logger.log(`Caché invalidado para la hoja: ${this.resolvedSheetName}`);
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
    async populate<T extends object>(entity: T, relationName: keyof T): Promise<T> {
        // Usamos el nuevo Symbol SHEETS_RELATIONS
        const options: RelationOptions = Reflect.getMetadata(
            SHEETS_ALL_RELATIONS,
            this.entityClass.prototype,
            relationName as string
        );

        if (!options) {
            this.logger.warn(`Propiedad "${String(relationName)}" no configurada como relación.`);
            return entity;
        }

        // 1. Obtenemos los datos crudos de la hoja destino
        const rawRelData = await this.gateway.getAllRows(options.targetSheet) as any[][];

        if (!rawRelData || rawRelData.length <= 1) {
            (entity as any)[relationName] = options.isMany ? [] : null;
            return entity;
        }

        const headers = rawRelData[0] as string[];
        const dataRows = rawRelData.slice(1);

        // 2. Localizar columna de unión (JoinColumn)
        const joinColIndex = headers.findIndex(h =>
            h?.toString().trim().toLowerCase() === options.joinColumn.toLowerCase()
        );

        if (joinColIndex === -1) {
            this.logger.error(`JoinColumn "${options.joinColumn}" no existe en la hoja "${options.targetSheet}"`);
            return entity;
        }

        // 3. Preparación para el mapeo dinámico
        const localValue = (entity as any)[options.localField];
        const TargetClass = options.targetEntity();
        const normalize = (val: any) => String(val ?? '').trim();

        /**
         * CRÍTICO: No podemos usar 'this.mapper' porque es el mapper de la entidad principal.
         * Usamos una versión estática o instanciamos uno temporal para la TargetClass.
         * En este caso, adaptamos la llamada al método que refactorizamos.
         */
        const mapToTargetEntity = (row: any, physicalIndex: number) => {
            // 1. Instanciamos la clase destino (ej: AsistenciaEntity)
            const instance = new TargetClass();
            const targetProto = TargetClass.prototype;
            const constructor = TargetClass;
            const tz = process.env.TIMEZONE || 'America/Lima';

            // Inyectamos el puntero físico de Google Sheets
            (instance as any).__row = physicalIndex;

            /**
             * CAMBIO CLAVE:
             * No iteramos sobre una lista suelta, usamos el mapa de detalles 
             * centralizado que definimos en el decorador @Column.
             */
            const columnsDetails: Record<string, ColumnOptions> =
                Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) || {};

            // Iteramos sobre las propiedades configuradas en la entidad destino
            Object.keys(columnsDetails).forEach(propKey => {
                const colOptions = columnsDetails[propKey];

                // El nombre real en la hoja de Google (ej: 'DNI' en lugar de 'dni')
                const colName = colOptions?.name || propKey;

                // Localizamos la posición física en el array de cabeceras
                const colIndex = headers.findIndex(h =>
                    h?.toString().trim().toLowerCase() === colName.toLowerCase()
                );

                if (colIndex !== -1 && row[colIndex] !== undefined) {
                    // Aplicamos el casteo de tipos (Date, Number, Boolean, etc.)
                    (instance as any)[propKey] = SheetMapper.castValue(
                        row[colIndex],
                        colOptions.type,
                        colOptions.default,
                        tz
                    );
                }
            });

            return instance;
        };

        // 4. Ejecución del Mapeo (Uno a Muchos o Uno a Uno)
        if (options.isMany) {
            (entity as any)[relationName] = dataRows
                .filter(row => normalize(row[joinColIndex]) === normalize(localValue))
                .map((row, idx) => {
                    // Buscamos el índice real en la hoja original
                    const physicalIndex = rawRelData.indexOf(row) + 1;
                    return mapToTargetEntity(row, physicalIndex);
                });
        } else {
            const foundIndex = dataRows.findIndex(row => normalize(row[joinColIndex]) === normalize(localValue));

            if (foundIndex !== -1) {
                const physicalIndex = foundIndex + 2;
                (entity as any)[relationName] = mapToTargetEntity(dataRows[foundIndex], physicalIndex);
            } else {
                (entity as any)[relationName] = null;
            }
        }

        return entity;
    }

    /**
 * Versión optimizada para GettersEngine o un BaseEngine compartido.
 */
    async fetchRows(): Promise<any[][]> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        // Usamos el resolvedSheetName que ya calculamos en el constructor
        const cacheKey = `sheet_data:${spreadsheetId}:${this.resolvedSheetName}`;

        // 1. Intentar obtener del caché
        const cached = await this.cacheManager.get<any[][]>(cacheKey);
        if (cached) return cached;

        // 2. Si no hay caché, pedir al gateway
        // Nota: Usamos getAllRows (o getValues) pasando el nombre resuelto
        const rows = await this.gateway.getAllRows(this.resolvedSheetName);

        // 3. Manejo de caché con TTL inteligente
        if (rows && rows.length > 0) {
            // 300 segundos (5 min) es excelente para lectura, 
            // pero recuerda invalidarlo en el SAVE del PersistenceEngine.
            await this.cacheManager.set(cacheKey, rows, 300);
        }

        return rows || [];
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




