// @database/engines/cascade-delete.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { SHEETS_ALL_RELATIONS, SHEETS_RELATIONS_LIST } from "@database/constants/metadata.constants";
import { SheetsRepository } from "../repositories/sheets.repository";

@Injectable()
export class CascadeDeleteOrchestrator {
    private readonly logger = new Logger(CascadeDeleteOrchestrator.name);

    constructor(private readonly moduleRef: ModuleRef) { }

    /**
     * Orquesta la eliminación completa de una entidad, limpiando primero 
     * en cascada todas sus subcolecciones subordinadas físicas (@SubCollection).
     */
    async execute<T extends object>(
        repository: SheetsRepository<T>,
        idOrEntity: string | number | T
    ): Promise<void> {
        try {
            this.logger.log('\n--- 🗑️ INICIO OPERACIÓN CASCADE_DELETE ---');

            // 🌟 SOLUCIÓN: Cambiamos a 'any' para unificar el manejo de 'T' plano y 'SheetDocument<T>'
            let entity: any = null;

            if (typeof idOrEntity === 'object' && idOrEntity !== null) {
                entity = idOrEntity;
            } else {
                // Al retornar SheetDocument<T>, 'entity' lo acepta de forma segura
                entity = await repository.findById(idOrEntity as string | number);
            }

            if (!entity) {
                this.logger.warn(`[CascadeDelete] No se localizó el registro principal para proceder con la eliminación.`);
                return;
            }

            const entityProto = repository.entityClass.prototype;
            const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, entityProto) || [];

            // 2. Iterar sobre las relaciones registradas y borrar en cascada
            for (const field of relationsList) {
                const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
                if (!config) continue;

                // Extraemos el valor local (ej: el id del padre o su clave foránea)
                // Al ser 'any', TypeScript no protestará al leer propiedades dinámicas
                const localValue = entity[config.localField] ?? entity.id;
                if (!localValue) continue;

                // Resolver el repositorio del hijo dinámicamente usando el ModuleRef de NestJS
                const childRepository = this.moduleRef.get(config.childRepository || config.targetRepository, { strict: false });

                if (childRepository) {
                    this.logger.log(`[CascadeDelete] Limpiando registros hijos dependientes en la columna: "${config.joinColumn}" con valor: "${localValue}"`);

                    // Buscamos todos los hijos que correspondan a esa clave foránea
                    const children = await (childRepository as any).find({ [config.joinColumn]: localValue });

                    // Borramos recursivamente cada hijo usando su respectivo repositorio
                    for (const child of children) {
                        const childId = (child as any).id || (child as any)._id;
                        if (childId) {
                            await (childRepository as any).delete(childId);
                        } else {
                            await (childRepository as any).delete(child);
                        }
                    }
                }
            }

            // 3. Una vez purgados los hijos huérfanos, procedemos a eliminar al Padre
            this.logger.log(`[CascadeDelete] Procediendo a la baja definitiva del registro padre en la pestaña: [${repository.sheetName}]`);
            await repository.getPersistenceEngine().delete(idOrEntity);

            this.logger.log('--- 🗑️ FIN OPERACIÓN CASCADE_DELETE ---\n');
        } catch (error: any) {
            this.logger.error(`[CascadeDelete] ❌ Error ejecutando cascada de borrado: ${error.message}`);
            throw error;
        }
    }
}