// interfaces/sheets.contracts.ts

export interface ISheetsApiContract {
    execute<T>(operation: (sheets: any) => Promise<T>): Promise<T>;
}

export interface ISheetsPersistenceContract {
    setSheetName(sheetName: string): void;
    appendRows(range: string, values: any[][]): Promise<void>;
    updateRange(range: string, values: any[][]): Promise<void>;
    clearRow(sheetName: string, physicalRow: number): Promise<void>;
    deleteRow(sheetId: number, rowIndex: number): Promise<void>;
    updateCellsBatch(data: any[]): Promise<void>;
}

export interface ISheetProvisionerContract {
    /**
     * Sostiene la ejecución del hilo de NestJS mediante un bucle de espera activa 
     * hasta que las credenciales y el SDK de Google Sheets estén 100% operativos.
     */
    executeActiveWait(apiClient: any, sheetName: string): Promise<void>;

    /**
     * Consulta los metadatos generales del libro de trabajo (Spreadsheet).
     * Retorna la lista de hojas disponibles con sus propiedades estructurales.
     */
    getSpreadsheetMetadata(apiClient: any): Promise<any>;

    /**
     * Envía una mutación de actualización en lote (batchUpdate) para inyectar 
     * una nueva pestaña física en el documento de Google Sheets.
     */
    createSheet(apiClient: any, sheetName: string): Promise<void>;

    /**
     * Busca de forma selectiva dentro de la estructura de Google y extrae el puntero 
     * numérico idóneo (`sheetId`) de una pestaña basándose en su nombre.
     */
    getSheetIdByName(apiClient: any, sheetName: string): Promise<number>;
}

export interface ISheetMetadataContract {
    getHeaders(entityClass: any): Promise<string[]>;
    syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void>;
    mapObjectToRowArray<T>(data: T, headers: string[]): any[];
    resolveSheetName(entityClass: any): string;
    checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean
}

