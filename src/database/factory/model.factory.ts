import { SHEETS_COLUMN_DETAILS, SHEETS_COLUMN_LIST } from "@database/constants/metadata.constants";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { ClassType, FilterQuery } from "@database/types/query.types";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { Inject } from "@nestjs/common";

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
            super((data || {}) as T, repo, false);
            if (data) {
                Object.assign(this, data);
            }
        }

        // --- MÉTODOS DE INSTANCIA (Active Record) ---
        async save(): Promise<T> {
            // Apoya la herencia inteligente
            if (!this.isModified()) return this as any;
            return await super.save();
        }

        toJSON(): T {
            return this.toObject();
        }

        async populate(path: keyof T): Promise<this> {
            await repo.populate(this as unknown as T, path as string);
            return this;
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