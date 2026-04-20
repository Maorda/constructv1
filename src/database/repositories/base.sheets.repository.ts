import { Inject, Injectable, NotFoundException, Logger, OnModuleInit, InternalServerErrorException } from '@nestjs/common';
import { GoogleSpreedsheetService } from '../services/google.spreedsheet.service';
import { SheetMapper } from '../mappers/sheet.mapper';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager'; // <--- AMBOS desde aquí
import { EntityFilterQuery, Projection, UpdateQuery } from '@database/types/query.types';
import { getPrimaryKeyColumnName, PRIMARY_KEY_METADATA_KEY } from '../decorators/primarykey.decorator';
import { TABLE_COLUMN_KEY } from '@database/decorators/column.decorator';
import { IdGenerator } from '@database/utils/id.generator';
import { SheetsQuery } from '@database/engines/query.builder';
import { DocumentQuery } from '@database/engines/document.query';
import { ManipulateEngine } from '@database/engines/manipulateEngine';
import { PersistenceEngine } from '@database/engines/persistence.engine';
import { RelationalEngine } from '@database/engines/relational.engine';
import { CompareEngine } from '@database/engines/compare.engine';


/*
*Descripcion: Clase abstracta que implementa las operaciones CRUD para Google Sheets
*/

@Injectable()
export abstract class BaseSheetsRepository<T extends object> {
    private indexMap: Map<string, number> = new Map();
    private queryEngine = new CompareEngine<T>();
    private isSynced = false; // Flag para no repetir el proceso
    protected abstract readonly EntityClass: new () => T;
    protected readonly logger = new Logger(this.constructor.name);
    public sheetName: string;

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        protected readonly manipulateEngine: ManipulateEngine,
        protected readonly persistenceEngine: PersistenceEngine,
        protected readonly relationalEngine: RelationalEngine<T>,
        private readonly googleSheets: GoogleSpreedsheetService,
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions
    ) { }


    /**
 * Busca un registro y devuelve un DocumentQuery para encadenar populate.
 */
    findOne(filter: EntityFilterQuery<T> = {}): DocumentQuery<T> {
        return new DocumentQuery<T>(
            this,
            filter,
            this.queryEngine,
            this.manipulateEngine
        );
    }

    /**
     * Tu lógica de populate que mencionamos antes
     */
    async executePopulate(data: any, path: string): Promise<any> {
        // Lógica de cruce de IDs entre pestañas...
        return data;
    }

    refreshCache(): Promise<void> {
        throw new Error('Method not implemented.');
    }
    /**
       * Obtiene dinámicamente el nombre de la columna marcada como PrimaryKey
       */
    private getPrimaryKeyColumn(): string {
        const pkProperty = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, this.EntityClass);
        if (!pkProperty) {
            // Fallback por si olvidas poner el decorador
            throw new Error(`La entidad ${this.EntityClass.name} no tiene una @PrimaryKey definida.`);
        }
        return pkProperty;
    }

    /*
    * Descripcion: Actualiza un registro en la hoja de cálculo
    * @param filter Filtro para encontrar el registro
    * @param update Datos a actualizar
    * @param options Opciones de actualización
    * @returns Registro actualizado
    * @example
    * const updated = await this.repository.findOneAndUpdate(
    *   { dni: '12345678' },
    *   { $set: { nombre: 'Juan', edad: 30 } }
    * tambien
    * const updated = await this.repository.findOneAndUpdate(
    *   { dni: '12345678' },
    *   $push[{ nombre: 'Juan', edad: 30 }, { nombre: 'Maria', edad: 25 }]
    * );
    */
    async findOneAndUpdate(
        filter: EntityFilterQuery<T>,
        update: UpdateQuery<T>,
        options: { new?: boolean; upsert?: boolean; arrayFilters?: any[] } = { new: true, upsert: false },
    ): Promise<T | null> {
        await this.ensureSchema();

        // 1. DESCOMPOSICIÓN DE OPERADORES (Soporta $set y $push simultáneos)
        const updateObj = update as any;
        let dataToSet = updateObj.$set || (updateObj.$push ? {} : update);
        const dataToPush = updateObj.$push || null;

        // 2. BÚSQUEDA DEL REGISTRO EXISTENTE
        const records = await this.findAll();
        const record = records.find((r) => this.queryEngine.applyFilter(r, filter));

        const pkColumnName = getPrimaryKeyColumnName(this.EntityClass);
        if (!pkColumnName) {
            throw new Error(`La entidad ${this.EntityClass.name} no tiene @PrimaryKey.`);
        }

        // 3. TRANSFORMACIÓN DE DATOS (Aplicar operadores de fecha como $dateAdd)
        // Pasamos el 'record' para que pueda usar valores actuales de la fila en los cálculos
        dataToSet = this.applyDateTransformations(dataToSet, record);

        let finalEntity: T;

        if (!record) {
            if (!options.upsert) return null;

            // LÓGICA DE UPSERT: Filtro + Datos transformados
            finalEntity = {
                [pkColumnName]: IdGenerator.generate(),
                ...this.extractValuesFromFilter(filter),
                ...dataToSet,
            } as T;

            await this.save(finalEntity);
        } else {
            // LÓGICA DE UPDATE: Actualización selectiva
            const pkValue = (record as any)[pkColumnName] || this.findValueInInstance(record, pkColumnName);

            finalEntity = await this.updateRow(
                pkColumnName,
                pkValue,
                dataToSet as Partial<T>,
            );
        }

        // 4. PROCESAMIENTO DE $PUSH (Relaciones, $each y filtros posicionales)
        if (dataToPush) {
            // Usamos 'finalEntity' para asegurar que el ID padre esté disponible
            await this.relationalEngine.handlePushOperation(finalEntity, dataToPush, options.arrayFilters);
        }

        // 5. INVALIDACIÓN DE CACHÉ
        const cacheKey = `sheet_data:${this.spreadsheetId}:${this.sheetName}`;
        await this.cacheManager.del(cacheKey);

        return options.new ? finalEntity : (record || finalEntity);
    }
    /**
 * Construye o retorna el índice de filas basado en el ID.
 */
    private async getRowIndexById(id: string): Promise<number | null> {
        const sheetId = this.optionsDatabase.defaultSpreadsheetId;
        const sheetName = this.options.sheetName;

        // 1. Si el mapa está vacío, lo poblamos (Indexación en frío)
        if (this.indexMap.size === 0) {
            const rawRows = await this.googleSheets.getValues(sheetId, `${sheetName}!A:A`); // Solo leemos la columna A (IDs)
            if (rawRows) {
                rawRows.forEach((row, index) => {
                    if (index === 0) return; // Saltamos cabecera
                    const rowId = row[0];
                    if (rowId) this.indexMap.set(rowId.toString(), index + 1); // Guardamos ID -> Número de fila real
                });
            }
        }

        return this.indexMap.get(id) || null;
    }

    /**
     * Método de apoyo para interceptar y evaluar operadores de fecha antes de persistir
     */
    private applyDateTransformations(data: any, record: T | null): any {
        const transformed = { ...data };
        for (const key in transformed) {
            const value = transformed[key];
            // Detectamos si el valor es un objeto de operación (ej: { $dateAdd: {...} })
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                const operator = Object.keys(value)[0]; // Ejemplo: '$dateAdd'
                // Si el operador comienza con $, invocamos tu lógica de la Foto 4
                if (operator.startsWith('$')) {
                    transformed[key] = this.manipulateEngine.prepareForSave.evaluateDateOperator(
                        operator,
                        value[operator],
                        record || ({} as T) // Si es upsert, el record es un objeto vacío
                    );
                }
            }
        }
        return transformed;
    }

    extractValuesFromFilter(filter: any): any {
        const cleaned: any = {};
        for (const key in filter) {
            const value = filter[key];
            // Si el valor es directo (string/number), lo usamos. 
            // Si es un operador ($eq, $in), intentamos extraer el valor real.
            if (value !== null && typeof value === 'object') {
                if (value['$eq'] !== undefined) cleaned[key] = value['$eq'];
                // Otros operadores se ignoran para la creación de filas nuevas
            } else {
                cleaned[key] = value;
            }
        }
        return cleaned;
    }


    /**
 * Guarda una entidad en una pestaña diferente a la del repositorio actual.
 * Ideal para operaciones de $push (relaciones).
 */
    private async saveInOtherSheet(sheetName: string, TargetClass: any, entity: any): Promise<any> {
        // 1. Obtener encabezados de la pestaña destino (usando caché para no saturar la API)
        const targetHeaders = await this.getHeadersForSheet(sheetName);

        // 2. Convertir la entidad a fila usando el Mapper y los headers destino
        const rowValues = SheetMapper.entityToRow(entity, targetHeaders);

        // 3. Insertar en la pestaña correspondiente
        await this.googleSheets.appendRow(
            this.spreadsheetId,
            `${sheetName}!A:A`,
            rowValues
        );

        // 4. Invalidar el caché de esa pestaña específica
        await this.cacheManager.del(`sheet_data:${this.spreadsheetId}:${sheetName}`);
        return entity; // <--- CRITICO: Retornar el objeto para la recursividad
    }


    /**
 * Busca el valor en el registro comparando nombres de columnas
 */
    private findValueInInstance(record: T, columnName: string): any {
        const target = this.EntityClass.prototype;
        for (const key of Object.keys(record as object)) {
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (options?.name === columnName || key === columnName) {
                return (record as any)[key];
            }
        }
        return null;
    }
    // src/database/repositories/base.sheets.repository.ts

    /**
 * Buscador con soporte para Query Chaining (estilo Mongoose).
 * Nota: Ya no es 'async' porque la ejecución real ocurre en el .then() de SheetsQuery
 */
    find(filter: EntityFilterQuery<T> = {}): SheetsQuery<T> {
        // 1. Validamos que el esquema esté cargado (opcional, pero recomendado)
        this.ensureSchema();

        // 2. Retornamos la clase encargada de construir la consulta.
        // Le pasamos 'this' para que SheetsQuery tenga acceso a findAll()
        // y le pasamos el queryEngine para que use tus métodos de filtrado y proyección.
        return new SheetsQuery<T>(this, filter, this.queryEngine);
    }


    /**
 * Normaliza valores de Google Sheets a tipos reales de TypeScript.
 * Crucial para evitar que "10" + "5" sea "105".
 */
    private normalizeValue(val: any): any {
        if (val instanceof Date) return val.getTime();
        if (val === null || val === undefined) return null;

        // Si es un string, limpiamos espacios (típico en Sheets)
        const isString = typeof val === 'string';
        const cleanVal = isString ? val.trim() : val;

        // Si es un número o un string que representa un número
        if (cleanVal !== '' && !isNaN(Number(cleanVal)) && typeof cleanVal !== 'boolean') {
            return Number(cleanVal);
        }

        // Si es un string que parece fecha ISO
        if (isString && cleanVal.includes('-') && !isNaN(Date.parse(cleanVal))) {
            return new Date(cleanVal).getTime();
        }

        return isString ? cleanVal.toLowerCase() : val;
    }

    /**
     * Lógica interna para "podar" los campos del objeto según la Projection
     */
    applyProjection(record: T, projection: Projection<T>): Partial<T> {
        const projectedRecord: Partial<T> = {};
        const projectionKeys = Object.keys(projection);

        // Si la proyección está vacía, devolvemos todo
        if (projectionKeys.length === 0) return record;

        // Verificamos si es una proyección de INCLUSIÓN (dni: 1) o EXCLUSIÓN (dni: 0)
        const isInclusion = Object.values(projection).some(v => v === 1 || v === true);

        if (isInclusion) {
            // Solo incluimos lo que el usuario marcó con 1 o true
            projectionKeys.forEach((key) => {
                if (projection[key as keyof T]) {
                    projectedRecord[key as keyof T] = record[key as keyof T];
                }
            });
        } else {
            // Excluimos lo que el usuario marcó con 0 o false y devolvemos el resto
            Object.keys(record as object).forEach((key) => {
                if (projection[key as keyof T] === undefined || projection[key as keyof T] === true) {
                    // (En exclusión simple, si no está en el objeto de proyección, se queda)
                    projectedRecord[key as keyof T] = record[key as keyof T];
                }
            });
        }

        return projectedRecord;
    }

    /*
    *Descripcion: Inicializa la hoja de Google Sheets
    * Parametros: 
    *   sheetName: Nombre de la hoja
    * Retorna: void
    */
    async initialize(sheetName: string) {
        this.sheetName = sheetName;
        let isNewSheet = false;

        try {
            const existingSheets = await this.googleSheets.getExistingSpreadsheetSheets(this.spreadsheetId);

            if (!existingSheets.includes(this.sheetName)) {
                this.logger.warn(`🚀 Pestaña "${this.sheetName}" no encontrada. Creándola...`);
                await this.googleSheets.createSheet(this.spreadsheetId, this.sheetName);
                isNewSheet = true;

                // Aumentamos a 1.5 segundos el respiro para Google
                await new Promise(res => setTimeout(res, 1500));
            }

            // Pasamos el flag isNewSheet para forzar la escritura
            await this.syncSchema(isNewSheet);

        } catch (error) {
            this.logger.error(`❌ Error en inicialización de ${this.sheetName}: ${error.message}`);
        }
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
     * Compara dos arrays de cabeceras de forma tolerante (sin espacios y en mayúsculas)
     */
    private checkDesync(expected: string[], current: any[]): boolean {
        // Si tienen diferente longitud, definitivamente están desincronizados
        if (expected.length !== current.length) return true;

        // Comparamos elemento por elemento normalizando el texto
        return expected.some((header, index) => {
            const normalize = (val: any) => String(val || '').trim().toUpperCase();
            return normalize(header) !== normalize(current[index]);
        });
    }

    /**
   * Actualiza un registro por un identificador (ej: DNI)
   * Parametros: 
   *   identifierColumn: Columna identificadora
   *   value: Valor de la columna identificadora
   *   partialEntity: Entidad parcial con los datos a actualizar
   * Retorna: Entidad actualizada
   * Ejemplo: 
   *   await this.repository.updateRow('dni', '12345678', { nombre: 'Juan', apellido: 'Perez' });
   */
    async updateRow(identifierColumn: string, value: any, partialEntity: Partial<T>): Promise<T> {
        await this.ensureSchema();
        const range = `${this.sheetName}!A:Z`;
        const rows = await this.googleSheets.getValues(this.spreadsheetId, range);
        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(identifierColumn);
        if (colIndex === -1) throw new Error(`Columna ${identifierColumn} no encontrada`);
        const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[colIndex]) === String(value));
        if (rowIndex === -1) throw new NotFoundException('Registro no encontrado');
        // Mapear, fusionar y actualizar
        const currentData = SheetMapper.mapToEntity(headers, rows[rowIndex], this.EntityClass);
        const updatedData = Object.assign(currentData, partialEntity);
        const updatedRow = SheetMapper.mapToRow(headers, updatedData);
        // El rango es 1-based, por eso rowIndex + 1
        await this.googleSheets.updateRow(this.spreadsheetId, `${this.sheetName}!A${rowIndex + 1}`, [updatedRow]);
        return updatedData;
    }


    /**
     * Obtiene el ID del spreadsheet (usa el por defecto o el de env)
     */
    protected get spreadsheetId(): string {
        const id = this.options.defaultSpreadsheetId || process.env.SPREADSHEET_ID;
        if (!id) throw new Error(`No se encontró SPREADSHEET_ID para ${this.sheetName}`);
        return id;
    }

    /**
     * Busca un registro por una columna y valor específico
     * Parametros: 
     *   columnName: Columna identificadora
     *   value: Valor de la columna identificadora
     * Retorna: Entidad encontrada
     * Ejemplo: 
     *   await this.repository.findOneByColumn('dni', '12345678');
     */
    async findOneByColumn(columnName: string, value: any): Promise<T | null> {
        await this.ensureSchema();
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return null;
        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(columnName);
        if (colIndex === -1) {
            this.logger.error(`La columna "${columnName}" no existe en la pestaña "${this.sheetName}"`);
            return null;
        }
        const foundRow = rows.slice(1).find(row => String(row[colIndex]) === String(value));
        return foundRow ? SheetMapper.mapToEntity(headers, foundRow, this.EntityClass) : null;
    }

    /**
   * Obtiene los datos de la hoja optimizando las llamadas mediante caché.
   * TTL sugerido: 10 segundos para procesos rápidos, o más según tu necesidad.
   */
    private async getOrFetchSheet(sheetName: string): Promise<any[][] | null> {
        const cacheKey = `sheet_data:${this.spreadsheetId}:${sheetName}`;

        // 1. Intentar obtener del caché
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) return cachedData;

        // 2. Si no hay caché, pedir a Google Sheets
        const freshData = await this.googleSheets.getValues(
            this.spreadsheetId,
            `${sheetName}!A:Z`
        );

        if (freshData && freshData.length > 0) {
            // 3. Guardar en caché (ejemplo: 10 segundos)
            await this.cacheManager.set(cacheKey, freshData, 10000);
        }

        return freshData;
    }


    /**
   * Carga relaciones de forma inteligente (Uno a Uno o Uno a Muchos)
   * Parametros: 
   *   entity: Entidad con la relación a cargar
   *   relationName: Nombre de la relación
   * Retorna: Entidad con la relación cargada
   * Ejemplo: 
   *   await this.repository.populate(entity, 'cliente');
   */
    /*    async populate(entity: T, relationName: keyof T): Promise<T> {
            await this.ensureSchema();
            const options: RelationOptions = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype,
                relationName as string);
            if (!options) {
                this.logger.warn(`Propiedad "${String(relationName)}" no es una relación válida.`);
                return entity;
            } // 1. Obtener los datos de la pestaña destino
            const relRows = await this.googleSheets.getValues(this.spreadsheetId, `${options.targetSheet}!A:Z`);
            if (!relRows || relRows.length <= 1) {
                entity[relationName] = (options.isMany ? [] : null) as any;
                return entity;
            } const headers = relRows[0] as string[];
            const joinColIndex = headers.indexOf(options.joinColumn);
            const localValue = entity[options.localField];
            const TargetClass = options.targetEntity();
            if (joinColIndex === -1) {
                this.logger.error(`Columna de unión "${options.joinColumn}" no existe en "${options.targetSheet}"`);
                return entity;
            }// 2. Filtrar o buscar según el tipo de relación (isMany)
            const dataRows = relRows.slice(1);
            if (options.isMany) {            // Caso: Uno a Muchos (ej: Empleado -> Adelantos[])
                const relatedEntities = dataRows
                    .filter(row => String(row[joinColIndex]) === String(localValue))
                    .map(row => SheetMapper.mapToEntity(headers, row, TargetClass));
                entity[relationName] = relatedEntities as any;
            } else {            // Caso: Uno a Uno (ej: Adelanto -> Empleado)
                const foundRow = dataRows.find(row => String(row[joinColIndex]) === String(localValue));
                entity[relationName] = foundRow ? SheetMapper.mapToEntity(headers, foundRow, TargetClass) as any : null;
            } return entity;
        }
            */



    /**
 * Carga automáticamente todas las relaciones definidas mediante @Relation
 * @param entity La instancia de la entidad a la que se le cargarán los datos
 */
    /**
 * Versión optimizada de populateAll
 * Ejecuta todas las relaciones en paralelo y utiliza un caché local
 * para no descargar la misma pestaña varias veces.
 */
    /*
    async populateAll(entity: T): Promise<T> {
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', this.EntityClass.prototype) || [];

        if (relations.length === 0) return entity;

        // Mapa temporal para almacenar los datos de las pestañas ya descargadas
        const sheetsCache = new Map<string, any[][]>();

        await Promise.all(
            relations.map(async (relationName) => {
                const options = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype, relationName);

                if (!options) return;

                // 1. Verificar si ya tenemos los datos de esa pestaña en el caché
                let relRows = sheetsCache.get(options.targetSheet);

                if (!relRows) {
                    // Solo descargamos si no está en el mapa
                    relRows = await this.googleSheets.getValues(this.spreadsheetId, `${options.targetSheet}!A:Z`);
                    sheetsCache.set(options.targetSheet, relRows);
                }

                // 2. Llamamos a un método interno de populate que acepte los datos ya cargados
                // Esto evita que this.populate vuelva a llamar a this.googleSheets.getValues
                await this.internalPopulate(entity, relationName as keyof T, relRows);
            })
        );

        return entity;
    }*/




    async save(entity: T): Promise<T> {
        await this.ensureSchemaTemporal();

        // Si la entidad no tiene ID, lo generamos automáticamente
        if (!(entity as any).id) {
            (entity as any).id = IdGenerator.generate();
        }

        // 1. Convertimos la entidad a un array de valores (fila) usando el Mapper
        const rowValues = SheetMapper.entityToRow(entity, this.headers);

        // 2. Insertamos en Google Sheets
        await this.googleSheets.appendRow(
            this.spreadsheetId,
            `${this.sheetName}!A:A`, // Rango de inserción
            rowValues
        );

        // 3. INVALIDACIÓN DEL CACHÉ: 
        // Borramos el caché de esta pestaña para que la próxima lectura sea fresca
        const cacheKey = `sheet_data:${this.spreadsheetId}:${this.sheetName}`;
        await this.cacheManager.del(cacheKey);

        return entity;
    }

    async update(id: string | number, entity: Partial<T>): Promise<T> {
        await this.ensureSchema();

        // 1. Obtener todos los datos actuales (usando nuestro método optimizado con caché)
        const rows = await this.getOrFetchSheet(this.sheetName);
        if (!rows || rows.length <= 1) throw new Error('Sheet is empty');

        const headers = rows[0];
        const idIndex = headers.indexOf('id'); // Asumimos que tu columna clave se llama 'id'

        if (idIndex === -1) throw new Error('Column "id" not found');

        // 2. Buscar el índice de la fila (sumamos 1 porque Sheets es base 1 y otro 1 por el header)
        const rowIndex = rows.findIndex((row, index) => index > 0 && String(row[idIndex]) === String(id));

        if (rowIndex === -1) throw new Error(`Entity with ID ${id} not found`);

        // 3. Mapear la entidad actualizada a los valores de la fila
        // Aquí puedes obtener la entidad actual y mezclarla con el Partial
        const currentRow = rows[rowIndex];
        const updatedEntity = { ...SheetMapper.mapToEntity(headers, currentRow, this.EntityClass), ...entity };
        const updatedRowValues = SheetMapper.entityToRow(updatedEntity, headers);

        // 4. Actualizar en Google Sheets (usando el rango específico A{n}:Z{n})
        const range = `${this.sheetName}!A${rowIndex + 1}`;
        await this.googleSheets.updateRow(this.spreadsheetId, range, updatedRowValues);

        // 5. INVALIDACIÓN DEL CACHÉ
        const cacheKey = `sheet_data:${this.spreadsheetId}:${this.sheetName}`;
        await this.cacheManager.del(cacheKey);

        return updatedEntity as T;
    }




    /**
     * Método auxiliar que realiza la unión lógica sin hacer peticiones externas
     */
    private async internalPopulate(entity: T, relationName: keyof T, relRows: any[][]): Promise<void> {
        if (!relRows || relRows.length <= 1) return;

        const options = Reflect.getMetadata(RELATION_METADATA_KEY, this.EntityClass.prototype, relationName as string);
        const headers = relRows[0] as string[];
        const joinColIndex = headers.indexOf(options.joinColumn);
        const localValue = entity[options.localField];
        const TargetClass = options.targetEntity();
        const dataRows = relRows.slice(1);

        if (joinColIndex === -1) return;

        // Lógica de comparación normalizada (limpieza de espacios y tipos)
        const compare = (val1: any, val2: any) => String(val1).trim() === String(val2).trim();

        if (options.isMany) {
            const relatedEntities = dataRows
                .filter(row => compare(row[joinColIndex], localValue))
                .map(row => SheetMapper.mapToEntity(headers, row, TargetClass));
            (entity as any)[relationName] = relatedEntities;
        } else {
            const foundRow = dataRows.find(row => compare(row[joinColIndex], localValue));
            (entity as any)[relationName] = foundRow
                ? SheetMapper.mapToEntity(headers, foundRow, TargetClass)
                : null;
        }
    }

    /**
     * Inserta un nuevo registro mapeando la entidad a una fila de Excel
     * Parametros: 
     *   entity: Entidad a insertar
     * Retorna: void
     * Ejemplo: 
     *   await this.repository.create(entity);
     */
    async createHeaderFromEntity(entity: T): Promise<void> {
        try {
            // 1. Verificamos que la tabla exista (asegura el plural y las cabeceras)
            await this.ensureSchema();
            // --- SECCIÓN DE CACHÉ DE CABECERAS ---
            const headersKey = `headers:${this.sheetName}`;
            let headers = await this.cacheManager.get<string[]>(headersKey);
            if (!headers) {
                this.logger.debug(`[Cache Miss] Recuperando cabeceras para ${this.sheetName} desde Google`);
                const response = await this.googleSheets.getValues(
                    this.spreadsheetId,
                    `${this.sheetName}!A1:Z1`,
                );
                if (!response || response.length === 0) {
                    throw new Error(`La hoja ${this.sheetName} no tiene cabeceras definidas.`);
                }
                headers = response[0] as string[];
                // Guardamos las cabeceras en caché (puedes omitir el TTL para que sea indefinido)
                await this.cacheManager.set(headersKey, headers);
            }
            // --- SECCIÓN DE INSERCIÓN ---
            // Mapeamos la entidad (objeto JS) a una fila (Array) usando las cabeceras
            const newRow = SheetMapper.mapToRow(headers, entity);
            await this.googleSheets.appendRow(
                this.spreadsheetId,
                this.sheetName,
                newRow,
            );
            // --- SECCIÓN DE INVALIDACIÓN DE CACHÉ ---
            // Borramos la caché de la lista completa (findAll) 
            // para que la próxima lectura traiga el nuevo registro insertado.
            const listKey = `list:${this.sheetName}`;
            await this.cacheManager.del(listKey);
            this.logger.log(`✅ Registro creado con éxito en "${this.sheetName}" e invalidada la caché de lectura.`);
        } catch (error) {
            this.logger.error(`❌ Fallo en create (${this.sheetName}): ${error.message}`);
            throw error;
        }
    }
    /**
   * Método para forzar la actualización si cambiaste el Excel manualmente
   */
    async refreshHeaders(): Promise<void> {
        await this.cacheManager.del(`headers:${this.sheetName}`);
        this.logger.log(`Caché de cabeceras para ${this.sheetName} eliminada.`);
    }
    /**
   * Busca registros de un DNI dentro de un rango de fechas.
   * Asume que la entidad tiene las propiedades 'dni' y 'fecha'.
   * Parametros: 
   *   dni: DNI del registro a buscar
   *   fechaInicio: Fecha de inicio del rango
   *   fechaFin: Fecha de fin del rango
   * Retorna: Entidad encontrada
   * Ejemplo: 
   *   await this.repository.findRange('12345678', '2022-01-01', '2022-12-31');
   */
    async findRange(dni: string, fechaInicio: string, fechaFin: string): Promise<T[]> {
        const todos = await this.findAll();

        return todos.filter((item: any) => {
            const cumpleDni = item.dni === dni;
            const cumpleFecha = item.fecha >= fechaInicio && item.fecha <= fechaFin;
            return cumpleDni && cumpleFecha;
        });
    }

    /**
     * Retorna todos los registros de la hoja (usando caché)
     * Parametros: 
     *   none
     * Retorna: Entidad encontrada
     * Ejemplo: 
     *   await this.repository.findAll();
     */
    async findAll(): Promise<T[]> {
        const cacheKey = `list:${this.sheetName}`;

        // 1. Intentar obtener de caché
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        // 2. Si no hay, consultar Google
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapear de filas a objetos usando la clase de la entidad
        const EntityClass = (this as any).EntityClass;
        const entities = dataRows.map(row => SheetMapper.mapFromRow(headers, row, EntityClass));

        // 4. Guardar en caché
        await this.cacheManager.set(cacheKey, entities);
        return entities;
    }
    /**
     * @description Busca un registro específico por su ID
     * @param id ID del registro a buscar
     * @returns T | null: Entidad encontrada
     * @example await this.repository.findById('12345678');
     */
    async findById(id: string | number): Promise<T | null> {
        const cacheKey = `item:${this.sheetName}:${id}`;

        // 1. Buscar en caché individual
        const cached = await this.cacheManager.get<T>(cacheKey);
        if (cached) return cached;

        // 2. Si no está, buscar en la lista completa (que aprovecha su propia caché)
        const all = await this.findAll();

        // Buscamos el elemento. Nota: Asegúrate de que tu entidad tenga un campo 'id'
        const item = all.find(e => (e as any).id == id) || null;

        if (item) {
            await this.cacheManager.set(cacheKey, item);
        }

        return item;
    }




}