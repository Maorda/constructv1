import { GettersEngine } from "@database/engine/getters.engine";
import { PersistenceEngine } from "@database/engine/persistence.engine";
import { FilterQuery } from "@database/types/query.types";

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
    entityClass: new () => T,
    persistence: PersistenceEngine<T>,
    getters: GettersEngine<T>
): Model<T> {

    // Creamos la clase interna que hereda de la entidad pura
    const ModelClass = class extends (entityClass as any) {
        constructor(data?: Partial<T>) {
            super();
            if (data) Object.assign(this, data);
        }

        // Método de instancia: Active Record
        async save(): Promise<T> {
            return await persistence.save(this as any);
        }

        async softDelete(): Promise<void> {
            return await persistence.delete(this as any);
        }
    };

    // Inyectamos métodos estáticos al constructor (Estilo Mongoose)
    (ModelClass as any).find = (filter, options) => getters.find(filter, options);
    (ModelClass as any).findOne = (filter, projection) => getters.findOne(filter, projection);
    (ModelClass as any).findOneAndUpdate = (filter, update, options) => persistence.findOneAndUpdate(filter, update, options);

    return ModelClass as unknown as Model<T>;
}