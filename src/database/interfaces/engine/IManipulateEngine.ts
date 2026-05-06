export interface IManipulateEngine<T> {
    /** Crea o actualiza un registro en la hoja de cálculo */
    save(data: T): Promise<T>;

    /** Elimina un registro por ID (físico o lógico) */
    delete(id: string | number): Promise<void>;

    /** Realiza actualizaciones masivas basadas en un criterio */
    updateMany(filter: Partial<T>, data: Partial<T>): Promise<number>;

    /** Limpia o vacía una colección completa */
    clear(): Promise<void>;
}