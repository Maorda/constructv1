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

    /**
     * Esta clase interna es la que el usuario instancia con 'new Model()'
     * Heredamos de SheetDocument para tener .isModified(), .getChangesPayload(), etc.
     */
    const ModelClass = class extends SheetDocument<T> {

        constructor(data?: Partial<T>) {
            // Pasamos la data, el repo (driver) y el flag de emergencia

            // SheetDocument espera: (data, repo, isEmergency)
            super((data || {}) as T, repo, false);

            // Importante: Copiar las propiedades de data a 'this' 
            // para que actúe como la entidad misma

        }

        // --- MÉTODOS DE INSTANCIA (Active Record) ---



        async save(): Promise<T> {
            // Ahora this.isModified y this.toObject existen por herencia
            if (!this.isModified()) return this as any;
            return await super.save();
        }
        /**
         * Limpia el objeto para ser enviado por HTTP o logs
         */
        toJSON(): T {
            // Usamos el toObject del padre para limpiar la data
            return this.toObject();
        }

        /**
         * Carga una relación bajo demanda
         */
        /**
         * Método de instancia para cargar relaciones bajo demanda.
         * Uso: await usuario.populate('perfil');
         */
        async populate(path: keyof T): Promise<this> {
            // 1. Invocamos al RelationalEngine a través del repositorio.
            // Pasamos 'this' como la entidad y el 'path' como el nombre de la propiedad.
            await repo.populate(this as unknown as T, path as string);

            // 2. Retornamos 'this' para permitir encadenamiento (Fluent Interface)
            // Ejemplo: await user.populate('roles').then(u => u.populate('permisos'));
            return this;
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