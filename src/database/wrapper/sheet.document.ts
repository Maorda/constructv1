import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { IPersistenceEngine } from "@database/interfaces/engine/IPersistence.engine";
import { Projection } from "@database/types/query.types";

/*
*Imagina que estás creando el repositorio de Obras. Quieres un campo virtual 
*que te diga cuánto presupuesto queda disponible:
*const obraRepo = new SheetsRepository(Obra, context, {
    presupuestoDisponible: {
        get: function() { 
            // 'this' es el SheetDocument
            // Podemos usar los motores del contexto inyectado
            const gastos = this.entity.gastosMateriales + this.entity.gastosPlanilla;
            return this.entity.presupuestoTotal - gastos;
        }
    },
    resumenObreros: {
        get: async function() {
            // Ejemplo relacional: contamos obreros de esta obra
            const obreros = await this.ctx.getters.find(Obrero, { obraId: this.entity.id });
            return `Esta obra tiene ${obreros.length} obreros activos.`;
        }
    }
});
*/



export class SheetDocument<T extends object> implements ISheetDocument<T> {
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    private entity: T;
    constructor(
        data: T,
        private readonly entityClass: new () => T,
        private readonly ctx: RepositoryContext,
        private readonly _virtuals: Record<string, VirtualType> = {},
        private readonly baseService: BaseServiceInterface<T> // Inyección del servicio para la proyeccion
    ) {

        // Snapshot inicial usando el nuevo clonador inteligente
        this.entity = this.cloneData(data);

        // 1. Asignación de datos reales a la instancia
        Object.assign(this, data);

        // 2. Inicialización de Getters/Setters virtuales
        this.initVirtuals();
    }
    remove(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    reload(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    /*
    * @description Este metodo se encarga de inicializar los getters y setters virtuales
    */
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
            return !this.isEqual(currentData[path], (this.entity as any)[path]);
        }
        return !this.isEqual(currentData, this.entity);
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
        this.entity = this.cloneData(result);
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

    // GETTERS DINÁMICOS
    // Esto permite acceder a propiedades del objeto como si fueran del wrapper
    // Ejemplo: documento.nombre en lugar de documento.entity.nombre
    public get data(): T {
        return this.entity;
    }

    /**
     * Retorna una versión filtrada de la entidad y sus virtuals
     */
    select(projection: Projection<T>): any {
        // Obtenemos el objeto completo (incluyendo virtuals inicializados)
        const fullObject = { ...this.entity, ...this.getVirtualsValues() };

        // El servicio se encarga de la lógica de filtrado
        return this.baseService.applyProjection(fullObject, projection);
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