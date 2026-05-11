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
    /**
     * Acceso directo al Modelo estilo Mongoose (Active Record)
     * Permite hacer: repo.Model.findOne(...) o new repo.Model(...)
     */
    get Model() {
        return this.ctx.Model;
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
            this.ctx
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
        const rawData = await this.ctx.gettersEngine.findOne(filter);
        if (!rawData) return null;

        // "Hidratamos" el objeto plano para que tenga .save() y .softDelete()
        return this.create(rawData as Partial<T>);
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
                return await this.create(updateData);
            }
            return null;
        }

        // 3. ACTUALIZAR: Delegamos al PersistenceEngine usando el ID o __row encontrado
        const idValue = rawData.id ?? rawData._id ?? rawData.__row;

        // El motor de persistencia debe devolvernos la data actualizada de la hoja
        const updatedData = await this.ctx.persistenceEngine.update(idValue, updateData);

        // 4. HIDRATAR: Devolvemos un Documento Vivo para que el usuario pueda seguir operando
        const instance = new this.entityClass();
        Object.assign(instance, options.new ? updatedData : rawData);

        return new SheetDocument(
            instance,
            this,
            false
        );
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




    async initialize(sheetName: string): Promise<void> {
        // El repositorio solo le pide al gateway que haga su trabajo
        await this.ctx.gateway.initialize(sheetName);
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
        const rawData = await this.ctx.gettersEngine.findByRowId(id);

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
    async delete(filter: any): Promise<void> {
        return await this.ctx.persistenceEngine.delete(this.entityClass, filter, this.ctx);
    }

    async findAll(): Promise<ISheetDocument<T>[]> {
        const allData = await this.ctx.gettersEngine.findAll(this.entityClass);

        // Mapeamos cada resultado a un nuevo envoltorio
        return allData.map(data => new SheetDocument<T>(
            data,
            this.entityClass
        ));
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
}