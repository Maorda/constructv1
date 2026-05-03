export interface ISheetDocument<T> {
    /**
     * Sincroniza los cambios actuales del objeto con Google Sheets.
     * Si el registro es nuevo, lo crea; si existe, lo actualiza.
     */
    save(): Promise<T>;

    /**
     * Elimina el registro actual de forma lógica (Soft Delete).
     */
    remove(): Promise<void>;

    /**
     * Retorna los datos puros de la entidad (el "caramelo" sin el envoltorio).
     */
    toObject(): T;

    /**
     * Permite recargar los datos desde la hoja de cálculo para asegurar 
     * que tenemos la versión más reciente.
     */
    reload(): Promise<void>;
}