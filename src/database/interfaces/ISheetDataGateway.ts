export interface ISheetDataGateway<T extends Object> {


    updateRow(rowIndex: number, entity: T): Promise<void>

    /**
     * Elimina una fila de la hoja.
     */
    deleteRow(spreadsheetId: string, sheetId: number | string, rowId: string | number): Promise<void>;

}

export interface SheetMetadata {
    headers: string[];
    rowCount: number;
    lastUpdated: Date;
}