export interface IPersistenceEngine {
    /** Guarda una entidad (Crea si no existe, actualiza si existe) */
    save<T extends object>(entity: T): Promise<T>;

    /** Inserta un nuevo registro y genera su ID si falta */
    create<T extends object>(entity: T): Promise<T>;

    /** Actualiza un registro existente basándose en su PK */
    update<T extends object>(id: string | number, entity: T): Promise<T>;

    /** Borrado lógico con soporte de cascada */
    delete<T extends object>(id: string | number): Promise<void>;

    /** Verifica la existencia de un registro */
    exists<T extends object>(id: string | number): Promise<boolean>;
}