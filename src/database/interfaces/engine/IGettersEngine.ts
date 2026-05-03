export interface IGettersEngine {
    /** Recupera un registro por su ID único */
    findById<T>(entityClass: new () => T, id: string | number): Promise<T | null>;

    /** Recupera todos los registros de una hoja/colección */
    findAll<T>(entityClass: new () => T): Promise<T[]>;

    /** Busca registros que coincidan con criterios específicos */
    find<T>(entityClass: new () => T, filter: Partial<T>): Promise<T[]>;

    /** Recupera un único registro basado en un filtro */
    findOne<T>(entityClass: new () => T, filter: Partial<T>): Promise<T | null>;
}