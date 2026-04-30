import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";

export class SheetDocument<T extends object> {
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    private readonly _ctx: RepositoryContext;
    private readonly _service: BaseServiceInterface<T>;
    private readonly _entityClass: new () => T;

    private _originalData: T;
    private _virtuals: Record<string, VirtualType> = {};

    constructor(
        data: T,
        service: BaseServiceInterface<T>,
        ctx: RepositoryContext,

        entityClass: new () => T,
        virtuals: Record<string, VirtualType> = {}
    ) {
        this._service = service;
        this._ctx = ctx;
        this._entityClass = entityClass;
        this._virtuals = virtuals;

        // Snapshot inicial usando el nuevo clonador inteligente
        this._originalData = this.cloneData(data);

        // 1. Asignación de datos reales a la instancia
        Object.assign(this, data);

        // 2. Inicialización de Getters/Setters virtuales
        this.initVirtuals();
    }

    private initVirtuals() {
        Object.keys(this._virtuals).forEach(key => {
            const config = this._virtuals[key];
            Object.defineProperty(this, key, {
                get: config.get ? config.get.bind(this) : undefined,
                set: config.set ? config.set.bind(this) : undefined,
                enumerable: true,
                configurable: true
            });
        });
    }

    /**
     * Dirty Checking optimizado: Detecta cambios reales ignorando virtuals
     */
    isModified(path?: keyof T): boolean {
        const currentData = this.toObject();
        if (path) {
            return !this.isEqual(currentData[path], (this._originalData as any)[path]);
        }
        return !this.isEqual(currentData, this._originalData);
    }

    async save(): Promise<T> {
        if (!this.isModified()) return this.toObject();

        const rawData = this.toObject();
        // Aplanamos relaciones (objetos -> IDs)
        const payload = this.prepareForPersistence(rawData);

        // El motor de manipulación normaliza tipos para Google Sheets
        const processedData = this._ctx.manipulateEngine.prepareForSave(payload);

        const id = (processedData as any).id;
        let result: T;

        if (id) {
            // Obtenemos solo lo que cambió para no sobreescribir toda la fila
            const updatePayload = this.getChanges(processedData);
            // Delegamos al servicio la persistencia final
            result = await (this._service as any).findOneAndUpdate({ id }, { $set: updatePayload });
        } else {
            result = await (this._service as any).create(processedData);
        }

        // Sincronizamos el estado interno tras el éxito
        this._originalData = this.cloneData(result);
        Object.assign(this, result);

        return result;
    }

    /**
     * Compara profundamente dos valores evitando falsos positivos de fechas/objetos
     */
    private isEqual(a: any, b: any): boolean {
        // Si son fechas o strings de fecha, comparamos su valor temporal
        if (this.isDate(a) || this.isDate(b)) {
            return new Date(a).getTime() === new Date(b).getTime();
        }
        return JSON.stringify(a) === JSON.stringify(b);
    }

    private isDate(val: any): boolean {
        return val instanceof Date || (!isNaN(Date.parse(val)) && typeof val === 'string' && val.includes('-'));
    }

    private getChanges(processedData: any): any {
        const changes: any = {};
        const original = this.prepareForPersistence(this._originalData);

        Object.keys(processedData).forEach(key => {
            if (this._virtuals[key]) return;

            if (!this.isEqual(processedData[key], original[key])) {
                changes[key] = processedData[key];
            }
        });

        if (processedData.id) changes.id = processedData.id;
        return changes;
    }

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
            if (this._virtuals[key]) {
                delete copy[key];
                continue;
            }

            // Lógica de aplanamiento de relaciones
            if (copy[key] && typeof copy[key] === 'object') {
                if (Array.isArray(copy[key])) {
                    copy[key] = copy[key].map((item: any) => item.id || item);
                } else if (copy[key].id) {
                    copy[key] = copy[key].id;
                }
            }
        }
        return copy;
    }

    /**
     * Método clonador refactorizado (Ver abajo detalle)
     */
    private cloneData(data: any): any {
        return deepClone(data);
    }
}

/**
 * Clonador profundo inteligente que preserva instancias de Date
 * y maneja recursividad sin romper tipos.
 */
export function deepClone<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    // Si es una fecha, creamos una nueva instancia con el mismo tiempo
    if (obj instanceof Date) {
        return new Date(obj.getTime()) as any;
    }

    // Si es un Array, clonamos cada elemento recursivamente
    if (Array.isArray(obj)) {
        return obj.map(item => deepClone(item)) as any;
    }

    // Si es un objeto, clonamos sus propiedades
    const clonedObj = {} as T;
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            (clonedObj as any)[key] = deepClone((obj as any)[key]);
        }
    }

    return clonedObj;
}