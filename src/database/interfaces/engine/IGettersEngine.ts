import { FilterQuery } from "@database/types/query.types";

export interface IGettersEngine<T> {
    /** Recupera un registro por su ID único */
    findById(sheetName: string, rowId: string | number): Promise<T | null>;

    /** Recupera todos los registros (la clase ya es conocida por el motor) */
    findAll(projection?: any, includeInactive?: boolean): Promise<Partial<T>[]>;

    /** Busca registros que coincidan con criterios específicos */
    find(filter: FilterQuery<T>, options: { projection?: any, sort?: Record<string, 1 | -1>, limit?: number, skip?: number, includeInactive?: boolean }): Promise<Partial<T>[]>;

    /** Recupera un único registro basado en un filtro */
    findOne(filter: FilterQuery<T>, projection: any): Promise<Partial<T> | null>;
}