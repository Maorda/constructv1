// @database/engines/update-partial.orchestrator.ts
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { IUpdatePartialOrchestrator } from "./interfaces/repositories.contracts";

@Injectable()
export class UpdatePartialOrchestrator implements IUpdatePartialOrchestrator {
    private readonly logger = new Logger(UpdatePartialOrchestrator.name);

    async execute<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number,
        changes: Partial<T>
    ): Promise<SheetDocument<T>> {

        const ctx = repository.ctx;

        // 1. Obtener índice físico
        const rowIndex = await ctx.gettersEngine.getRowIndexById(id);

        if (rowIndex === -1) {
            throw new NotFoundException(
                `[UpdatePartialOrchestrator] No se pudo realizar la actualización parcial. El registro con ID "${id}" no existe.`
            );
        }

        // 2. Persistencia por lotes si hay cambios
        if (Object.keys(changes).length > 0) {
            await ctx.persistenceEngine.updatePartialBatch(rowIndex, changes);
            this.logger.debug(`[UpdatePartialOrchestrator] ID ${id} persistido en fila ${rowIndex + 2}`);
        }

        // 3. Re-hidratación mediante el repositorio
        const freshData = await repository.findById(id);

        if (!freshData) {
            throw new NotFoundException(`[UpdatePartialOrchestrator] Error de concurrencia: El registro con ID "${id}" desapareció tras la mutación.`);
        }

        return freshData;
    }
}