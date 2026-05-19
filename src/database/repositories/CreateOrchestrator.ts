// @database/engines/create.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ICreateOrchestrator } from "./interfaces/repositories.contracts";

@Injectable()
export class CreateOrchestrator implements ICreateOrchestrator {
    private readonly logger = new Logger(CreateOrchestrator.name);

    async execute<T extends object>(
        repository: SheetsRepository<T>,
        docData: Partial<T>
    ): Promise<SheetDocument<T>> {

        // 1. Instanciar la entidad (Pattern: Entity Factory)
        const entityInstance = new repository.entityClass();
        Object.assign(entityInstance, docData);

        // 2. Persistencia física
        const savedData = await repository.ctx.persistenceEngine.save(entityInstance);

        // 3. Hidratación y Blindaje (Delegado al Hydrator)
        // El Hydrator ya incluye la lógica de 'bypass' y 'toJSON' que tenías en el repo.
        const hydratedDoc = repository.ctx.hydrator.hydrateAndShield(
            repository.entityClass,
            repository,
            savedData
        );

        if (!hydratedDoc) {
            this.logger.warn(`[CreateOrchestrator] Documento vacío tras hidratación para ${repository.entityClass.name}`);
            return savedData as unknown as SheetDocument<T>;
        }

        return hydratedDoc;
    }
}