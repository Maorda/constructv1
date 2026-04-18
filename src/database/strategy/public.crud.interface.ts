export interface PublicoCrudInterface<T> {
    deleteRow(spreadsheetId: string, sheetId: number, rowIndex: number): Promise<void>;
    updateRow(identifierColumn: string, value: any, partialEntity: Partial<T>): Promise<T>;
    createRow(data: Partial<T>): Promise<T>;

}