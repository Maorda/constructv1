// @database/engines/relational-upsert.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { FilterQuery, UpdateQuery } from "@database/types/query.types";
import { SheetDocument, deepClone } from "@database/wrapper/sheet.document";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { SHEETS_ALL_RELATIONS, SHEETS_RELATIONS_LIST } from "@database/constants/metadata.constants";
import { SheetsRepository } from "../repositories/sheets.repository"; // Ajusta la ruta según tu árbol
import { UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { IRelationalUpsertOrchestrator } from "./interfaces/repositories.contracts";

@Injectable()
export class RelationalUpsertOrchestrator implements IRelationalUpsertOrchestrator {
    private readonly logger = new Logger(RelationalUpsertOrchestrator.name);

    constructor(
        private readonly moduleRef: ModuleRef,
        private readonly queryNormalizer: QueryNormalizer
    ) { }

    async execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {

        const isPushOperation = !!updateData.$push;
        const payloadRaw = updateData.$set ? { ...updateData.$set } : (!updateData.$push ? { ...updateData } : {});
        const entityProto = repository.entityClass.prototype;
        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, entityProto) || [];
        const isolatedSubCollections: any = {};

        // 1. Extracción de metadatos relacionales
        for (const field of relationsList) {
            const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
            if (!config) continue;

            if (payloadRaw[field] !== undefined) {
                isolatedSubCollections[field] = { config, data: Array.isArray(payloadRaw[field]) ? payloadRaw[field] : [payloadRaw[field]], operation: 'SET' };
                delete payloadRaw[field];
            } else if (updateData.$push && updateData.$push[field] !== undefined) {
                isolatedSubCollections[field] = { config, data: Array.isArray(updateData.$push[field]) ? updateData.$push[field] : [updateData.$push[field]], operation: 'PUSH' };
            }
        }

        // 2. Persistencia del Padre
        const padreDocumento = await repository.findOneAndUpdate(
            filter,
            (isPushOperation && Object.keys(payloadRaw).length === 0) ? { estadoEliminado: false } as any : payloadRaw,
            options
        );

        if (!padreDocumento) return null;

        // 3. Propagación a hijos
        for (const field of Object.keys(isolatedSubCollections)) {
            const { config, data, operation } = isolatedSubCollections[field];
            const localValue = (padreDocumento as any)[config.localField] ?? (padreDocumento as any).id;

            // Acceso al repo hijo mediante el ModuleRef inyectado en el contexto
            const childRepository = this.moduleRef?.get(config.childRepository || config.targetRepository, { strict: false });
            if (!childRepository) continue;

            for (const rawHijo of data) {
                const hijo = deepClone(rawHijo) as any;
                hijo[config.joinColumn] = localValue;
                delete (hijo as any).__row;

                const childPrimaryKey = (childRepository as any).metadata?.primaryKey || 'id';
                let filtroHijo = this.resolveChildFilter(hijo, operation, childPrimaryKey, config, localValue);

                const childEntityClass = (childRepository as any).entityClass;
                filtroHijo = this.queryNormalizer.normalize(childEntityClass, filtroHijo);

                await childRepository.findOneAndUpdate(filtroHijo, hijo, { upsert: true, new: true });
            }
        }

        // 4. Re-hidratación final
        for (const relField of relationsList) {
            await repository.ctx.relationEngine.populate(padreDocumento as any, relField);
        }

        return padreDocumento;
    }

    private resolveChildFilter(hijo: any, operation: string, pk: string, config: any, localValue: any) {
        if (operation === 'PUSH' && !hijo[pk]) {
            return { [config.joinColumn]: localValue, ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {}, ...hijo.hora ? { hora: hijo.hora } : {} };
        }
        return hijo[pk] ? { [pk]: hijo[pk] } : { [config.joinColumn]: localValue, ...hijo.fecha ? { fecha: hijo.fecha } : {}, ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {} };
    }
}