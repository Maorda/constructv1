// @database/engines/orchestrators/query.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { FilterQuery } from "@database/types/query.types";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";

@Injectable()
export class QueryOrchestrator {
    private readonly logger = new Logger(QueryOrchestrator.name);

    async find<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T> = {},
        options: QueryOptions = {}
    ): Promise<SheetDocument<T>[]> {
        // Ejecuta la consulta usando tus motores de consulta existentes
        const rawEntities = await repository.ctx.queryEngine.find(repository.entityClass, filter, options);

        // El orquestador centraliza el mapeo masivo a documentos vivos (Active Record)
        return rawEntities.map(entity => repository.createDocument(entity));
    }

    async findOne<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T> = {}
    ): Promise<SheetDocument<T> | null> {
        const rawEntity = await repository.ctx.queryEngine.findOne(repository.entityClass, filter);
        return rawEntity ? repository.createDocument(rawEntity) : null;
    }
}