export interface IPersistenceEngine<T> {
    /** Guarda una entidad (Crea si no existe, actualiza si existe) */
    save(entity: T): Promise<T>;

    /** Inserta un nuevo registro y genera su ID si falta */
    create(entity: T): Promise<T>;

    /** Actualiza un registro existente basándose en su PK */
    update(id: string | number, entity: T): Promise<T>;

    /** Borrado lógico con soporte de cascada */
    delete(id: string | number): Promise<void>;

    /** Verifica la existencia de un registro */
    exists(id: string | number): Promise<boolean>;
}