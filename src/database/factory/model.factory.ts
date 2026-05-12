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
    const ModelClass = class extends (entityClass as any) {

        constructor(data?: Partial<T>) {
            // Pasamos la data, el repo (driver) y el flag de emergencia
            super((data || {}) as T, repo, false);
        }

        // --- MÉTODOS DE INSTANCIA (Active Record) ---

        async save(): Promise<T> {
            if (!this.isModified()) return this as any; // Optimización: no llamar a API si no hay cambios
            return await super.save();
        }

        async softDelete(): Promise<void> {
            return await super.softDelete();
        }

        /**
         * Limpia el objeto para ser enviado por HTTP o logs
         */
        toJSON(): T {
            // 1. Creamos una copia superficial
            const plain = { ...this };

            // 2. Eliminamos propiedades que empiezan con '_' (como _document, _snapshot) 
            // y las que sabemos que son de infraestructura
            Object.keys(plain).forEach(key => {
                if (key.startsWith('_') || ['ctx', 'repo', 'virtuals'].includes(key)) {
                    delete (plain as any)[key];
                }
            });

            // 3. El casteo seguro que TypeScript exige
            return plain as unknown as T;
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