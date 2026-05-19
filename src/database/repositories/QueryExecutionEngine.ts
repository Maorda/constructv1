// @database/engines/query-execution.engine.ts
import { Injectable } from "@nestjs/common";
import { FilterQuery } from "@database/types/query.types";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { SheetsRepository } from "../repositories/sheets.repository";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";
import { IQueryExecutionEngine } from "./interfaces/repositories.contracts";


@Injectable()
export class QueryExecutionEngine implements IQueryExecutionEngine {

    async findMany<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T> = {},
        options: QueryOptions = {}
    ): Promise<SheetDocument<T>[]> {
        const ctx = (repository as any).ctx;
        const cleanFilter = QueryNormalizer.normalize(repository.entityClass, filter);

        // Instanciamos el Query pasando exactamente los 5 parámetros requeridos
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

        // Utilizamos el nuevo Hydrator que centraliza la protección toJSON
        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, projectedData);
    }

    async findById<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number
    ): Promise<SheetDocument<T> | null> {
        const ctx = (repository as any).ctx;
        const rawData = await ctx.gettersEngine.findById(id);
        if (!rawData) return null;

        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, rawData);
    }

    async findAll<T extends object>(
        repository: SheetsRepository<T>
    ): Promise<SheetDocument<T>[]> {
        const ctx = (repository as any).ctx;
        const allData = await ctx.gettersEngine.findAll(repository.entityClass);

        return allData.map((data: any) =>
            ctx.hydrator.hydrateAndShield(repository.entityClass, repository, data)
        ).filter(Boolean) as SheetDocument<T>[];
    }
}