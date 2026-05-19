// @database/engines/sheet-document.hydrator.ts
import { Injectable, Logger } from "@nestjs/common";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ClassType } from "@database/types/query.types";
import { ISheetsRepository } from "@database/interfaces/engine/ISheetsRepository";
import { SheetsRepository } from "./sheets.repository";

@Injectable()
export class SheetDocumentHydrator {
    private readonly logger = new Logger(SheetDocumentHydrator.name);

    /**
     * Toma datos planos y los convierte en un Documento Vivo protegido contra referencias circulares.
     */
    public hydrateAndShield<T extends object>(
        entityClass: ClassType<T>,
        repository: SheetsRepository<T>,
        rawData: any,
        options: { new?: boolean; oldDataFlat?: any } = {}
    ): SheetDocument<T> | null {
        if (!rawData) return null;

        // 1. Determinar cuál es la fuente de datos real respetando la opción 'new'
        const dataToProcess = (options.new === false && options.oldDataFlat) ? options.oldDataFlat : rawData;

        // 2. Instanciar e Hidratar de forma controlada
        const instance = new entityClass();
        Object.assign(instance, dataToProcess);
        const hydratedDoc = new SheetDocument<T>(instance as T, repository, false);

        // 3. 🛡️ Protección transaccional anti-vaciado
        if (!hydratedDoc || Object.keys(hydratedDoc).length === 0) {
            this.logger.warn(`[Hydrator] ¡ALERTA! El documento de ${entityClass.name} quedó vacío. Aplicando bypass plano.`);
            return dataToProcess as any;
        }

        // 4. 🛡️ Escudo definitivo contra referencias circulares en Express/Fastify
        Object.defineProperty(hydratedDoc, 'toJSON', {
            value: function () {
                const plainObject = {} as any;
                const baseData = this.entity || this._snapshot || dataToProcess;

                // Clonamos de forma segura solo las propiedades primitivas públicas
                Object.keys(baseData).forEach(key => {
                    if (!key.startsWith('_')) {
                        plainObject[key] = baseData[key];
                    }
                });

                // Exponer la coordenada física de la fila si existe
                if (this.__row) plainObject.__row = this.__row;
                else if (dataToProcess.__row) plainObject.__row = dataToProcess.__row;

                return plainObject;
            },
            enumerable: false,
            configurable: true
        });

        return hydratedDoc;
    }
}