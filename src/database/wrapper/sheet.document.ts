import { VirtualType } from "@database/interfaces/virtual.type";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
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



export class SheetDocument<T extends object> implements ISheetDocument<T> {
    private readonly logger = new Logger(SheetDocument.name);
    // Usamos el contexto para acceder a todos los motores (clean architecture)
    // Flag para saber si este documento viene de la capa de emergencia
    public readonly isFromEmergencyCache: boolean = false;
    private _snapshot: T;
    constructor(
        data: Partial<T>,
        private readonly ctx: RepositoryContext<T>,
        private readonly _virtuals: Record<string, VirtualType> = {},
        private readonly sheetRepository: SheetsRepository<T>, // Inyección del servicio para la proyeccion
        isEmergency: boolean = false,

    ) {
        this.isFromEmergencyCache = isEmergency;
        // Snapshot inicial usando el nuevo clonador inteligente
        this._snapshot = this.cloneData(data);

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

        // Si se pide un campo específico
        if (path) {
            return !this.isEqual(currentData[path], (this._snapshot as any)[path]);
        }

        // Si no hay path, comparamos el objeto completo campo por campo
        // Nota: Es mejor iterar las llaves que comparar los objetos enteros de golpe
        // para evitar problemas con métodos o propiedades ocultas.
        const keys = Object.keys(currentData) as (keyof T)[];
        return keys.some(key => !this.isEqual(currentData[key], (this._snapshot as any)[key]));
    }



    // Basado en tu lógica de comparación granular
    getModifiedPaths(): (keyof T)[] {
        const current = this.toObject();
        return (Object.keys(current) as (keyof T)[]).filter(path =>
            !this.isEqual(current[path], (this._snapshot as any)[path])
        );
    }
    /**
     * Método SAVE inteligente con lógica de Reintento y Deltas.
     */
    async save(): Promise<T> {
        // Si estamos en modo emergencia, avisamos que no es seguro guardar
        if (this.isFromEmergencyCache) {
            this.logger.warn('Intentando guardar un documento que proviene del caché de emergencia. Podría haber conflictos.');
        }

        if (!this.isModified()) {
            this.logger.debug('No hay cambios detectados. Omitiendo llamada a la API.');
            return this as any as T;
        }

        const idKey = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, this.constructor.prototype) || 'id';
        const idValue = (this as any)[idKey];

        try {
            let result: T;

            if (idValue) {
                // --- ACTUALIZACIÓN PARCIAL (DELTA) ---
                const delta = this.getChangesPayload();
                this.logger.log(`Guardando delta para ID ${idValue}: ${Object.keys(delta).join(', ')}`);

                // Llamamos al nuevo método del repositorio que creamos antes
                result = await this.sheetRepository.updatePartial(idValue, delta);
            } else {
                // --- CREACIÓN COMPLETA ---
                const fullData = this.ctx.manipulateEngine.prepareForSave(this.toObject());
                result = await this.sheetRepository.create(fullData);
            }

            // Actualizamos el snapshot tras el éxito para "limpiar" el estado dirty
            this._snapshot = this.cloneData(result);
            Object.assign(this, result);

            return result;
        } catch (error) {
            this.logger.error(`Error al guardar SheetDocument: ${error.message}`);
            throw new InternalServerErrorException('No se pudo persistir el documento.');
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
    toObject(): T {
        const plainObject = {} as T;

        // 1. Obtenemos todas las llaves de la instancia actual
        const keys = Object.keys(this) as (keyof this)[];

        for (const key of keys) {
            const value = this[key];

            // 2. FILTROS DE SEGURIDAD
            // - Saltamos propiedades privadas (empiezan con _)
            // - Saltamos las dependencias inyectadas (ctx, baseService)
            // - Saltamos funciones (métodos del documento)
            if (
                String(key).startsWith('_') ||
                key === 'ctx' ||
                key === 'baseService' ||
                key === 'entityClass' ||
                typeof value === 'function'
            ) {
                continue;
            }

            // 3. CLONACIÓN DE VALORES
            // Si el valor es un objeto (y no es nulo), hacemos una copia para evitar mutaciones accidentales
            if (value && typeof value === 'object') {
                if (value instanceof Date) {
                    plainObject[key as unknown as keyof T] = new Date(value.getTime()) as any;
                } else if (Array.isArray(value)) {
                    plainObject[key as unknown as keyof T] = [...value] as any;
                } else {
                    plainObject[key as unknown as keyof T] = { ...value } as any;
                }
            } else {
                plainObject[key as unknown as keyof T] = value as any;
            }
        }

        return plainObject;
    }

    private prepareForPersistence(data: any): any {
        // Usamos un clon profundo simple para evitar mutar el estado actual
        const copy = { ...data };

        for (const key in copy) {
            // 1. ELIMINAR VIRTUALES: No queremos persistir getters/setters calculados
            if (this._virtuals && this._virtuals[key]) {
                delete copy[key];
                continue;
            }

            const value = copy[key];

            // 2. APLANAMIENTO DE RELACIONES (Populate -> ID)
            if (value && typeof value === 'object' && !(value instanceof Date)) {

                // Caso A: Es un Array de relaciones (ej: obreros en una obra)
                if (Array.isArray(value)) {
                    copy[key] = value.map((item: any) => {
                        if (item && typeof item === 'object') {
                            // Buscamos _id o id de forma flexible
                            return item._id || item.id || item;
                        }
                        return item;
                    });
                }

                // Caso B: Es una relación única (ej: capataz de la obra)
                else {
                    const nestedId = value._id || value.id;
                    if (nestedId !== undefined) {
                        copy[key] = nestedId;
                    } else {
                        // Si es un objeto pero no tiene ID, y no es Date, 
                        // lo convertimos a string para evitar [object Object] en Sheets
                        // Opcional: podrías decidir borrarlo o dejarlo según tu lógica
                    }
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
    public get entity(): T {
        return this._snapshot;
    }

    /**
     * Retorna una versión filtrada de la entidad incluyendo sus virtuals.
     * Útil para enviar datos a un frontend o API sin exponer campos sensibles.
     */
    select(projection: Projection<T>): any {
        // 1. Obtenemos los valores actuales de las propiedades reales (no el snapshot)
        const currentData = this.toObject();

        // 2. Obtenemos los valores calculados de los virtuals
        // Asegúrate de que getVirtualsValues() ejecute los getters actuales
        const virtualValues = this.getVirtualsValues();

        // 3. Mezclamos ambos para tener el mapa completo de datos
        const fullObject = { ...currentData, ...virtualValues };

        // 4. Delegamos al servicio la proyección (el filtrado de columnas)
        return this.baseService.applyProjection(fullObject, projection);
    }

    private getVirtualsValues(): Record<string, any> {
        const values: Record<string, any> = {};
        for (const key in this._virtuals) {
            // Al acceder a this[key], se dispara el getter definido en initVirtuals
            values[key] = (this as any)[key];
        }
        return values;
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