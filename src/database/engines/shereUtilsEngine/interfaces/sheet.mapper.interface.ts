import { ColumnOptions } from "@database/decorators/column.decorator";
import { ClassType } from "@database/types/query.types";

/**
 * Se encarga de la conversión de tipos (Cast) y formateo de celdas.
 */
export interface ISheetDataTransformer {
    castValue(value: any, type: string, defaultValue?: any, timezone?: string): any;
    prepareValueForSheet(value: any, type: string): any;
    formatValueForSheet(value: any, type: string): any;
    formatForSheet(value: any, type: string): any;
    areEqual(val1: any, val2: any): boolean;



}

/**
 * Se encarga de comparar el estado real de la hoja vs el estado esperado por el código.
 */
export interface ISheetSchemaManager {
    syncSchema(force?: boolean): Promise<void>;
    checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean;
    getColumnHeaders(entityClass: ClassType<any>): string[];
    getFullRange(sheetName: string, specificRange: string): string;
    initialize(entityClass: ClassType<any>): void;
    getColumnDetails(): Record<string, ColumnOptions>;
    getPropertyKeyByColumnName(entityClass: ClassType<any>, columnName: string): string | undefined;



}


/**
 * Se encarga de convertir Entidades TS a filas (y viceversa) usando los otros dos servicios.
 */
export interface ISheetEntityBinder {
    mapToRow<T>(entity: T, headers: string[], columnDetails: Record<string, any>): any[];

    mapRowToEntity<T>(headers: string[], row: any[], rowIndex: number, entityClass: ClassType<T>): T;
    mapEntityToRow<T>(entity: T, headers: string[], entityClass: ClassType<T>): any[];
    getDeltaUpdate<T extends object>(
        headers: string[],
        original: T,
        updated: T,
        entityClass: ClassType<T>
    ): { colIndex: number, value: any, header: string }[];
    mapRowsToEntities<T>(headers: string[], rows: any[][], EntityClass: ClassType<T>): T[];
}