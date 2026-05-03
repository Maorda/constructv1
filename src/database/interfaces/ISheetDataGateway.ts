export interface ISheetDataGateway {
    /**
     * Recupera todas las filas de una hoja específica.
     * @param sheetName Nombre de la pestaña en el Spreadsheet.
     * @returns Array de objetos T (clave-valor) representando las filas.
     */
    getAllRows<T>(sheetName: string, entityClass: new () => T): Promise<T[]>;

    /**
     * Agrega una nueva fila al final de la hoja.
     * @param sheetName Nombre de la pestaña.
     * @param entity Objeto con los datos a insertar.
     */
    addRow<T>(sheetName: string, entity: T): Promise<any>;

    /**
     * Actualiza una fila existente basándose en un índice o ID.
     * @param sheetName Nombre de la pestaña.
     * @param rowId El identificador único o número de fila.
     * @param data Datos actualizados.
     */
    updateRow(sheetName: string, rowId: string | number, data: any): Promise<any>;

    /**
     * Elimina una fila de la hoja.
     */
    deleteRow(spreadsheetId: string, sheetId: number | string, rowId: string | number): Promise<void>;

    /**
     * Ejecuta una lectura por lotes (Batch) si es necesario para optimizar.
     */
    batchGet(ranges: string[]): Promise<any>;

    /**
     * Obtiene los metadatos de la hoja (nombres de columnas, número de filas, etc.)
     */
    getSheetMetadata(sheetName: string): Promise<SheetMetadata>;
}

export interface SheetMetadata {
    headers: string[];
    rowCount: number;
    lastUpdated: Date;
}