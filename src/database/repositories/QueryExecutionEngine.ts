// @database/engines/query-execution.engine.ts
import { Injectable } from "@nestjs/common";
import { FilterQuery } from "@database/types/query.types";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { SheetsRepository } from "../repositories/sheets.repository";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";


@Injectable()
export class QueryExecutionEngine {

    /**
     * Ejecuta una consulta NoSQL compleja construyendo un DocumentQuery fluido.
     */
    async findMany<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T> = {},
        options: QueryOptions = {}
    ): Promise<SheetDocument<T>[]> {
        const ctx = (repository as any).ctx;
        const cleanFilter = QueryNormalizer.normalize(repository.entityClass, filter);

        const query = new DocumentQuery<T, SheetDocument<T>[]>(
            repository.entityClass,
            cleanFilter,
            ctx.projectionService || null,
            ctx,
            repository
        ).findMany();

        if (options.projection) query.select(options.projection);
        if (options.limit) query.limit(options.limit);
        if (options.offset) query.offset(options.offset);
        if (options.sort) query.sort(options.sort.field, options.sort.order);

        return query as unknown as Promise<SheetDocument<T>[]>;
    }

    /**
     * Recupera un único registro aplicando filtros y proyecciones dinámicas.
     */
    async findOne<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T> = {},
        projection?: any
    ): Promise<SheetDocument<T> | null> {
        const ctx = (repository as any).ctx;
        const cleanFilter = QueryNormalizer.normalize(repository.entityClass, filter);

        const rawData = await ctx.gettersEngine.findOne(cleanFilter);
        if (!rawData) return null;

        const projectedData = projection
            ? ctx.gettersEngine.applyProjection(rawData, projection)
            : rawData;

        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, projectedData);
    }

    /**
     * Busca un elemento de forma atómica usando su Primary Key indexada.
     */
    async findById<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number
    ): Promise<SheetDocument<T> | null> {
        const ctx = (repository as any).ctx;
        const rawData = await ctx.gettersEngine.findById(id);
        if (!rawData) return null;

        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, rawData);
    }

    /**
     * Devuelve toda la colección mapeada de la pestaña.
     */
    async findAll<T extends object>(repository: SheetsRepository<T>): Promise<SheetDocument<T>[]> {
        const ctx = (repository as any).ctx;
        const allData = await ctx.gettersEngine.findAll(repository.entityClass);

        return allData.map(data =>
            ctx.hydrator.hydrateAndShield(repository.entityClass, repository, data)
        ).filter(Boolean) as SheetDocument<T>[];
    }
}