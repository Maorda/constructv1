export interface IManipulateEngine {
    /** Crea o actualiza un registro en la hoja de cálculo */
    save<T>(entityClass: new () => T, data: T): Promise<T>;

    /** Elimina un registro por ID (físico o lógico) */
    delete<T>(entityClass: new () => T, id: string | number): Promise<void>;

    /** Realiza actualizaciones masivas basadas en un criterio */
    updateMany<T>(entityClass: new () => T, filter: Partial<T>, data: Partial<T>): Promise<number>;

    /** Limpia o vacía una colección completa */
    clear<T>(entityClass: new () => T): Promise<void>;
}