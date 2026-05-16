import { RepositoryContext } from "./repository.context";
import { ClassType, FilterQuery, UpdateQuery } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { ISheetsRepository, UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { VirtualType } from "@database/interfaces/virtual.type";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ProjectionService } from "@database/services/projection.seervice";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";

/*
* SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
* Funciona como el 'Model' de Mongoose.
* Es el punto de entrada oficial para cualquier operación con los datos de Google Sheets y actúa
* como una "Fábrica de Entidades Inteligentes".
* En términos sencillos: el Repositorio es quien saca los datos del "mundo frío" de las tablas de
* Google Sheets y los convierte en objetos vivos con "superpoderes" en tu código.
*/

/**
 * sheets-repository.ts (Equivalente al Model de Mongoose)
 * SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
 * Funciona como el 'Model' de Mongoose.
 */

export class SheetsRepository<T extends object> implements ISheetsRepository<T> {
    private readonly logger = new Logger(SheetsRepository.name);
    constructor(
        public readonly entityClass: ClassType<T>,
        protected readonly ctx: RepositoryContext<T>,
        protected readonly virtuals: Record<string, VirtualType> = {}
    ) {
        // Marca interna para tu DiscoveryService
        (this as any).__isSheetsRepository = true;
    }

    // ==========================================
    // MÉTODOS DE LECTURA (Delegan al GettersEngine)
    // ==========================================

    async find(
        filter: FilterQuery<T> = {},
        options: QueryOptions = {}
    ): Promise<SheetDocument<T>[]> {

        // Instanciamos el Query pasando exactamente los 5 parámetros requeridos por tu constructor
        const query = new DocumentQuery<T, SheetDocument<T>[]>(
            this.entityClass,                               // 1. Clase constructora
            filter,                                         // 2. Criterios de filtrado NoSQL
            (this.ctx as any).projectionService || null,    // 3. El servicio de proyección esperado (Clave del error)
            this.ctx,                                       // 4. El contexto completo de motores (RepositoryContext)
            this                                            // 5. Instancia de este repositorio
        ).findMany(); // Marcamos internamente que esperamos una colección (_isMany = true)

        if (options.projection) query.select(options.projection);
        if (options.limit) query.limit(options.limit);
        if (options.offset) query.offset(options.offset);
        if (options.sort) query.sort(options.sort.field, options.sort.order);

        // Retornamos el objeto query. Como implementa `PromiseLike`, cuando el usuario ejecute 
        // un `await repo.find(...)`, Node.js llamará de forma nativa e interna a su método `.then()`.
        return query as unknown as Promise<SheetDocument<T>[]>;
    }
    /**
     * Busca un único registro que coincida con los criterios del filtro y devuelve un Documento Vivo.
     */
    async findOne(filter: FilterQuery<T> = {}, projection?: any): Promise<SheetDocument<T> | null> {
        const rawData = await this.ctx.gettersEngine.findOne(filter);
        if (!rawData) return null;

        // El GettersEngine ya delega internamente la aplicación de proyecciones
        const projectedData = projection
            ? this.ctx.gettersEngine.applyProjection(rawData, projection)
            : rawData;

        return this.hydrate(projectedData as Partial<T>);
    }

    // ==========================================
    // MÉTODOS DE ESCRITURA (Delegan al PersistenceEngine)
    // ==========================================

    // =========================================================================
    // MÉTODOS DE ESCRITURA Y MUTACIÓN (Delegan al PersistenceEngine)
    // =========================================================================

    /**
     * Guarda o actualiza una instancia pura de la entidad en la base de datos distribuida.
     */
    async save(entity: T): Promise<T> {
        return await this.ctx.persistenceEngine.save(entity);
    }

    /**
     * Busca una fila y aplica mutaciones atómicas parciales o completas basándose en operadores de actualización.
     */
    async findOneAndUpdate(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T>,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        // Buscamos la fila física usando el motor de comparaciones unificado
        const rawData = await this.ctx.gettersEngine.findOneInternal(
            filter,
            this.ctx.compareEngine
        );

        if (!rawData) {
            if (options.upsert) {
                this.logger.log(`[Upsert] Registro no localizado para filtro. Creando nueva instancia.`);
                const newData = await this.ctx.persistenceEngine.save(updateData as T);
                return this.hydrate(newData as Partial<T>);
            }
            return null;
        }

        const idValue = (rawData as any).id ?? (rawData as any)._id ?? (rawData as any).__row;
        const updatedData = await this.ctx.persistenceEngine.update(idValue, updateData);

        return this.hydrate(options.new ? updatedData : rawData);
    }

    async softDelete(entity: T): Promise<void> {
        return await this.ctx.persistenceEngine.delete(entity);
    }

    // ==========================================
    // MÉTODOS DE PROCESAMIENTO (Delegan a AggregationEngine)
    // ==========================================

    /**
     * Ejecuta un pipeline de agregación al estilo MongoDB
     * Útil para cruzar Obreros con Asistencias o sumar Presupuestos.
     */
    // =========================================================================
    // PIPELINES DE AGREGACIÓN (Delegan a AggregationEngine)
    // =========================================================================

    /**
     * Ejecuta agregaciones avanzadas de datos y cruces masivos en memoria al estilo de un pipeline NoSQL.
     */
    async aggregate(pipeline: any[]): Promise<any[]> {
        const allData = await this.ctx.gettersEngine.findInternal(
            {},
            this.ctx.compareEngine
        );

        return await this.ctx.aggregationEngine.run(allData, pipeline);
    }

    /**
     * Crea una nueva instancia de un documento (new Model())
     */
    /**
 * Crea una instancia del documento en memoria.
 * No persiste datos en Google Sheets.
 */
    // =========================================================================
    // FACTORIES E INFRAESTRUCTURA INTERNA
    // =========================================================================

    /**
     * Instancia un Documento Vivo en memoria sin impacto inmediato en la API de Google.
     */
    createInstanceSheet(data?: Partial<T>): ISheetDocument<T> {
        return new SheetDocument<T>((data || {}) as T, this, true) as unknown as ISheetDocument<T>;
    }




    /**
     * Inicializa las cabeceras y estructura de caché de la pestaña correspondiente de Google Sheets.
     */
    async initialize(): Promise<void> {
        await this.ctx.gateway.initialize(this.entityClass);
    }

    /**
     * Genera un constructor de consultas nativas fluidas (Query Builder).
     */
    createQueryBuilder(): QueryBuilder<T> {
        return new QueryBuilder(
            this.entityClass,
            this.ctx.queryEngine,
            this.ctx.gettersEngine,
            this.ctx.options
        );
    }
    /**
 * Recibe un ID y un objeto con campos parciales, y delega la 
 * actualización optimizada al motor de persistencia.
 */
    /**
 * Actualiza de forma optimizada solo los campos que han cambiado.
 * @param id El identificador único del registro.
 * @param changes El delta de cambios (campos modificados).
 */
    /**
     * Actualiza de forma optimizada en lote (Batch Update) solo las columnas que sufrieron cambios detectados.
     */
    async updatePartial(id: string | number, changes: Partial<T>): Promise<SheetDocument<T>> {
        // Corrección de nombre de método según la API de tu GettersEngine unificado
        const rowIndex = await this.ctx.gettersEngine.getRowIndexById(id);

        if (rowIndex === -1) {
            throw new NotFoundException(
                `No se pudo realizar la actualización parcial. El registro con ID "${id}" no existe en la hoja física.`
            );
        }

        if (Object.keys(changes).length > 0) {
            await this.ctx.persistenceEngine.updatePartialBatch(rowIndex, changes);
            this.logger.debug(`[UpdatePartial] ID ${id} persistido con éxito en la fila de datos ${rowIndex + 2}`);
        }

        const freshData = await this.findById(id);
        if (!freshData) {
            throw new NotFoundException(`Error de concurrencia: El registro con ID "${id}" desapareció tras la mutación.`);
        }

        return freshData;
    }

    /**
     * Recupera un registro único directamente utilizando su Primary Key indexada.
     */
    async findById(id: string | number): Promise<SheetDocument<T> | null> {
        const rawData = await this.ctx.gettersEngine.findById(id);
        if (!rawData) return null;

        return this.hydrate(rawData as Partial<T>);
    }




    /**
     * Retorna el nombre limpio de la pestaña física controlada por este repositorio.
     */
    get sheetName(): string {
        return this.ctx.sheetName;
    }

    /**
     * Elimina registros basados en un filtro
     */
    /**
     * Ejecuta una destrucción lógica (Soft Delete) o física dependiendo de la entidad.
     */
    async delete(idOrEntity: string | number | T): Promise<void> {
        return await this.ctx.persistenceEngine.delete(idOrEntity);
    }

    /**
     * Devuelve la totalidad de los registros activos mapeados de la pestaña de Google Sheets.
     */
    async findAll(): Promise<SheetDocument<T>[]> {
        const allData = await this.ctx.gettersEngine.findAll(this.entityClass);
        return allData.map(data => this.hydrate(data as Partial<T>));
    }

    async findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<ISheetDocument<T>> {
        const existing = await this.findOne(filter as FilterQuery<T>);
        if (existing) return existing;

        const combinedData = { ...defaults, ...filter };

        // Uso claro de la factoría de instancias
        const doc = this.createInstanceSheet(combinedData as Partial<T>);

        return await doc.save() as unknown as ISheetDocument<T>;
    }
    /**
     * Encapsulador síncrono para adjuntar métodos de persistencia (.save(), .delete()) a objetos de datos.
     */
    createDocument(data: T): ISheetDocument<T> {
        return new SheetDocument<T>(data, this, false) as unknown as ISheetDocument<T>;
    }
    // Dentro de SheetsRepository<T>
    /**
     * Enlaza una entidad con sus datos referenciados.
     * Este método es el puente entre el Repositorio y el RelationalEngine.
     * @param instance La entidad viva (probablemente envuelta en SheetDocument).
     * @param path El nombre de la propiedad a relacionar (ej: 'obras').
     */
    /**
     * Hidrata de forma perezosa relaciones foráneas declaradas en metadatos (.populate()).
     */
    async populate(instance: T, path: string): Promise<T> {
        return await this.ctx.relationalEngine.populate(instance, path);
    }
    /**
     * Transforma filas de objetos planos en instancias tipadas nativas y controladas por el ORM.
     */
    private hydrate(data: Partial<T>): SheetDocument<T> {
        const instance = new this.entityClass();
        Object.assign(instance, data);
        return new SheetDocument<T>(instance as T, this, false);
    }

    /**
     * Crea un nuevo registro en la hoja de cálculo y devuelve el Documento Vivo hidratado.
     */
    async create(docData: Partial<T>): Promise<SheetDocument<T>> {
        try {
            console.log('\n--- 🛠️ INICIO OPERACIÓN CREATE ---');
            console.log('[Repository] Payload recibido de Insomnia:', docData);

            // 1. Validar si la clase se instancia bien
            const entityInstance = new this.entityClass();
            Object.assign(entityInstance, docData);
            console.log('[Repository] Instancia de la Entidad cargada:', entityInstance);

            // 2. Ejecutar la persistencia física
            console.log('[Repository] Invocando al PersistenceEngine...');
            const savedData = await this.ctx.persistenceEngine.save(entityInstance);
            console.log('[Repository] Datos devueltos por el PersistenceEngine (Post-Save):', savedData);

            // 3. Evaluar el proceso de Hidratación
            console.log('[Repository] Intentando hidratar el documento vivo...');
            const hydratedDoc = this.hydrate(savedData as Partial<T>);
            console.log('[Repository] Objeto Hidratado final:', hydratedDoc);

            // 4. BYPASS CON CAST: Forzamos el escape con 'as any' para burlar el compilador
            // y poder ver en Insomnia el objeto real si es que 'hydrate' lo vacía.
            if (!hydratedDoc || Object.keys(hydratedDoc).length === 0) {
                console.warn('[Repository] ⚠️ ¡ALERTA! El documento hidratado quedó vacío. Aplicando bypass con datos planos.');
                return savedData as any;
            }

            return hydratedDoc;
        } catch (error) {
            console.error('[Repository] ❌ ERROR CRÍTICO EN REPOSITORY.CREATE:', error);
            throw error;
        } finally {
            console.log('--- 🛠️ FIN OPERACIÓN CREATE ---\n');
        }
    }
}