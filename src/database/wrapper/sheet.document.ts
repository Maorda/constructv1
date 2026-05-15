import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { IPersistenceEngine } from "@database/interfaces/engine/IPersistence.engine";
import { Projection } from "@database/types/query.types";
import { InternalServerErrorException, Logger } from "@nestjs/common";
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

// Importa tus Symbols en SheetDocument

import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_COLUMN_LIST
} from '../constants/metadata.constants';
// ... dentro de la clase SheetDocument
export class SheetDocument<T extends object> {
    private readonly logger = new Logger(SheetDocument.name);
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    // Flag para saber si este documento viene de la capa de emergencia
    public readonly isFromEmergencyCache: boolean = false;
    private _snapshot: T;
    private _isNew: boolean;
    constructor(
        public readonly data: T,
        private readonly sheetRepository: SheetsRepository<T>, // Inyección del servicio para la proyeccion
        isEmergency: boolean = false,

    ) {
        this.isFromEmergencyCache = isEmergency;
        this._isNew = !(data as any).__row;

        // 1. Hidratamos la instancia con los datos
        Object.assign(this, data);

        // 2. SEGURIDAD: Solo cambiamos el prototipo si 'data' es una instancia de clase real.
        // Si data es un JSON normal (constructor Object), NO ejecutamos setPrototypeOf
        // para no perder los métodos como toObject() o isModified().
        if (data && data.constructor && data.constructor.name !== 'Object') {
            Object.setPrototypeOf(this, Object.getPrototypeOf(data));
        }

        // 3. Generamos el snapshot usando el método de la instancia
        this._snapshot = deepClone(this.toObject());

    }
    // Dentro de la clase SheetDocument
    async softDelete(): Promise<void> {
        const idValue = (this as any).id ?? (this as any)._id ?? (this as any).__row;

        if (!idValue) {
            this.logger.error('No se puede eliminar un documento sin ID o fila (__row)');
            throw new InternalServerErrorException('Error al intentar eliminar el registro.');
        }

        try {
            // Marcamos como inactivo en el objeto actual
            (this as any).activo = false;

            // Persistimos solo ese cambio en Google Sheets
            await this.sheetRepository.updatePartial(idValue, { activo: false } as any);

            // Actualizamos el snapshot para que isModified() sea coherente
            this._snapshot = deepClone(this.toObject());

            this.logger.log(`Documento con ID ${idValue} marcado como inactivo.`);
        } catch (error) {
            this.logger.error(`Error en softDelete: ${error.message}`);
            throw new InternalServerErrorException('No se pudo realizar el borrado lógico.');
        }
    }

    /**
     * Compara el estado actual con el snapshot para extraer solo lo que cambió.
     */
    public getDirtyFields(): Partial<T> {
        const currentData = this.toObject();
        const dirty: any = {};

        for (const key in currentData) {
            // Evitamos comparar el snapshot mismo o el repo
            if (key.startsWith('_') || key === 'sheetRepository') continue;

            if (!this.isEqual(currentData[key], this._snapshot[key])) {
                dirty[key] = currentData[key];
            }
        }
        return dirty;
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
        // 1. Verificación de cambios (Dirty Checking)
        if (!this.isModified()) {
            this.logger.debug('Sin cambios detectados. Omitiendo llamada a Google Sheets.');
            return this as unknown as T;
        }

        // 2. Identificación del registro (__row es vital para Sheets)
        const idValue = (this as any).id ?? (this as any)._id ?? (this as any).__row;

        try {
            let result: T;

            if (idValue !== null && idValue !== undefined) {
                // --- LÓGICA DE ACTUALIZACIÓN (UPDATE) ---
                const delta = this.getChangesPayload();
                const flatDelta = this.prepareForPersistence(delta);

                this.logger.log(`Actualizando fila ${idValue}...`);
                result = await this.sheetRepository.updatePartial(idValue, flatDelta) as T;
            } else {
                // --- LÓGICA DE CREACIÓN (CREATE) ---
                // Extraemos solo los campos con @Column
                const cleanData = this.toObject();
                // Traducimos llaves (ej: dni -> DNI)
                const readyToPush = this.prepareForPersistence(cleanData);

                // LOG DE SEGURIDAD: Si esto sale vacío en consola, tus Symbols o @Column fallaron
                console.log('Payload final para Google Sheets:', readyToPush);

                if (Object.keys(readyToPush).length === 0) {
                    throw new Error('El payload está vacío. Verifica que tus propiedades tengan el decorador @Column.');
                }

                result = await this.sheetRepository.save(readyToPush) as T;
            }

            // 3. RE-HIDRATACIÓN: Actualizamos la instancia con lo que devolvió Google (como el __row)
            Object.assign(this, result);

            // 4. RESET DEL SNAPSHOT: Ahora el objeto está "limpio" otra vez
            this._snapshot = deepClone(this.toObject());

            return this as unknown as T;
        } catch (error) {
            this.logger.error(`Error en persistencia: ${error.message}`);
            // Lanzamos una excepción de NestJS para que Insomnia muestre el error real
            throw new InternalServerErrorException(`Error al sincronizar con Google Sheets: ${error.message}`);
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
    /**
     * LISTA BLANCA: Extrae un objeto plano que contiene SOLO
     * lo que fue marcado con @Column.
     */
    toObject(): T {
        const plainObject = {} as T;
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, Object.getPrototypeOf(this)) || {};

        Object.keys(details).forEach(key => {
            const value = (this as any)[key];
            if (typeof value !== 'function' && value !== undefined) {
                plainObject[key as keyof T] = deepClone(value);
            }
        });

        if ((this as any).__row) (plainObject as any).__row = (this as any).__row;
        return plainObject;
    }

    // Método de respaldo para que no se envíe vacío mientras depuramos
    private toObjectFallback(): T {
        const plain = {} as T;
        Object.keys(this).forEach(key => {
            if (!key.startsWith('_') && !['ctx', 'sheetRepository', 'logger', 'data'].includes(key)) {
                plain[key as keyof T] = (this as any)[key];
            }
        });
        return plain;
    }

    private prepareForPersistence(data: any): any {
        const persistenceData: any = {};
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, Object.getPrototypeOf(this)) || {};

        for (const propKey in data) {
            if (propKey === '__row' || propKey.startsWith('_')) continue;

            const config = details[propKey];
            // Si el decorador existe, usa el nombre definido (DNI), si no, la propiedad (dni)
            const sheetColumnName = config?.name || propKey;

            persistenceData[sheetColumnName] = data[propKey];
        }
        return persistenceData;
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