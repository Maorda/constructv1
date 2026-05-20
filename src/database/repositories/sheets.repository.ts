import { RepositoryContext } from "./repository.context";
import { ClassType, FilterQuery, UpdateAggregationPipeline, UpdateQuery } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { ISheetsRepository, UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { VirtualType } from "@database/interfaces/virtual.type";
import { Logger } from "@nestjs/common";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";
import { createModel } from "@database/factory/model.factory";


export class SheetsRepository<T extends object> implements ISheetsRepository<T> {
    private readonly logger = new Logger(SheetsRepository.name);
    private cachedModel: any = null;
    constructor(
        public readonly entityClass: ClassType<T>,
        public readonly ctx: RepositoryContext<T>,
        protected readonly virtuals: Record<string, VirtualType> = {}
    ) {
        // Marca interna para tu DiscoveryService
        (this as any).__isSheetsRepository = true;
    }

    // 1. Ciclo de vida
    async initialize(): Promise<void> {
        await this.ctx.gateway.initialize(this.entityClass);
    }
    // 1. GESTIÓN DE METADATA (Se mantiene)
    get sheetName(): string { return this.ctx.sheetName; }

    // 2. ORQUESTADORES (Delegación total)
    async create(docData: Partial<T>): Promise<SheetDocument<T>> {
        return await this.ctx.createOrchestrator.execute(this, docData);
    }

    public getModel(): any {
        if (!this.cachedModel) {
            this.cachedModel = createModel(this.entityClass, this);
        }
        return this.cachedModel;
    }

    // =========================================================================
    // MÉTODOS DE LECTURA (Delegados al QueryExecutionEngine)
    // =========================================================================

    async find(filter: FilterQuery<T> = {}, options: QueryOptions = {}): Promise<SheetDocument<T>[]> {
        return await this.ctx.queryExecutionEngine.findMany(this, filter, options);
    }

    async findOne(filter: FilterQuery<T> = {}, projection?: any): Promise<SheetDocument<T> | null> {
        return await this.ctx.queryExecutionEngine.findOne(this, filter, projection);
    }

    async findById(id: string | number): Promise<SheetDocument<T> | null> {
        return await this.ctx.queryExecutionEngine.findById(this, id);
    }

    async findAll(): Promise<SheetDocument<T>[]> {
        return await this.ctx.queryExecutionEngine.findAll(this);
    }

    async findOneAndUpdateRelational(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        return await this.ctx.relationalUpsertOrchestrator.execute(this, filter, updateData, options);
    }

    async delete(idOrEntity: string | number | T): Promise<void> {
        return await this.ctx.deleteOrchestrator.execute(this, idOrEntity);
    }

    async findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<SheetDocument<T>> {
        return await this.ctx.findOrCreateOrchestrator.execute(this, filter, defaults);
    }

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
        return await this.ctx.updateOrchestrator.execute(this, filter, updateData, options);
    }

    async softDelete(entity: T): Promise<void> {
        return await this.ctx.persistenceEngine.delete(entity);
    }

    async aggregate(pipeline: any[]): Promise<any[]> {
        const allData = await this.ctx.gettersEngine.findInternal(
            {},
            this.ctx.compareEngine
        );

        return await this.ctx.aggregationEngine.run(allData, pipeline);
    }


    createInstanceSheet(data?: Partial<T>): ISheetDocument<T> {
        return new SheetDocument<T>((data || {}) as T, this, true) as unknown as ISheetDocument<T>;
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
     * Actualiza de forma optimizada en lote (Batch Update) solo las columnas que sufrieron cambios detectados.
     */
    async updatePartial(id: string | number, changes: Partial<T>): Promise<SheetDocument<T>> {
        return await this.ctx.updatePartialOrchestrator.execute(this, id, changes);
    }

    // 3. MÉTODOS DE APOYO (Delegados a motores)
    async populate(instance: T, path: string): Promise<T> {
        return await this.ctx.relationEngine.populate(instance, path);
    }
    // Nota: El método 'hydrate' privado se elimina, ahora usas:
    // this.ctx.hydrator.hydrateAndShield(...) en cualquier orquestador.

    createDocument(data: T): SheetDocument<T> {
        // Factory pattern básico, esto es aceptable mantenerlo aquí.
        return new SheetDocument<T>(data, this, false);
    }





}