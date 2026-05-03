/*
*Este motor se encarga de la lógica compleja de filtrado, ordenamiento y paginación.
*A diferencia del Getter, este motor procesa los datos después de ser obtenidos o construye 
*consultas complejas.
*/
export interface IQueryEngine {
    /** Aplica filtros, ordenamiento (ASC/DESC) y límites (Pagination) */
    execute<T>(data: T[], queryOptions: QueryOptions): T[];

    /** Realiza búsquedas de texto parcial (Like/Full-text) */
    search<T>(data: T[], term: string, fields: (keyof T)[]): T[];

    /** Cuenta registros basados en un filtro sin retornar los datos completos */
    count<T>(entityClass: new () => T, filter: Partial<T>): Promise<number>;
}

// Tipo auxiliar para las opciones
export interface QueryOptions {
    limit?: number;
    offset?: number;
    sort?: { field: string; order: 'ASC' | 'DESC' };
}