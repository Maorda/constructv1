// @database/engines/relational-upsert.orchestrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { FilterQuery, UpdateQuery } from "@database/types/query.types";
import { SheetDocument, deepClone } from "@database/wrapper/sheet.document";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { SHEETS_ALL_RELATIONS, SHEETS_RELATIONS_LIST } from "@database/constants/metadata.constants";
import { SheetsRepository } from "../repositories/sheets.repository"; // Ajusta la ruta según tu árbol
import { UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";

@Injectable()
export class RelationalUpsertOrchestrator {
    private readonly logger = new Logger(RelationalUpsertOrchestrator.name);

    constructor(private readonly moduleRef: ModuleRef) { }

    /**
     * Ejecuta un Upsert atómico en la entidad cabecera (Padre)
     * y propaga de forma recursiva y en lote las mutaciones hacia las pestañas de sus @SubCollection.
     */
    async execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {
        try {
            this.logger.log('\n--- 🛠️ INICIO OPERACIÓN FIND_ONE_AND_UPDATE_RELATIONAL (ORCHESTRATOR) ---');

            // 1. Identificar tipo de operación en colecciones del payload
            const isPushOperation = !!updateData.$push;

            // Clonación defensiva del cuerpo principal destinado a la entidad Padre
            const payloadRaw = updateData.$set
                ? { ...updateData.$set }
                : (!updateData.$push ? { ...updateData } : {});

            const entityProto = repository.entityClass.prototype;
            const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, entityProto) || [];
            const isolatedSubCollections: { [key: string]: { config: any; data: any[]; operation: 'SET' | 'PUSH' } } = {};

            // 2. Extraer y aislar la metadata de datos relacionales
            for (const field of relationsList) {
                // Caso A: Reemplazo completo de la subcolección ($set o payload plano)
                if (payloadRaw[field] !== undefined) {
                    const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
                    isolatedSubCollections[field] = {
                        config,
                        data: Array.isArray(payloadRaw[field]) ? payloadRaw[field] : [payloadRaw[field]],
                        operation: 'SET'
                    };
                    delete payloadRaw[field]; // Evitamos que rompa la persistencia de columnas del padre
                }

                // Caso B: Inserción individual empujada ($push)
                if (updateData.$push && updateData.$push[field] !== undefined) {
                    const config = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityProto, field);
                    const pushData = updateData.$push[field];

                    isolatedSubCollections[field] = {
                        config,
                        data: Array.isArray(pushData) ? pushData : [pushData],
                        operation: 'PUSH'
                    };
                }
            }

            // 3. Sincronizar o asegurar la existencia de la fila cabecera (Padre) via Passthrough
            this.logger.log(`[RelationalOrchestrator] Sincronizando fila cabecera en pestaña: [${repository.sheetName}]`);

            const padreDocumento = await repository.findOneAndUpdate(
                filter,
                (isPushOperation && Object.keys(payloadRaw).length === 0) ? { estadoEliminado: false } as any : payloadRaw,
                options
            );

            if (!padreDocumento) {
                this.logger.warn('[RelationalOrchestrator] Operación abortada: No se localizó ni creó la fila del documento padre.');
                return null;
            }

            // 4. Propagar de forma asíncrona las mutaciones hacia cada subcolección física hija
            for (const field of Object.keys(isolatedSubCollections)) {
                const { config, data, operation } = isolatedSubCollections[field];
                const localValue = (padreDocumento as any)[config.localField] ?? (padreDocumento as any).id;

                // Resolución de repositorio remoto usando el ModuleRef nativo de NestJS
                const childRepository = this.moduleRef.get(config.childRepository || config.targetRepository, { strict: false });

                if (!childRepository) {
                    this.logger.error(`❌ No se pudo resolver el repositorio dinámico "${config.targetRepository}" en el contenedor.`);
                    continue;
                }

                for (const rawHijo of data) {
                    const hijo = deepClone(rawHijo) as any;
                    hijo[config.joinColumn] = localValue;
                    delete (hijo as any).__row;

                    const childPrimaryKey = (childRepository as any).metadata?.primaryKey || 'id';
                    let filtroHijo: any;

                    if (operation === 'PUSH' && !hijo[childPrimaryKey]) {
                        // Coincidencia lógica para evitar duplicidades en reintentos de red
                        filtroHijo = {
                            [config.joinColumn]: localValue,
                            ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {},
                            ...hijo.hora ? { hora: hijo.hora } : {}
                        };
                    } else {
                        filtroHijo = hijo[childPrimaryKey]
                            ? { [childPrimaryKey]: hijo[childPrimaryKey] }
                            : { [config.joinColumn]: localValue, ...hijo.fecha ? { fecha: hijo.fecha } : {}, ...hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {} };
                    }

                    const childEntityClass = (childRepository as any).entityClass;
                    if (childEntityClass) {
                        filtroHijo = QueryNormalizer.normalize(childEntityClass, filtroHijo);
                    }

                    // Mutación atómica directa en la hoja subordinada de Google Sheets
                    await (childRepository as any).findOneAndUpdate(
                        filtroHijo,
                        hijo,
                        { upsert: true, new: true }
                    );
                }
            }

            // 5. Re-hidratar el árbol completo de relaciones en memoria antes de retornar
            this.logger.log(`[RelationalOrchestrator] Re-hidratando jerarquía completa de datos sobre el documento vivo...`);
            for (const relField of relationsList) {
                await repository.populate(padreDocumento as any, relField);
            }

            return padreDocumento;

        } catch (error: any) {
            this.logger.error(`[RelationalOrchestrator] ❌ ERROR EN PROCESO RELACIONAL: ${error.message}`);
            throw error;
        }
    }
}