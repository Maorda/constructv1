import { EntityFilterQuery, Projection, UpdateQuery } from "@database/types/query.types";



export interface PublicOrmInterface<T> {
    /**
   * @description Busca un único documento, lo actualiza y devuelve el documento. Por defecto devuelve el documento actualizado (new: true).
   * @param filter Filtro para encontrar el registro
   * @param update Datos a actualizar
   * @param options Opciones de actualización
   * @returns Registro actualizado
   * @example
   * const updated = await this.repository.findOneAndUpdate(
   *   { dni: '12345678' },
   *   { $set: { nombre: 'Juan', edad: 30 } }
   * );
   */
    findOneAndUpdate(
        filter: EntityFilterQuery<T>,
        update: UpdateQuery<T>,
        options?: { new?: boolean }
    ): Promise<T | null>;

    /*
    *@description Busca un único registro por su identificador (DNI/ID).
    *@param filter Filtro para encontrar el registro
    *@param options Opciones de actualización
    *@returns Registro actualizado
    *@example
    * const updated = await this.repository.findOneAndUpdate(
    *   { dni: '12345678' },
    *   { $set: { nombre: 'Juan', edad: 30 } }
    * );
    */
    findOne(
        filter: EntityFilterQuery<T>,
        options?: { populate?: boolean }
    ): Promise<T | null>;

    /**
     * Retorna todos los registros de la entidad (con caché).
     */
    findAll(): Promise<T[]>;

    /**
     * Crea un nuevo registro en la hoja de cálculo.
     */
    create(data: Partial<T>): Promise<T>;

    /**
     * Elimina un registro físicamente de la hoja.
     */
    remove(id: string | number): Promise<void>;

    /**
     * Limpia la caché manual de esta entidad.
     */
    refreshCache(): Promise<void>;
}
