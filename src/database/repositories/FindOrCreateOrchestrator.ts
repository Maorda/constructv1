// @database/engines/find-or-create.orchestrator.ts
import { Injectable } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { FilterQuery } from "@database/types/query.types";

@Injectable()
export class FindOrCreateOrchestrator {
    async execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: Partial<T>,
        defaults: Partial<T>
    ): Promise<SheetDocument<T>> {
        const existing = await repository.findOne(filter as FilterQuery<T>);
        if (existing) return existing;

        const combinedData = { ...defaults, ...filter };

        // Delegamos la creación al flujo normal de 'create'
        return await repository.create(combinedData as Partial<T>);
    }
}