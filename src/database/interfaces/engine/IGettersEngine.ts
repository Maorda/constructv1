import { EntityFilterQuery } from "@database/types/query.types";

export interface IGettersEngine<T> {
    /** Recupera un registro por su ID único */
    findByRowId(sheetName: string, rowId: string | number): Promise<T | null>;

    /** Recupera todos los registros (la clase ya es conocida por el motor) */
    findAll(): Promise<T[]>;

    /** Busca registros que coincidan con criterios específicos */
    find(filter: EntityFilterQuery<T>): Promise<T[]>;

    /** Recupera un único registro basado en un filtro */
    findOne(filter: EntityFilterQuery<T>): Promise<T | null>;
}