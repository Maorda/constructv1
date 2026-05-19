import { Injectable } from "@nestjs/common";
import { ISheetsApiContract } from "./SheetsApiClient";
import { ISheetMetadataContract } from "./interfaces/sheets.contracts";
import { SHEETS_TABLE_NAME } from "@database/constants/metadata.constants";

export interface ISheetMetadataOrchestrator<T extends object> {
    getHeaders(entityClass: new () => T): Promise<string[]>;
    syncSchema(entityClass: new () => T): Promise<void>;
    mapObjectToRowArray(entity: T): Promise<string[]>;
    resolveSheetName(sheetName: string): Promise<string>;
}

/** * ISheetMetadataContract: Gestión de cabeceras, nombres y mapeo. 
 */
export interface ISheetMetadataContract1 {
    getHeaders(entityClass: any): Promise<string[]>;
    syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void>;
    mapObjectToRowArray<T>(data: T, headers: string[]): any[];
    resolveSheetName(entityClass: any): string;
}

@Injectable()
export class SheetMetadataOrchestrator implements ISheetMetadataContract {
    getHeaders(entityClass: any): Promise<string[]> {
        throw new Error('Method not implemented.');
    }
    syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void> {
        throw new Error('Method not implemented.');
    }
    mapObjectToRowArray<T>(entity: T, headers: string[]): any[] {
        throw new Error('Method not implemented.');
    }
    resolveSheetName(entityClass: any): string {
        const decoratedName = Reflect.getMetadata(SHEETS_TABLE_NAME, entityClass);
        return decoratedName || this.normalizeFallback(entityClass.name);
    }
}