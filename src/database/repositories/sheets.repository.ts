import { RepositoryContext } from "./repository.context";
import { ClassType, FilterQuery, UpdateAggregationPipeline, UpdateQuery } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { DocumentQuery } from "@database/engines/document.query";
import { deepClone, SheetDocument } from "@database/wrapper/sheet.document";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { ISheetsRepository, UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { VirtualType } from "@database/interfaces/virtual.type";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ProjectionService } from "@database/services/projection.seervice";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";
import { createModel } from "@database/factory/model.factory";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { SHEETS_ALL_RELATIONS, SHEETS_RELATIONS_LIST } from "@database/constants/metadata.constants";

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
    private cachedModel: any = null;
    constructor(
        public readonly entityClass: ClassType<T>,
        protected readonly ctx: RepositoryContext<T>,
        protected readonly virtuals: Record<string, VirtualType> = {}
    ) {
        // Marca interna para tu DiscoveryService
        (this as any).__isSheetsRepository = true;
    }
    /**
     * Devuelve el modelo Active Record asociado a este repositorio.
     * Requerido por el PersistenceEngine para resolver flujos compuestos.
     */
    public getModel(): any {
        if (!this.cachedModel) {
            // Reutiliza tu función legítima del core para empaquetar la entidad y este repositorio
            this.cachedModel = createModel(this.entityClass, this);
        }
        return this.cachedModel;
    }

    // ==========================================
    // MÉTODOS DE LECTURA (Delegan al GettersEngine)
    // ==========================================
    /**
 * findOneAndUpdateRelational: Realiza un Upsert profundo y relacional.
 * Modifica o inserta el documento padre en su pestaña y propaga de forma ordenada 
 * las mutaciones hacia sus subcolecciones hijas físicas en Google Sheets.
 */
    /**
 * findOneAndUpdateRelational: Ejecuta un Upsert atómico en la entidad cabecera (Padre)
 * y propaga de forma recursiva y en lote las mutaciones hacia las pestañas de sus @SubCollection.
 */
    /**
     * findOneAndUpdateRelational: Ejecuta un Upsert atómico en la entidad cabecera (Padre)
     * y propaga de forma recursiva y en lote las mutaciones hacia las pestañas de sus @SubCollection.
     */
    async findOneAndUpdateRelational(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any, // Soportamos operadores complejos
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        try {
            this.logger.log('\n--- 🛠️ INICIO OPERACIÓN FIND_ONE_AND_UPDATE_RELATIONAL ---');

            // 1. Identificar si operamos con $set (reemplazo/lote completo) o con $push (adición individual)
            const isPushOperation = !!updateData.$push;

            // Clonación defensiva del cuerpo principal que se enviará al Padre
            const payloadRaw = updateData.$set
                ? { ...updateData.$set }
                : (!updateData.$push ? { ...updateData } : {});

            const entityProto = this.entityClass.prototype;
            const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, entityProto) || [];
            const isolatedSubCollections: { [key: string]: { config: any; data: any[]; operation: 'SET' | 'PUSH' } } = {};

            // 2. Extraer los datos relacionales según el operador utilizado
            for (const field of relationsList) {
                // Caso A: El usuario envía un lote completo para pisar la subcolección ($set o payload plano)
                if (payloadRaw[field] !== undefined) {
                    const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
                    isolatedSubCollections[field] = {
                        config,
                        data: Array.isArray(payloadRaw[field]) ? payloadRaw[field] : [payloadRaw[field]],
                        operation: 'SET'
                    };
                    delete payloadRaw[field]; // Limpiamos para que no rompa la persistencia del padre
                }

                // Caso B: 🚀 NUEVO: El usuario quiere empujar una marca individual ($push)
                if (updateData.$push && updateData.$push[field] !== undefined) {
                    const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
                    const pushData = updateData.$push[field];

                    isolatedSubCollections[field] = {
                        config,
                        data: Array.isArray(pushData) ? pushData : [pushData],
                        operation: 'PUSH'
                    };
                }
            }

            // 3. Sincronizar o asegurar la existencia de la fila cabecera (Padre)
            this.logger.log(`[RelationalEngine] Sincronizando fila cabecera en pestaña: [${this.sheetName}]`);

            // Si es una operación puramente de $push a los hijos, el padre solo necesita un objeto vacío o parcial para el upsert
            const padreDocumento = await this.findOneAndUpdate(
                filter,
                (isPushOperation && Object.keys(payloadRaw).length === 0) ? { estadoEliminado: false } as any : payloadRaw,
                options
            );

            if (!padreDocumento) {
                this.logger.warn('[RelationalEngine] Operación abortada: No se localizó ni creó la fila del documento padre.');
                return null;
            }

            // 4. Propagar las mutaciones hacia cada subcolección física hija
            for (const field of Object.keys(isolatedSubCollections)) {
                const { config, data, operation } = isolatedSubCollections[field];
                const localValue = (padreDocumento as any)[config.localField] ?? (padreDocumento as any).id;

                const childRepository = (this.ctx as any).moduleRef
                    ? (this.ctx as any).moduleRef.get(config.childRepository || config.targetRepository, { strict: false })
                    : null;

                if (!childRepository) continue;

                for (const rawHijo of data) {
                    const hijo = deepClone(rawHijo) as any;
                    hijo[config.joinColumn] = localValue;
                    delete (hijo as any).__row;

                    const childPrimaryKey = (childRepository as any).metadata?.primaryKey || 'id';

                    // Configuración dinámica del filtro del hijo
                    let filtroHijo: any;

                    if (operation === 'PUSH' && !hijo[childPrimaryKey]) {
                        // Si es un $push y no viene un ID de marca predefinido, dejamos que cree una fila nueva limpia
                        // usando campos de coincidencia lógica para evitar duplicar el mismo evento en re-intentos HTTP
                        filtroHijo = {
                            [config.joinColumn]: localValue,
                            ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {},
                            ...hijo.hora ? { hora: hijo.hora } : {}
                        };
                    } else {
                        // Si es un $set o trae PrimaryKey estricta ("DNI_FECHA_TIPO")
                        filtroHijo = hijo[childPrimaryKey]
                            ? { [childPrimaryKey]: hijo[childPrimaryKey] }
                            : { [config.joinColumn]: localValue, ...hijo.fecha ? { fecha: hijo.fecha } : {}, ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {} };
                    }

                    const childEntityClass = (childRepository as any).entityClass;
                    if (childEntityClass) {
                        filtroHijo = QueryNormalizer.normalize(childEntityClass, filtroHijo);
                    }

                    // Mutación atómica en la pestaña subordinada de Google Sheets
                    await (childRepository as any).findOneAndUpdate(
                        filtroHijo,
                        hijo,
                        { upsert: true, new: true }
                    );
                }
            }

            // 5. Re-hidratar el árbol completo en memoria antes de retornar
            this.logger.log(`[RelationalEngine] Re-hidratando jerarquía completa de datos sobre el documento vivo...`);
            for (const relField of relationsList) {
                await this.populate(padreDocumento as any, relField);
            }

            return padreDocumento;

        } catch (error: any) {
            this.logger.error(`[RelationalEngine] ❌ ERROR: ${error.message}`);
            throw error;
        }
    }

    async find(
        filter: FilterQuery<T> = {},
        options: QueryOptions = {}
    ): Promise<SheetDocument<T>[]> {
        const cleanFilter = QueryNormalizer.normalize(this.entityClass, filter);
        // Instanciamos el Query pasando exactamente los 5 parámetros requeridos por tu constructor
        const query = new DocumentQuery<T, SheetDocument<T>[]>(
            this.entityClass,                               // 1. Clase constructora
            cleanFilter,                                         // 2. Criterios de filtrado NoSQL
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
        // 🚀 MAGIA: El filtro se autolimpia y autocastea aquí antes de ir al QueryEngine físico
        const cleanFilter = QueryNormalizer.normalize(this.entityClass, filter);
        const rawData = await this.ctx.gettersEngine.findOne(cleanFilter);
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
        updateData: UpdateQuery<T> | UpdateAggregationPipeline,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        try {
            this.logger.log('\n--- 🛠️ [DEBUG REPOSITORY] INICIO FIND_ONE_AND_UPDATE ---');
            this.logger.log(`[DEBUG 1] Entidad objetivo: ${this.entityClass.name}`);
            this.logger.log(`[DEBUG 2] Query de búsqueda: ${JSON.stringify(filter)}`);
            this.logger.log(`[DEBUG 3] Opciones aplicadas: ${JSON.stringify(options)}`);

            let savedData: any = null;
            let oldDataDataFlat: any = null;

            // =========================================================================
            // 🚀 BIFURCACIÓN A: EL UPDATE ES UN PIPELINE DE AGREGACIÓN (ARRAY)
            // =========================================================================
            if (Array.isArray(updateData)) {
                this.logger.log('[Repository] ⚡ Detectada mutación basada en Pipeline de Agregación.');

                const currentDoc = await this.findOne(filter);

                if (!currentDoc && !options.upsert) {
                    this.logger.warn('[Repository] Registro no localizado y "upsert" es false. Abortando.');
                    return null;
                }

                oldDataDataFlat = currentDoc ? currentDoc.toObject() : null;
                const rawRecord = currentDoc ? currentDoc.toObject() : { ...filter };

                this.logger.log('[Repository] Delegando transformación secuencial al QueryEngine...');

                const pipelineResult = await this.ctx.queryEngine.aggregate(
                    [rawRecord],
                    updateData
                );

                if (!pipelineResult || pipelineResult.length === 0) {
                    this.logger.error('[Repository] ❌ El queryEngine devolvió una colección vacía.');
                    return null;
                }

                const mutatedData = pipelineResult[0];
                delete mutatedData.__row;

                const entityInstance = new this.entityClass();
                Object.assign(entityInstance, mutatedData);

                this.logger.log('[Repository] Enviando entidad procesada al PersistenceEngine...');
                savedData = await this.ctx.persistenceEngine.save(entityInstance);

                // =========================================================================
                // 🧩 BIFURCACIÓN B: FLUJO ORDINARIO CLÁSICO (OBJETO CONVENCIONAL)
                // =========================================================================
            } else {
                this.logger.log('[Repository] Procesando actualización transaccional de objeto clásico.');

                if (options.new === false) {
                    const preDoc = await this.findOne(filter);
                    oldDataDataFlat = preDoc ? preDoc.toObject() : null;
                }

                this.logger.log('[Repository] Invocando directo a la persistencia del motor...');
                savedData = await this.ctx.persistenceEngine.findOneAndUpdate(filter, updateData, options);
            }

            if (!savedData) {
                this.logger.warn('[Repository] ⚠️ El motor de persistencia devolvió un valor nulo o vacío.');
                return null;
            }

            const dataToHydrate = (options.new === false && oldDataDataFlat) ? oldDataDataFlat : savedData;

            this.logger.log('[Repository] Intentando pasar el resultado por el Hydrator...');
            const hydratedDoc = this.hydrate(dataToHydrate as Partial<T>);

            // 🔥 PROTECCIÓN TRANSACCIONAL ANTI-VACIADO POR PROXY
            if (!hydratedDoc || Object.keys(hydratedDoc).length === 0) {
                this.logger.warn('[Repository] ⚠️ ¡ALERTA! El documento hidratado quedó vacío. Aplicando bypass con datos planos.');
                return dataToHydrate as any;
            }

            // =========================================================================
            // 🛡️ ESCUDO ARQUITECTÓNICO DEFINITIVO ANTI-REFERENCIAS CIRCULARES EN EXPRESS
            // =========================================================================
            // Inyectamos dinámicamente un método 'toJSON' en el objeto de retorno.
            // Cuando Express/JSON.stringify intente serializar el SheetDocument, usará automáticamente
            // este método, aislando las propiedades primitivas puras y ocultando los motores asíncronos.
            Object.defineProperty(hydratedDoc, 'toJSON', {
                value: function () {
                    const plainObject = {} as any;

                    // Extraemos el snapshot real de datos planos de la entidad
                    const baseData = this.entity || this._snapshot || dataToHydrate;

                    // Clonamos de forma segura solo las propiedades enumerables primitivas
                    Object.keys(baseData).forEach(key => {
                        if (!key.startsWith('_')) {
                            plainObject[key] = baseData[key];
                        }
                    });

                    // Si la fila operacional existe en el wrapper, la exponemos de forma segura
                    if (this.__row) plainObject.__row = this.__row;
                    else if (dataToHydrate.__row) plainObject.__row = dataToHydrate.__row;

                    return plainObject;
                },
                enumerable: false, // Evita que se liste en bucles iterativos ordinarios
                configurable: true
            });

            this.logger.log('[Repository] Retornando documento hidratado con blindaje de serialización (toJSON).');
            this.logger.log('--- 🛠️ FIN OPERACIÓN FIND_ONE_AND_UPDATE ---\n');

            return hydratedDoc;

        } catch (error: any) {
            this.logger.error(`[Repository] ❌ ERROR CRÍTICO EN FIND_ONE_AND_UPDATE: ${error.message}`);
            throw error;
        }
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
    // Dentro de tu clase SheetsRepository
    public getPersistenceEngine() {
        // Exponemos el motor que ya vive de manera nativa dentro del contexto construido por la factoría
        return this.ctx.persistenceEngine;
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