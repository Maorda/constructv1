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
        protected readonly virtuals: Record<string, VirtualType> = {},
        protected readonly projectionService: ProjectionService<T>, // Sin @Inject aquí
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
        // 1. Instanciamos el Query (Él es quien sabe cómo procesar todo)
        const query = new DocumentQuery<T, SheetDocument<T>[]>(
            this.entityClass,
            filter,
            this.projectionService,
            this.ctx,
            this
        ).findMany(); // Marcamos que queremos un Array

        // 2. Aplicamos las opciones de forma fluida
        if (options.projection) query.select(options.projection);
        if (options.limit) query.limit(options.limit);
        if (options.offset) query.offset(options.offset);
        if (options.sort) query.sort(options.sort.field, options.sort.order);

        // 3. RETORNO: Al ser el query una "PromiseLike", cuando el usuario haga 
        // await repo.find(), se disparará automáticamente el método .then() del query.
        return query as any;
    }

    async findOne(filter: FilterQuery<T> = {}, projection?: any): Promise<SheetDocument<T> | null> {
        // 1. Obtenemos la data cruda del motor
        const rawData = await this.ctx.gettersEngine.findOne(filter);
        if (!rawData) return null;

        // 2. Si hay proyección, filtramos las llaves antes de hidratar
        // (Opcional: Si tu gettersEngine ya maneja proyecciones, rawData vendrá filtrado)
        const projectedData = projection
            ? this.projectionService.applyProjection(rawData, projection)
            : rawData;

        // 3. Hidratamos el resultado
        return this.hydrate(projectedData as Partial<T>);
    }

    // ==========================================
    // MÉTODOS DE ESCRITURA (Delegan al PersistenceEngine)
    // ==========================================

    async save(entity: T): Promise<T> {
        return await this.ctx.persistenceEngine.save(entity);
    }

    async findOneAndUpdate(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T>,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        // 1. BUSCAR: Usamos el GettersEngine (vía findOneInternal) para localizar la fila física
        const rawData = await this.ctx.gettersEngine.findOneInternal(
            filter,
            this.ctx.compareEngine
        );

        // 2. CASO: NO EXISTE
        if (!rawData) {
            if (options.upsert) {
                this.logger.log('Registro no encontrado, ejecutando UPSERT...');
                // Si es upsert, creamos uno nuevo. 
                // Ojo: persistenceEngine.save suele ser mejor para esto
                const newData = await this.ctx.persistenceEngine.save(updateData as T);
                return this.hydrate(newData);

            }
            return null;
        }
        const idValue = rawData.id ?? rawData._id ?? rawData.__row;
        const updatedData = await this.ctx.persistenceEngine.update(idValue, updateData);

        return this.hydrate(options.new ? updatedData : rawData); // ✅ Limpio y tipado

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
    async aggregate(pipeline: any[]): Promise<any[]> {
        // 1. Obtenemos el CompareEngine desde el contexto.
        // Este motor es el que findInternal usará para evaluar los filtros.
        const compareEngine = this.ctx.compareEngine;

        // 2. Definimos el filtro base. 
        // Por defecto, solemos querer solo los ACTIVO para agregar, 
        // pero si tu pipeline maneja su propio $match, podemos pasar un filtro vacío {}.
        const baseFilter = {};

        /**
         * 3. Ejecución de findInternal.
         * @param baseFilter: {} - No filtramos nada a nivel de Sheets para que el AggregationEngine tenga toda la data.
         * @param compareEngine: La instancia requerida por el método.
         * @param options: Pasamos un objeto de opciones si tu interfaz lo permite.
         */
        const allData = await this.ctx.gettersEngine.findInternal(
            baseFilter,
            compareEngine,
        );

        // 4. Ejecutamos tu motor de agregación con la data recuperada.
        // Aquí es donde realmente se procesan los $match, $group, $project del pipeline.
        return await this.ctx.aggregationEngine.run(allData, pipeline);
    }

    /**
     * Crea una nueva instancia de un documento (new Model())
     */
    /**
 * Crea una instancia del documento en memoria.
 * No persiste datos en Google Sheets.
 */
    createInstanceSheet(data?: Partial<T>): ISheetDocument<T> {
        const instance = new SheetDocument<T>(
            (data || {}) as T,
            this,
            false
        );
        return instance as unknown as ISheetDocument<T>;
    }




    async initialize(): Promise<void> {
        // El repositorio solo le pide al gateway que haga su trabajo
        await this.ctx.gateway.initialize(this.entityClass);
    }

    createQueryBuilder(): QueryBuilder<T> {
        return new QueryBuilder(
            this.entityClass,
            this.ctx.queryEngine,   // El que procesa
            this.ctx.gettersEngine,  // El que trae los datos de Google/Caché
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
    async updatePartial(id: string | number, changes: Partial<T>): Promise<ISheetDocument<T>> {
        // 1. Localizamos la fila física en Google Sheets
        // Usamos el gettersEngine que ya tenemos en el contexto
        const rowIndex = await this.ctx.gettersEngine.findRowIndexById(id);

        if (rowIndex === -1) {
            throw new NotFoundException(
                `No se pudo realizar la actualización parcial. El registro con ID "${id}" no existe en la hoja corregir sheets.repository.updatePartial`
            );
        }

        // 2. Si no hay cambios reales en el objeto de entrada, evitamos la llamada a la API
        if (Object.keys(changes).length === 0) {
            return this.findById(id);
        }

        // 3. Delegamos al PersistenceEngine la actualización por lotes (Batch Update)
        // El motor se encargará de traducir cada propiedad a su columna (A, B, C...)
        await this.ctx.persistenceEngine.updatePartialBatch(rowIndex, changes);

        this.logger.debug(`[UpdatePartial] ID ${id} actualizado con éxito en la fila ${rowIndex + 2}`);

        // 4. Retornamos la entidad fresca y completa
        // Esto es vital para que el SheetDocument actualice su snapshot interno con los datos finales
        return await this.findById(id);
    }

    async findById(id: string | number): Promise<ISheetDocument<T> | null> {
        // 1. La búsqueda en Google Sheets/Caché es ASÍNCRONA (await)
        const rawData = await this.ctx.gettersEngine.findById(id);

        // 2. Si no hay datos, retornamos null
        if (!rawData) return null;

        // 3. La creación del "Documento" (el envoltorio) es SÍNCRONA
        // Pero como la función es 'async', el resultado se envuelve en una Promesa automáticamente
        return this.createDocument(rawData);
    }




    /**
     * Nombre de la hoja basado en la clase o metadata
     */
    get sheetName(): string {
        return this.entityClass.name;
    }

    /**
     * Elimina registros basados en un filtro
     */
    async delete(idOrEntity: string | number | T): Promise<void> {

        return await this.ctx.persistenceEngine.delete(idOrEntity);
    }

    async findAll(): Promise<ISheetDocument<T>[]> {
        const allData = await this.ctx.gettersEngine.findAll(this.entityClass);

        // Mapeamos cada resultado a un nuevo envoltorio
        return allData.map(data => this.hydrate(data));
    }

    async findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<ISheetDocument<T>> {
        const existing = await this.findOne(filter as FilterQuery<T>);
        if (existing) return existing;

        const combinedData = { ...defaults, ...filter };

        // Uso claro de la factoría de instancias
        const doc = this.createInstanceSheet(combinedData as Partial<T>);

        return await doc.save() as unknown as ISheetDocument<T>;
    }
    createDocument(data: T): ISheetDocument<T> {
        // Devolvemos envuelto para que el usuario pueda hacer .save()
        return new SheetDocument<T>(
            data,
            this,
            false,
        );
    }
    // Dentro de SheetsRepository<T>
    /**
     * Enlaza una entidad con sus datos referenciados.
     * Este método es el puente entre el Repositorio y el RelationalEngine.
     * @param instance La entidad viva (probablemente envuelta en SheetDocument).
     * @param path El nombre de la propiedad a relacionar (ej: 'obras').
     */
    async populate(instance: T, path: string): Promise<T> {
        // Delegamos la complejidad al motor que ya programaste
        return await this.ctx.relationalEngine.populate(instance, path);
    }
    // Agrega este método a tu SheetsRepository
    private hydrate(data: Partial<T>): SheetDocument<T> {
        // Creamos la instancia real de la clase (ej: new Obra())
        const instance = new this.entityClass();

        // Usamos un casteo a any solo para la hidratación inicial
        Object.assign(instance, data);

        /**
         * Retornamos el Documento Vivo.
         * @param instance La data hidratada
         * @param this El repositorio (para que .save() sepa a quién llamar)
         * @param false El flag 'isNew'. Al venir de la DB, no es un registro nuevo.
         */
        return new SheetDocument<T>(instance as T, this, false);
    }
}