// @database/engines/sheet-document.hydrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ClassType } from "@database/types/query.types";
import { SheetsRepository } from "./sheets.repository";
import { HydratorOptions, ISheetDocumentHydrator } from "./interfaces/repositories.contracts";

@Injectable()
export class SheetDocumentHydrator implements ISheetDocumentHydrator {
    private readonly logger = new Logger(SheetDocumentHydrator.name);

    /**
     * Transforma datos planos en un Documento Vivo (SheetDocument).
     * Aplica protecciones contra vaciados (bypass) y blinda la serialización (toJSON).
     */
    public hydrateAndShield<T extends object>(
        entityClass: ClassType<T>,
        repository: SheetsRepository<T>,
        rawData: any,
        options: HydratorOptions = {}
    ): SheetDocument<T> | null {
        if (!rawData) return null;

        try {
            // 1. Determinar cuál es la fuente de datos real respetando la opción 'new' de MongoDB/Mongoose
            const dataToProcess = (options.new === false && options.oldDataFlat)
                ? options.oldDataFlat
                : rawData;

            // 2. Instanciar e Hidratar de forma controlada
            const instance = new entityClass();
            Object.assign(instance, dataToProcess);

            const hydratedDoc = new SheetDocument<T>(instance as T, repository, false);

            // 3. 🛡️ BYPASS TRANSACCIONAL ANTI-VACIADO (Extraído de tu método create)
            if (!hydratedDoc || Object.keys(hydratedDoc).length === 0) {
                this.logger.warn(`[Hydrator] ⚠️ ¡ALERTA! El documento de [${entityClass.name}] quedó vacío tras instanciar. Aplicando bypass plano.`);
                return dataToProcess as any;
            }

            // 4. 🛡️ ESCUDO ARQUITECTÓNICO DEFINITIVO ANTI-REFERENCIAS CIRCULARES (Extraído de tu findOneAndUpdate)
            Object.defineProperty(hydratedDoc, 'toJSON', {
                value: function () {
                    const plainObject = {} as any;

                    // Extraemos el snapshot real de datos planos de la entidad
                    const baseData = this.entity || this._snapshot || dataToProcess;

                    // Clonamos de forma segura solo las propiedades enumerables primitivas
                    Object.keys(baseData).forEach(key => {
                        if (!key.startsWith('_')) {
                            plainObject[key] = baseData[key];
                        }
                    });

                    // Si la fila operacional existe en el wrapper, la exponemos de forma segura
                    if (this.__row) plainObject.__row = this.__row;
                    else if (dataToProcess.__row) plainObject.__row = dataToProcess.__row;

                    return plainObject;
                },
                enumerable: false, // Evita que Express/NestJS entre en bucle infinito
                configurable: true
            });

            return hydratedDoc;

        } catch (error: any) {
            this.logger.error(`[Hydrator] ❌ Error crítico hidratando documento: ${error.message}`);
            throw error;
        }
    }
}