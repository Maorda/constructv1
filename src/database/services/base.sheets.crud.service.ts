import { Injectable, Inject, Logger, NotFoundException, InternalServerErrorException, OnModuleInit } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { GoogleSpreedsheetService } from './google.spreedsheet.service';
import { RelationOptions, RELATION_METADATA_KEY } from '@database/decorators/relation.decorator';
import { EntityFilterQuery, Projection, UpdateQuery } from '@database/types/query.types';
import { IdGenerator } from '@database/utils/id.generator';
import { getPrimaryKeyColumnName } from '@database/decorators/primarykey.decorator';
import { SheetsQuery } from '@database/engines/sheet.query';
import { SheetMapper } from '@database/mappers/sheet.mapper';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { TABLE_COLUMN_KEY } from '@database/decorators/column.decorator';
import { RelationalEngine } from '@database/engines/relational.engine';
import { ManipulateEngine } from '@database/engines/manipulateEngine';
import { GettersEngine } from '@database/engines/getters.engine';
import { PersistenceEngine } from '@database/engines/persistence.engine';
import { CompareEngine } from '@database/engines/compare.engine';
import { DocumentQuery } from '@database/engines/document.query';
import { ModuleRef } from '@nestjs/core'
import { NamingStrategy } from '@database/strategy/naming.strategy';


@Injectable()
export abstract class BaseSheetsCrudService<T extends object> {
    private readonly logger = new Logger(BaseSheetsCrudService.name);
    private isSynced = false;
    public sheetName: string;
    private queryEngine = new CompareEngine<T>();
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    // Definimos la propiedad que TypeScript reclama
    constructor(
        protected readonly EntityClass: new () => T,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly spreadsheetService: GoogleSpreedsheetService<T>,
        private readonly compareEngine: CompareEngine<T>,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine<T>, // Tu motor de mutación
        private readonly gettersEngine: GettersEngine,      // Tu motor de consulta
        private readonly relationalEngine: RelationalEngine<T>,
        private readonly persistenceEngine: PersistenceEngine<T>,
        protected readonly moduleRef: ModuleRef,
    ) { // Ahora sí puedes usar NamingStrategy porque EntityClass ya tiene valor
        this.sheetName = NamingStrategy.formatSheetName(this.EntityClass.name);
    }

    async findAll(): Promise<T[]> {
        //const sheetName = this.EntityClass.name;
        // En la clase base


        const cacheKey = `list:${this.sheetName}`;

        // 1. Caché de objetos ya procesados
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        // 2. Obtener datos crudos (con caché de infraestructura)
        const rows = await this.spreadsheetService.getOrFetchSheet(this.sheetName);
        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapear usando la lógica mejorada
        const entities = dataRows.map(row =>
            SheetMapper.mapToEntity(headers, row, this.EntityClass)
        );

        // 4. Guardar en caché
        await this.cacheManager.set(cacheKey, entities);

        return entities;
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
    findOne(filter: EntityFilterQuery<T> = {}): DocumentQuery<T> {
        // Retornamos el objeto Query pasando las dependencias necesarias
        return new DocumentQuery<T>(
            this.spreadsheetService,
            filter,
            this.queryEngine,
            this.manipulateEngine,
            this // Pasamos la instancia del servicio actual para la ejecución final
        );
    }
    /**
 * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
 */
    async create(entity: T): Promise<T> {
        // 1. Usamos el EntityClass que ya tenemos en la clase base
        const sheetName = this.EntityClass.name;

        // 2. Obtenemos headers (Usando el servicio de Google que ya tiene caché)
        const rawData = await this.spreadsheetService.getOrFetchSheet(sheetName);
        const headers = rawData && rawData.length > 0 ? rawData[0] : [];

        if (headers.length === 0) {
            throw new Error(`No se pudieron obtener los encabezados para la hoja: ${sheetName}`);
        }

        // 3. Preparación de ID (Opcional: Si no viene, podrías generarlo aquí)
        // const entityWithId = this.ensureId(entity);

        // 4. Convertimos la entidad a una fila plana (Array)
        // SheetMapper.mapToRow debe ser el inverso de mapToEntity
        const row = SheetMapper.mapToRow(headers, entity);

        // 5. Guardamos en Google Sheets
        // Importante: mandamos [row] porque appendRows espera una matriz de datos
        await this.spreadsheetService.appendRows(
            this.options.defaultSpreadsheetId,
            `${sheetName}!A1`,
            [row]
        );

        // 6. LIMPIEZA DE CACHÉ (Vital para la consistencia)
        await this.clearCache();

        return entity;
    }

    /**
     * Método para limpiar el caché relacionado con esta entidad
     */
    private async clearCache(): Promise<void> {
        const sheetName = this.EntityClass.name;
        const spreadsheetId = this.options.defaultSpreadsheetId;

        // Borramos la lista completa y el caché de infraestructura
        await this.cacheManager.del(`list:${sheetName}`);
        await this.cacheManager.del(`sheet_data:${spreadsheetId}:${sheetName}`);
    }

    async findOneAndUpdate(
        filter: EntityFilterQuery<T>,
        update: UpdateQuery<T>,
        options: { new?: boolean; upsert?: boolean; arrayFilters?: any[] } = { new: true, upsert: false },
    ): Promise<T | null> {
        await this.ensureSchema();

        // 1. DESCOMPOSICIÓN DE OPERADORES
        const updateObj = update as any;
        let dataToSet = updateObj.$set || (updateObj.$push ? {} : update);
        const dataToPush = updateObj.$push || null;

        // 2. BÚSQUEDA DEL REGISTRO Y SU POSICIÓN
        // Importante: Necesitamos el índice de la fila para el Batch Update
        const rawRows = await this.spreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, `${this.sheetName}!A:Z`);
        const headers = rawRows[0];

        // Buscamos el registro y guardamos su índice (rowIndex = index + 2 porque las filas en Sheets son base 1 y hay cabecera)
        let rowIndex = -1;
        const record = rawRows.slice(1).find((row, index) => {
            const entity = SheetMapper.mapToEntity(headers, row, this.EntityClass);
            if (this.queryEngine.applyFilter(entity, filter)) {
                rowIndex = index + 2;
                return true;
            }
            return false;
        }) as T | undefined;

        const pkColumnName = getPrimaryKeyColumnName(this.EntityClass);
        if (!pkColumnName) throw new Error(`La entidad ${this.EntityClass.name} no tiene @PrimaryKey.`);

        // 3. TRANSFORMACIÓN CON MOTORES
        // El motor usa el 'record' actual para resolver cálculos como $dateDiff
        const mutatedData = this.manipulateEngine.execute(dataToSet, record || {});

        let finalEntity: T;
        let currentEntity: T | null = null; // Inicializamos aquí

        if (!record) {
            if (!options.upsert) return null;

            // LÓGICA DE UPSERT: Crear nuevo
            finalEntity = {
                [pkColumnName]: IdGenerator.generate(),
                ...this.extractValuesFromFilter(filter),
                ...mutatedData,
            } as T;

            // Save usa appendRow (nueva fila al final)
            await this.save(finalEntity);
        } else {
            // LÓGICA DE UPDATE OPTIMIZADO (Batch + Delta)
            currentEntity = SheetMapper.mapToEntity(headers, (record as any), this.EntityClass);

            // Unimos los datos actuales con las mutaciones
            finalEntity = Object.assign(new this.EntityClass(), currentEntity, mutatedData);

            // Obtenemos solo lo que cambió
            const delta = SheetMapper.getDeltaUpdate(headers, currentEntity, finalEntity);

            if (delta.length > 0) {
                // Preparamos el Batch para Google Sheets
                const batchUpdates = delta.map(change => ({
                    range: `${this.sheetName}!${this.relationalEngine.getColumnLetter(change.colIndex)}${rowIndex}`,
                    value: change.value
                }));

                // Enviamos todos los cambios en una sola petición
                await this.relationalEngine.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, batchUpdates);
            }
        }

        // 4. PROCESAMIENTO DE $PUSH (Relaciones)
        if (dataToPush) {
            await this.relationalEngine.handlePushOperation(finalEntity, dataToPush, options.arrayFilters);
        }

        // 5. INVALIDACIÓN DE CACHÉ QUIRÚRGICA
        // En lugar de borrar toda la pestaña, borramos solo este registro
        const pkValue = (finalEntity as any)[pkColumnName];
        await this.cacheManager.del(`row:${this.sheetName}:${pkValue}`);
        await this.cacheManager.del(`list:${this.sheetName}`); // Invalida la lista general

        return options.new ? finalEntity : (currentEntity || finalEntity);
    }



    /**
     * Lógica interna para "podar" los campos del objeto según la Projection.
     * Se define como protected para que DocumentQuery (que tiene acceso al service)
     * pueda invocarlo durante la resolución de la consulta.
     */

    protected applyProjection(record: T, projection: Projection<T>): Partial<T> {
        const projectionKeys = Object.keys(projection);
        if (projectionKeys.length === 0) return record;

        const projectedRecord: any = {};
        const isInclusion = projectionKeys.some(
            key => projection[key as keyof T] === 1 || projection[key as keyof T] === true
        );

        if (isInclusion) {
            projectionKeys.forEach((key) => {
                if (projection[key as keyof T]) {
                    projectedRecord[key] = (record as any)[key];
                }
            });
            // Seguridad: El ID es necesario para el .save() de SheetDocument
            if (projection['id' as keyof T] !== 0 && (record as any).id) {
                projectedRecord.id = (record as any).id;
            }
        } else {
            Object.keys(record as object).forEach((key) => {
                if (projection[key as keyof T] !== 0 && projection[key as keyof T] !== false) {
                    projectedRecord[key] = (record as any)[key];
                }
            });
        }
        return projectedRecord as Partial<T>;
    }

    /**
     * Resuelve relaciones, incluyendo rutas anidadas (ej: 'asistencias.local')
     */
    public async executePopulate(record: any, path: string): Promise<any> {
        // 1. Separamos el path por puntos: ['asistencias', 'local']
        const parts = path.split('.');
        const currentPath = parts[0];
        const remainingPath = parts.slice(1).join('.');

        // 2. Obtener metadatos de la relación actual
        const target = this.EntityClass.prototype;
        const relation = Reflect.getMetadata(RELATION_METADATA_KEY, target, currentPath);

        if (!relation) return record;

        // 3. Traer la data relacionada (Capa 1)
        let relatedData = await this.relationalEngine.fetchRelation(record.id, relation);

        // 4. Si hay niveles más profundos (ANIDACIÓN)
        if (remainingPath && relatedData) {
            // Obtenemos el servicio de la entidad destino (ej: AsistenciasService)
            const targetService = this.moduleRef.get(relation.targetService);

            if (Array.isArray(relatedData)) {
                // Si es 1:N, poblamos cada elemento del array
                relatedData = await Promise.all(
                    relatedData.map(item => targetService.executePopulate(item, remainingPath))
                );
            } else {
                // Si es 1:1, poblamos el objeto único
                relatedData = await targetService.executePopulate(relatedData, remainingPath);
            }
        }

        return { ...record, [currentPath]: relatedData };
    }








    async softDelete<T>(EntityClass: new () => T, rowIndex: number): Promise<void> {
        const sheetName = EntityClass.name;
        const headers = await this.persistenceEngine.getHeaders(EntityClass);

        // Buscamos el índice de la columna que maneja el estado
        // Asumiendo que en tu DTO tienes una columna @Column({ name: 'activo' })
        const statusColIndex = headers.indexOf('activo');

        if (statusColIndex === -1) {
            throw new Error(`No se encontró la columna "activo" para borrado lógico en ${sheetName}`);
        }

        const columnLetter = this.relationalEngine.getColumnLetter(statusColIndex);
        const range = `${sheetName}!${columnLetter}${rowIndex}`;

        // Marcamos como 'false' o 'INACTIVO'
        await this.relationalEngine.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, [
            { range, value: false }
        ]);

        this.logger.log(`Registro en fila ${rowIndex} marcado como inactivo.`);
    }



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
         * Retorna todos los registros de la hoja (usando caché)
         * Parametros: 
         *   none
         * Retorna: Entidad encontrada
         * Ejemplo: 
         *   await this.repository.findAll();
    */

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

    private async resolveRelations(entityClass: any, record: any) {
        const instance = new entityClass();
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', instance) || [];

        for (const prop of relations) {
            const config: RelationOptions = Reflect.getMetadata(RELATION_METADATA_KEY, instance, prop);
            const localValue = record[config.localField];

            if (localValue) {
                const allRelated = await this.spreadsheetService.findAll();
                const matched = allRelated.filter(r => String(r[config.joinColumn]) === String(localValue));
                record[prop] = config.isMany ? matched : (matched[0] || null);
            }
        }
        return record;
    }
    /**
 * Sincroniza el esquema de la hoja de Google Sheets.
 * Compara las cabeceras actuales con las definidas en los decoradores de la Entidad.
 */
    async syncSchema(force: boolean = false): Promise<void> {

        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // 1. Obtener definición de columnas desde el código
        const expectedHeaders = SheetMapper.getColumnHeaders(this.EntityClass);
        const cleanExpected = expectedHeaders.map(h => String(h || '').trim());

        if (cleanExpected.length === 0) {
            this.logger.error(`❌ Error: No se encontraron decoradores @Column en ${this.sheetName}`);
            return;
        }

        try {
            // --- PASO A: VALIDACIÓN Y CREACIÓN DE PESTAÑA ---
            const metadata = await this.spreadsheetService.getSpreadsheetMetadata();
            const sheetExists = metadata.sheets.some(s => s.properties.title === this.sheetName);

            if (!sheetExists) {
                this.logger.warn(`Pestaña "${this.sheetName}" no existe. Creándola...`);
                await this.spreadsheetService.createSheet(spreadsheetId, this.sheetName);
                force = true; // Forzamos escritura de cabeceras en la nueva hoja
            }

            // --- PASO B: CHEQUEO DE CABECERAS ---
            let currentHeaders: any[] = [];
            if (!force) {
                const range = `${this.sheetName}!A1:Z1`;
                const response = await this.spreadsheetService.getValues(spreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }

            // Comparación inteligente (Ignora mayúsculas/minúsculas para decidir si sincronizar)
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) =>
                    String(currentHeaders[i] || '').trim().toUpperCase() !== h.toUpperCase()
                );

            if (isDesync) {
                this.logger.warn(`✍️ Sincronizando cabeceras en "${this.sheetName}"...`);

                // Escribimos respetando el Case original del código
                await this.spreadsheetService.updateRowRaw(
                    spreadsheetId,
                    `${this.sheetName}!A1`,
                    [cleanExpected]
                );

                await this.cacheManager.del(`sheet_data:${spreadsheetId}:${this.sheetName}`);
                this.logger.log(`✅ Esquema de "${this.sheetName}" actualizado.`);
            } else {
                this.logger.log(`✅ Esquema de "${this.sheetName}" al día.`);
            }

        } catch (error) {
            this.logger.error(`❌ Error en syncSchema [${this.sheetName}]: ${error.message}`);
            if (error.response?.data) {
                this.logger.error('Detalle técnico Google:', JSON.stringify(error.response.data));
            }
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
     * Este es el método que REALMENTE va a Google Sheets.
     * Es llamado internamente por el DocumentQuery.then()
     */
    async executeQuery(filter: EntityFilterQuery<T>, projection?: Projection<T>): Promise<Partial<T> | null> {
        // 1. Obtenemos todos los datos (crudos)
        const allRows = await this.findAll(); // Método que lee la hoja

        // 2. Usamos el CompareEngine para encontrar la fila que calza
        const record = allRows.find(row => this.queryEngine.applyFilter(row, filter));

        if (!record) return null;

        // 3. APLICAMOS LA PROYECCIÓN
        // Usamos el método que revisamos anteriormente
        return this.applyProjection(record as T, projection || {});
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

    // En BaseSheetsCrudService.ts
    // En BaseSheetsCrudService.ts
    async save(entity: T): Promise<T> {
        // 1. Asegurar que exista la hoja/cabeceras
        // syncSchema ya se llama en initialize, pero ensureSchema lo valida si es necesario
        await this.ensureSchema();

        // 2. Garantizar ID
        const pk = getPrimaryKeyColumnName(this.EntityClass) || 'id';
        if (!(entity as any)[pk]) {
            (entity as any)[pk] = IdGenerator.generate();
        }

        // 3. Mapeo a Fila (Con tu lógica de casting inteligente y formato Perú)
        const headers = SheetMapper.getColumnHeaders(this.EntityClass);
        const rowValues = SheetMapper.mapToRow(headers, entity);

        // 4. Inserción física
        // IMPORTANTE: Usamos this.sheetName (ej: OBREROS_ACTIVOS)
        await this.persistenceEngine.appendRow(
            this.sheetName, // Tu método appendRow ya conoce el SpreadsheetID internamente
            rowValues
        );

        // 5. Limpieza de caché quirúrgica
        const pkValue = (entity as any)[pk];
        await this.cacheManager.del(`row:${this.sheetName}:${pkValue}`);
        await this.cacheManager.del(`list:${this.sheetName}`);

        return entity;
    }
    // Dentro de tu BaseSheetsCrudService.ts
    async ensureSheetExists(): Promise<void> {
        const sheetName = this.EntityClass.name;
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // 1. Llamamos al método que acabamos de crear
        const metadata = await this.spreadsheetService.getSpreadsheetMetadata();

        // 2. Buscamos si el nombre de nuestra clase existe como pestaña
        const exists = metadata.sheets.some(s => s.properties.title === sheetName);

        if (!exists) {
            this.logger.warn(`Pestaña "${sheetName}" no encontrada. Creándola...`);
            await this.spreadsheetService.createSheet(spreadsheetId, sheetName);
        }
    }

    async initialize(sheetName: string) {
        this.sheetName = sheetName;
        let isNewSheet = false;

        try {
            // Optimización: getSpreadsheetMetadata es más completo que solo traer nombres
            const metadata = await this.spreadsheetService.getSpreadsheetMetadata();
            const existingSheets = metadata.sheets.map(s => s.properties.title);

            if (!existingSheets.includes(this.sheetName)) {
                this.logger.warn(`🚀 Pestaña "${this.sheetName}" no encontrada. Creándola...`);
                await this.spreadsheetService.createSheet(
                    this.optionsDatabase.defaultSpreadsheetId,
                    this.sheetName
                );
                isNewSheet = true;

                // El "respiro" es vital para evitar errores de propagación en Google
                await new Promise(res => setTimeout(res, 1500));
            }

            // Importante: syncSchema debe usar this.sheetName internamente ahora
            await this.syncSchema(isNewSheet);

        } catch (error) {
            this.logger.error(`❌ Error en inicialización de ${this.sheetName}: ${error.message}`);
            throw error; // Re-lanzar para que el orquestador sepa que falló
        }
    }


}