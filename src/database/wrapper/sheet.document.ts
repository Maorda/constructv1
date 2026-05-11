import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { IPersistenceEngine } from "@database/interfaces/engine/IPersistence.engine";
import { Projection } from "@database/types/query.types";
import { InternalServerErrorException, Logger } from "@nestjs/common";
import { PRIMARY_KEY_METADATA_KEY } from "@database/decorators/primarykey.decorator";
import { SheetsRepository } from "@database/repositories/sheets.repository";

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
// Definimos un tipo que une las capacidades del Wrapper con la forma de la Entidad
//export type ISheetDocument<T extends object> = SheetDocument<T> & T;


export class SheetDocument<T extends object> {
    private readonly logger = new Logger(SheetDocument.name);
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    // Flag para saber si este documento viene de la capa de emergencia
    public readonly isFromEmergencyCache: boolean = false;
    private _snapshot: T;
    constructor(
        public readonly data: T,
        private readonly sheetRepository: SheetsRepository<T>, // Inyección del servicio para la proyeccion
        isEmergency: boolean = false,

    ) {
        this.isFromEmergencyCache = isEmergency;

        // 1. HIDRATACIÓN: Copiamos datos a la instancia
        Object.assign(this, data);

        // 2. PROTOTIPO: Vinculamos los métodos de la Entidad (getters/virtuals)
        Object.setPrototypeOf(this, Object.getPrototypeOf(data));

        // 3. SNAPSHOT: Guardamos el estado inicial limpio para Dirty Checking
        this._snapshot = deepClone(this.toObject());

    }


    remove(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    reload(): Promise<void> {
        throw new Error("Method not implemented.");
    }


    /**
     * Dirty Checking optimizado (Tus métodos estaban perfectos)
     */
    /**
     * Detecta si hay cambios comparando con el snapshot inicial.
     */
    isModified(path?: keyof T): boolean {
        const currentData = this.toObject();
        if (path) {
            return !this.isEqual(currentData[path], (this._snapshot as any)[path]);
        }
        return (Object.keys(currentData) as (keyof T)[]).some(key =>
            !this.isEqual(currentData[key], (this._snapshot as any)[key])
        );
    }



    // Basado en tu lógica de comparación granular
    getModifiedPaths(): (keyof T)[] {
        const current = this.toObject();
        return (Object.keys(current) as (keyof T)[]).filter(path =>
            !this.isEqual(current[path], (this._snapshot as any)[path])
        );
    }
    /**
     * Método SAVE inteligente
     */
    /**
     * Persistencia inteligente con manejo de deltas.
     */
    async save(): Promise<T> {
        if (!this.isModified()) {
            this.logger.debug('Sin cambios detectados. Omitiendo API.');
            return this as unknown as T;
        }

        // Buscamos el ID (puede ser 'id', '_id' o la fila física '__row')
        const idValue = (this as any).id ?? (this as any)._id ?? (this as any).__row;

        try {
            let result: T;
            if (idValue !== undefined) {
                // UPDATE: Solo enviamos lo que cambió y lo aplanamos (IDs)
                const delta = this.getChangesPayload();
                const flatDelta = this.prepareForPersistence(delta);
                result = await this.sheetRepository.updatePartial(idValue, flatDelta) as T;
            } else {
                // CREATE: Enviamos todo el objeto limpio
                const fullData = this.prepareForPersistence(this.toObject());
                result = await this.sheetRepository.create(fullData) as T;
            }

            // Actualizamos estado interno para que isModified pase a false
            Object.assign(this, result);
            this._snapshot = deepClone(this.toObject());

            return this as unknown as T;
        } catch (error) {
            this.logger.error(`Error en persistencia: ${error.message}`);
            throw new InternalServerErrorException('Error al sincronizar con Google Sheets');
        }
    }


    /**
     * Compara profundamente dos valores evitando falsos positivos de fechas/objetos para Sheets
     */
    private isEqual(val1: any, val2: any): boolean {
        // 1. Caso Fechas (Vital para Sheets)
        if (val1 instanceof Date && val2 instanceof Date) {
            return val1.getTime() === val2.getTime();
        }

        // 2. Caso Objetos/Arrays (Recursión simple)
        if (typeof val1 === 'object' && val1 !== null && typeof val2 === 'object' && val2 !== null) {
            return JSON.stringify(val1) === JSON.stringify(val2);
        }

        // 3. Tipos primitivos
        return val1 === val2;
    }

    private isDate(val: any): boolean {
        return val instanceof Date || (!isNaN(Date.parse(val)) && typeof val === 'string' && val.includes('-'));
    }

    /**
     * Extrae un Partial<T> solo con las propiedades que fueron modificadas.
     * Este es nuestro "Delta Lógico".
     */
    private getChangesPayload(): Partial<T> {
        const currentData = this.toObject();
        const changes: Partial<T> = {};

        Object.keys(currentData).forEach(key => {
            const val1 = (currentData as any)[key];
            const val2 = (this._snapshot as any)[key];

            // Comparación profunda simple o por valor
            if (JSON.stringify(val1) !== JSON.stringify(val2)) {
                changes[key as keyof T] = val1;
            }
        });

        return changes;
    }


    /**
    * Convierte la instancia del documento en un objeto JavaScript puro.
    * Filtra metadatos internos, funciones y dependencias para dejar solo la data de la entidad.
    */
    /**
     * Extrae un objeto limpio (POJO) ignorando métodos, getters (virtuals) y dependencias.
     * Le pasamos 'source' para poder usarlo tanto con 'this' como con la data inicial.
     */
    /**
 * Extrae un objeto plano (POJO) con la data real de la entidad.
 * Este método es el "filtro" que evita que métodos y dependencias lleguen a Google Sheets.
 */
    /**
     * Limpia el objeto de dependencias y funciones.
     * Mantiene el __row si existe, pero fuera del flujo de negocio principal.
     */
    toObject(): T {
        const plainObject = {} as T;
        // Esto solo itera propiedades físicas, ignorando métodos y getters de la clase
        const keys = Object.keys(this);

        for (const key of keys) {
            const value = (this as any)[key];

            if (
                key.startsWith('_') ||
                ['ctx', 'sheetRepository', 'logger', 'isFromEmergencyCache'].includes(key) ||
                typeof value === 'function'
            ) {
                continue;
            }

            plainObject[key as keyof T] = deepClone(value);
        }
        return plainObject;
    }

    private prepareForPersistence(data: any): any {
        // 1. Clonamos superficialmente para no mutar el objeto en memoria
        const copy = { ...data };

        for (const key in copy) {
            const value = copy[key];

            // 2. APLANAMIENTO DE RELACIONES (Populate -> ID)
            // Solo entramos si es un objeto y NO es una instancia de Date
            if (value && typeof value === 'object' && !(value instanceof Date)) {

                // Caso A: Es un Array de relaciones (ej: [Obrero, Obrero])
                if (Array.isArray(value)) {
                    copy[key] = value.map((item: any) => {
                        if (item && typeof item === 'object') {
                            // Usamos nullish coalescing para soportar IDs que valgan 0
                            return item.id ?? item._id ?? item;
                        }
                        return item;
                    });
                }

                // Caso B: Es una relación única (ej: Cuadrilla)
                else {
                    const nestedId = value.id ?? value._id;
                    if (nestedId !== undefined) {
                        copy[key] = nestedId;
                    } else {
                        // Si el objeto no tiene ID y no es fecha, lo eliminamos 
                        // para evitar que Google Sheets escriba "[object Object]"
                        delete copy[key];
                        this.logger.warn(`Campo '${key}' omitido: se detectó un objeto sin ID.`);
                    }
                }
            }
        }
        return copy;
    }

    // GETTERS DINÁMICOS
    // Esto permite acceder a propiedades del objeto como si fueran del wrapper
    // Ejemplo: documento.nombre en lugar de documento.entity.nombre
    public get entity(): T {
        return this._snapshot;
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