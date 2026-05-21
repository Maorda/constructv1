import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { IPersistenceEngine } from "@database/interfaces/engine/IPersistence.engine";
import { Projection } from "@database/types/query.types";
import { InternalServerErrorException, Logger } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";

import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_COLUMN_LIST,
    SHEETS_DELETE_CONTROL
} from '../constants/metadata.constants';
// ... dentro de la clase SheetDocument
export class SheetDocument<T extends object> {
    private readonly logger = new Logger(SheetDocument.name);
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    // Flag para saber si este documento viene de la capa de emergencia
    public readonly isFromEmergencyCache: boolean = false;
    private _snapshot: T;
    public _isNew: boolean;

    constructor(
        public readonly data: T,
        private readonly sheetRepository: SheetsRepository<T>, // Inyección del servicio para la proyeccion
        isEmergency: boolean = false,

    ) {
        this.isFromEmergencyCache = isEmergency;
        this._isNew = !data || !(data as any).__row;

        // 1. Hidratamos la instancia con los datos de forma segura
        if (data) {
            Object.assign(this, data);
        }

        // 2. SEGURIDAD: Solo cambiamos el prototipo si 'data' es una instancia de clase real.
        if (data && data.constructor && data.constructor.name !== 'Object') {
            Object.setPrototypeOf(this, Object.getPrototypeOf(data));
        }

        // 3. ASIGNACIÓN CRÍTICA DE RESPALDO: Guardamos la referencia de la clase de la entidad
        if (data && data.constructor) {
            (this as any)._entityClass = data.constructor;
        }

        // 4. Generamos el snapshot usando el método de la instancia de forma segura
        // Evitamos que explote si toObject() se llama durante la inicialización
        // 🛡️ SEGURO DE VIDA EN EL CONSTRUCTOR BASE:
        // Si no es un objeto plano, intentamos llamar a toObjectFallback() verificando que exista en 'this'.
        // Si no existe (porque se está ejecutando el super() de una clase factory dinámica),
        // extraemos los valores planos usando un esparcidor seguro.
        let plainData: any = {};
        if (data) {
            if (data.constructor && data.constructor.name === 'Object') {
                plainData = data;
            } else if (typeof (this as any).toObjectFallback === 'function') {
                plainData = (this as any).toObjectFallback();
            } else {
                // Fallback seguro in-line por si el prototipo dynamic está congelado en el super()
                plainData = {};
                Object.keys(data).forEach(key => {
                    if (!key.startsWith('_') && !['ctx', 'sheetRepository', 'logger', 'data'].includes(key)) {
                        plainData[key] = (data as any)[key];
                    }
                });
            }
        }
        this._snapshot = deepClone(plainData) as T;
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
 * Detecta si hay cambios comparando con el snapshot inicial o si es un registro nuevo.
 */
    isModified(path?: keyof T): boolean {
        // ⚡ ARREGLO CRÍTICO: Si el documento es nuevo, por definición está "sucio/modificado" 
        // y requiere ser insertado en Google Sheets de forma obligatoria.
        if (this._isNew) return true;

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
     * Extrae un Partial<T> solo con las propiedades modificadas asegurando los contextos
     */
    private getChangesPayload(): Partial<T> {
        const currentData = this.toObject();
        const changes: Partial<T> = {};

        if (!currentData || !this._snapshot) return currentData || {};

        Object.keys(currentData).forEach(key => {
            if (!key) return;
            const val1 = (currentData as any)[key];
            const val2 = this._snapshot ? (this._snapshot as any)[key] : undefined;

            if (JSON.stringify(val1) !== JSON.stringify(val2)) {
                changes[key as keyof T] = val1;
            }
        });

        return changes;
    }


    /**
      * Extrae un objeto plano (POJO) con la data real de la entidad de forma segura,
      * autocompletando controles de borrado lógico ausentes.
      */
    toObject(): T {
        const plainObject = {} as T;

        if (!this) return plainObject;

        const targetProto = Object.getPrototypeOf(this);
        const entityProto = (this as any)._entityClass?.prototype;

        // 1. Extraemos los metadatos de las columnas y el control de borrado
        const details = (targetProto ? Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) : null) ||
            (entityProto ? Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityProto) : null) ||
            {};

        const deleteControlProp = (targetProto ? Reflect.getMetadata(SHEETS_DELETE_CONTROL, targetProto) : null) ||
            (entityProto ? Reflect.getMetadata(SHEETS_DELETE_CONTROL, entityProto) : null) ||
            null;

        if (Object.keys(details).length > 0) {
            Object.keys(details).forEach(key => {
                if (key && Object.prototype.hasOwnProperty.call(this, key)) {
                    let value = (this as any)[key];

                    // 💥 INTERCEPCIÓN DEL ODM: Si es la columna de borrado lógico y no está definida, forzamos false
                    if (key === deleteControlProp && (value === undefined || value === null)) {
                        value = false;
                    }

                    if (typeof value !== 'function' && value !== undefined) {
                        plainObject[key as keyof T] = deepClone(value);
                    }
                }
            });
        } else {
            // Fallback general por si los metadatos están fríos
            Object.keys(this).forEach(key => {
                if (
                    key &&
                    !key.startsWith('_') &&
                    !['ctx', 'sheetRepository', 'logger', 'data', 'isFromEmergencyCache'].includes(key)
                ) {
                    try {
                        let value = (this as any)[key];

                        if (key === deleteControlProp && (value === undefined || value === null)) {
                            value = false;
                        }

                        if (typeof value !== 'function' && value !== undefined) {
                            plainObject[key as keyof T] = deepClone(value);
                        }
                    } catch (e) {
                        // Ignorar propiedades inaccesibles
                    }
                }
            });
        }

        // Aseguramos que si la propiedad de borrado no existía en absoluto en el objeto plano, se añada con false
        if (deleteControlProp && (plainObject as any)[deleteControlProp] === undefined) {
            (plainObject as any)[deleteControlProp] = false;
        }

        if ((this as any).__row) (plainObject as any).__row = (this as any).__row;
        return plainObject;
    }
    /**
     * Traduce las llaves de la entidad a los nombres físicos de las columnas de Google Sheets
     */
    private prepareForPersistence(data: any): any {
        const persistenceData: any = {};
        if (!data) return persistenceData;

        const targetProto = this ? Object.getPrototypeOf(this) : null;
        const entityProto = (this as any)._entityClass?.prototype;

        const details = (targetProto ? Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) : null) ||
            (entityProto ? Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityProto) : null) ||
            {};

        for (const propKey in data) {
            if (!propKey || propKey === '__row' || propKey.startsWith('_')) continue;

            const config = details[propKey];
            const sheetColumnName = config?.name || propKey;

            // Evitamos que explote si la propiedad leyó un contexto indefinido
            persistenceData[sheetColumnName] = data[propKey] !== undefined ? data[propKey] : null;
        }
        return persistenceData;
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