import { EntityFilterQuery } from "@database/types/query.types";

export interface PublicoQueryInterface<T> {
    findAll(): Promise<T[]>;

    /*findOne(
        filter: EntityFilterQuery<T>,
        options: { populate?: boolean } 
    ): Promise<T | null>
    */

    /**
     * Carga todas las relaciones marcadas con @Relation en la instancia.
     * Devuelve la misma entidad con sus propiedades de relación ya llenas.
     */
    populateAll(entity: T): Promise<T>;
    refreshCache(): Promise<void>;
}