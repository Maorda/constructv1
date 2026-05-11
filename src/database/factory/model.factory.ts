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

export function createModel<T extends object>(
    entityClass: ClassType<T>,
    repo: SheetsRepository<T>
): Model<T> {

    /**
     * Esta clase interna es la que el usuario instancia con 'new Model()'
     * Heredamos de SheetDocument para tener .isModified(), .getChangesPayload(), etc.
     */
    const ModelClass = class extends (entityClass as any) {
        constructor(data?: Partial<T>) {
            // Pasamos la data, el repo (driver) y el flag de emergencia
            super((data || {}) as T, repo, false);

            // Hidratamos la instancia con la data inicial
            if (data) {
                Object.assign(this, data);
            }
        }

        // --- MÉTODOS DE INSTANCIA (Active Record) ---

        async save(): Promise<T> {
            // El save() de SheetDocument ya sabe qué cambió y usa repo.save()
            return await super.save();
        }

        async softDelete(): Promise<void> {
            // Implementamos la lógica de borrado lógico usando el repo
            const idValue = (this as any).id ?? (this as any)._id ?? (this as any).__row;
            if (idValue) {
                await repo.softDelete(idValue);
            }
        }
    };

    // --- MÉTODOS ESTÁTICOS (Estilo Mongoose) ---
    // Delegamos totalmente en el Repositorio, que tiene los motores y el caché.

    (ModelClass as any).find = (filter: FilterQuery<T>, options?: any) =>
        repo.find(filter, options);

    (ModelClass as any).findOne = (filter: FilterQuery<T>) =>
        repo.findOne(filter);

    (ModelClass as any).findOneAndUpdate = (filter: FilterQuery<T>, update: any, options?: any) =>
        repo.findOneAndUpdate(filter, update, options);

    // Retornamos la clase tipada como Model<T>
    return ModelClass as unknown as Model<T>;
}