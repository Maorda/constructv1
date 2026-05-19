// interfaces/sheets.contracts.ts

export interface ISheetsApiContract {
    execute<T>(operation: (sheets: any) => Promise<T>): Promise<T>;
}

export interface ISheetsPersistenceContract {
    appendRows(range: string, values: any[][]): Promise<void>;
    updateRange(range: string, values: any[][]): Promise<void>;
    clearRow(physicalRow: number): Promise<void>;
    deleteRow(sheetId: number, rowIndex: number): Promise<void>;
}

export interface ISheetProvisionerContract {
    executeProvision(api: ISheetsApiContract, spreadsheetId: string, sheetName: string, entity: any): Promise<{ sheetId: number }>;
}

export interface ISheetMetadataContract {
    getHeaders(entityClass: any): Promise<string[]>;
    syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void>;
    mapObjectToRowArray<T>(data: T, headers: string[]): any[];
    resolveSheetName(entityClass: any): string;
}

