import { VirtualType } from "@database/interfaces/virtual.type";

export class SheetDocument<T> {
    private readonly _repository: any;
    private readonly _manipulateEngine: any;
    private _originalData: T;
    private _virtuals: Record<string, VirtualType> = {};

    constructor(data: T, repository: any, manipulateEngine: any, virtuals: Record<string, VirtualType> = {}) {
        this._repository = repository;
        this._manipulateEngine = manipulateEngine;
        this._virtuals = virtuals;

        // Snapshot inicial para isModified
        this._originalData = JSON.parse(JSON.stringify(data));

        // 1. Copiamos datos reales
        Object.assign(this, data);

        // 2. Inicializamos Virtuals (Getters/Setters)
        this.initVirtuals();
    }

    private initVirtuals() {
        Object.keys(this._virtuals).forEach(key => {
            const config = this._virtuals[key];
            Object.defineProperty(this, key, {
                get: config.get ? config.get.bind(this) : undefined,
                set: config.set ? config.set.bind(this) : undefined,
                enumerable: true, // Para que aparezcan al serializar si es necesario
                configurable: true
            });
        });
    }

    /**
     * Dirty Checking: ¿Ha cambiado el campo?
     */
    isModified(path?: keyof T): boolean {
        const currentData = this.toObject();
        if (path) {
            return JSON.stringify(currentData[path]) !== JSON.stringify(this._originalData[path]);
        }
        return JSON.stringify(currentData) !== JSON.stringify(this._originalData);
    }

    async save(): Promise<T> {
        if (!this.isModified()) return this.toObject();

        const rawData = this.toObject();
        const payload = this.prepareForPersistence(rawData);
        const processedData = this._manipulateEngine.prepareForSave(payload);

        const id = (processedData as any).id;
        let result: T;

        if (id) {
            // Solo enviamos el DIFF para optimizar Google Sheets
            const updatePayload = this.getChanges(processedData);
            result = await this._repository.findOneAndUpdate({ id }, { $set: updatePayload });
        } else {
            result = await this._repository.create(processedData);
        }

        // Sincronizamos snapshot
        this._originalData = JSON.parse(JSON.stringify(result));
        Object.assign(this, result);

        return result;
    }

    private getChanges(processedData: any): any {
        const changes: any = {};
        const original = this.prepareForPersistence(this._originalData);

        Object.keys(processedData).forEach(key => {
            // Omitimos virtuals en la comparación de persistencia
            if (this._virtuals[key]) return;

            if (JSON.stringify(processedData[key]) !== JSON.stringify(original[key])) {
                changes[key] = processedData[key];
            }
        });

        if (processedData.id) changes.id = processedData.id;
        return changes;
    }

    /**
     * Limpia el objeto para que solo contenga datos reales (sin métodos ni _privados)
     * Los virtuals se mantienen si son enumerables.
     */
    toObject(): T {
        const obj: any = { ...this };
        Object.keys(obj).forEach(key => {
            if (key.startsWith('_') || typeof obj[key] === 'function') {
                delete obj[key];
            }
        });
        return obj as T;
    }

    private prepareForPersistence(data: any): any {
        const copy = { ...data };
        for (const key in copy) {
            // 1. ELIMINAR VIRTUALS: No queremos que lleguen a las celdas de Excel
            if (this._virtuals[key]) {
                delete copy[key];
                continue;
            }
            // 2. Aplanar relaciones (Objects to IDs)
            if (copy[key] && typeof copy[key] === 'object' && copy[key].id) {
                copy[key] = copy[key].id;
            }
        }
        return copy;
    }
}