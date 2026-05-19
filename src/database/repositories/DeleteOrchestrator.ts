// @database/engines/delete.orchestrator.ts
import { Injectable } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";

@Injectable()
export class DeleteOrchestrator {
    async execute<T extends object>(
        repository: SheetsRepository<T>,
        idOrEntity: string | number | T
    ): Promise<void> {
        // Aquí podrías añadir lógica previa de "Cascade Delete" si fuera necesario
        await repository.ctx.persistenceEngine.delete(idOrEntity);
    }
}