import { SHEETS_COLUMN_DETAILS, SHEETS_COLUMN_LIST } from "@database/constants/metadata.constants";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { ClassType, FilterQuery } from "@database/types/query.types";
import { deepClone, SheetDocument } from "@database/wrapper/sheet.document";
import { Inject, Logger } from "@nestjs/common";

export const InjectModel = (entity: Function) => Inject(`${entity.name}Model`);

export type Model<T> = {
    // Constructor para instancias (Active Record)
    new(data?: Partial<T>): T & {
        save(): Promise<T>;
        softDelete(): Promise<void>;
        __row?: number;
    };

    // Métodos estáticos (Query Engine)
    find(filter?: FilterQuery<T>, options?: any): Promise<Partial<T>[]>;
    findOne(filter?: FilterQuery<T>, projection?: any): Promise<Partial<T> | null>;
    findOneAndUpdate(filter: FilterQuery<T>, update: any, options?: any): Promise<Partial<T> | null>;
};
/**
 * los métodos de instancia deben enfocarse en dos cosas: la gestión del estado del documento
 * (qué ha cambiado) y la navegación de datos (relaciones).
 */
export function createModel<T extends object>(
    entityClass: ClassType<T>,
    repo: SheetsRepository<T>
): Model<T> {

    const ModelClass = class extends SheetDocument<T> {
        constructor(data?: Partial<T>) {
            // 1. Pasamos un objeto vacío inicial seguro al padre para evitar que se raye con un POJO sin prototipo
            super({} as T, repo, false);

            // 2. INYECCIÓN CRÍTICA DE CONTEXTO: Fijamos la clase real de la entidad inmediatamente
            // (Asegúrate de cambiar 'EntityClass' por el parámetro que reciba tu función fábrica, ej. TargetEntity, entity, etc.)
            (this as any)._entityClass = entityClass;

            // 3. HIDRATACIÓN DIRECTA DE LA INSTANCIA
            if (data) {
                Object.assign(this, data);
            }

            // 4. ESTABILIZACIÓN DEL ESTADO DE NUEVO
            this._isNew = !data || !(data as any).__row;

            // 5. BLINDAJE DEL SNAPSHOT: Forzamos el snapshot inicial con los datos limpios
            // Esto evita que 'isModified()' explote porque garantiza que el snapshot no sea un objeto vacío huerfano.
            try {
                const plainData = typeof this.toObject === 'function' ? this.toObject() : (data ? deepClone(data) : {});
                (this as any)._snapshot = deepClone(plainData);
            } catch (e) {
                (this as any)._snapshot = data ? deepClone(data) : {} as T;
            }
        }

        // --- MÉTODOS DE INSTANCIA (Active Record) ---
        async save(): Promise<T> {
            // Seguro de vida: Si por alguna razón crítica el snapshot o el software delta fallan,
            // interceptamos para que no tumbe la aplicación y dejamos que el super intente persistir.
            try {
                if (!this.isModified()) {
                    return this as any;
                }
            } catch (error) {
                // Si explota el delta tracker por culpa de los metadatos fríos, logueamos el warning y forzamos el save
                // usando una bandera de respaldo para que Google Sheets reciba la data.
                const logger = new Logger('ModelFactory-Fallback');
                logger.warn(`[Factory] Error analizando deltas (isModified). Forzando persistencia directa.`);
            }

            return await super.save();
        }
    };

    // ⚡ PUENTE DE METADATOS VITAL:
    // Extraemos los metadatos de las columnas grabados en la Entidad original (ej: ObreroEntity)
    // y los soldamos en el prototipo de la clase dinámica del Modelo para que SheetDocument los lea.
    const entityMetadata = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityClass.prototype);
    if (entityMetadata) {
        Reflect.defineMetadata(SHEETS_COLUMN_DETAILS, entityMetadata, ModelClass.prototype);
    }

    const columnList = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass.prototype);
    if (columnList) {
        Reflect.defineMetadata(SHEETS_COLUMN_LIST, columnList, ModelClass.prototype);
    }

    // --- MÉTODOS ESTÁTICOS (Estilo Mongoose) ---
    (ModelClass as any).find = (filter: FilterQuery<T>, options?: any) =>
        repo.find(filter, options);

    (ModelClass as any).findOne = (filter: FilterQuery<T>) =>
        repo.findOne(filter);

    (ModelClass as any).findOneAndUpdate = (filter: FilterQuery<T>, update: any, options?: any) =>
        repo.findOneAndUpdate(filter, update, options);
    // ⚡ ENLACE DIRECTO DE SEGURIDAD:
    // Guardamos la referencia de la entidad original en el prototipo del modelo
    (ModelClass.prototype as any)._entityClass = entityClass;

    // Retornamos la clase tipada como Model<T>
    return ModelClass as unknown as Model<T>;
}