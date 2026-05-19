// @database/engines/update.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { FilterQuery, UpdateQuery, UpdateAggregationPipeline } from "@database/types/query.types";
import { UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { IUpdateOrchestrator } from "./interfaces/repositories.contracts";

@Injectable()
export class UpdateOrchestrator implements IUpdateOrchestrator {
    private readonly logger = new Logger(UpdateOrchestrator.name);

    async execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | UpdateAggregationPipeline,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {

        let savedData: any = null;
        let oldDataFlat: any = null;
        const ctx = repository.ctx;

        // 1. Lógica de Agregación (Bifurcación A)
        if (Array.isArray(updateData)) {
            const currentDoc = await repository.findOne(filter);
            if (!currentDoc && !options.upsert) return null;

            oldDataFlat = currentDoc ? currentDoc.toObject() : null;
            const rawRecord = currentDoc ? currentDoc.toObject() : { ...filter };

            const pipelineResult = await ctx.queryEngine.aggregate([rawRecord], updateData);
            if (!pipelineResult || pipelineResult.length === 0) return null;

            const mutatedData = pipelineResult[0];
            delete mutatedData.__row;

            const entityInstance = new repository.entityClass();
            Object.assign(entityInstance, mutatedData);
            savedData = await ctx.persistenceEngine.save(entityInstance);
        }
        // 2. Lógica Clásica (Bifurcación B)
        else {
            if (options.new === false) {
                const preDoc = await repository.findOne(filter);
                oldDataFlat = preDoc ? preDoc.toObject() : null;
            }
            savedData = await ctx.persistenceEngine.findOneAndUpdate(filter, updateData, options);
        }

        if (!savedData) return null;

        // 3. Delegación de Hidratación y Blindaje al Hydrator ya existente
        const dataToHydrate = (options.new === false && oldDataFlat) ? oldDataFlat : savedData;

        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, dataToHydrate, {
            new: options.new,
            oldDataFlat
        });
    }
}