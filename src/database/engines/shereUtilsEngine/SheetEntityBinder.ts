import { SHEETS_COLUMN_DETAILS, SHEETS_COLUMN_LIST, TABLE_COLUMN_KEY } from "@database/constants/metadata.constants";
import { ColumnOptions } from "@database/decorators/column.decorator";
import { ClassType } from "@database/types/query.types";
import { Injectable } from "@nestjs/common";
import { SheetMapper } from "./sheet.mapper";
import { SheetDataTransformer } from "./SheetDataTransformer";
import { SheetSchemaManager } from "../../gatewayManager/SheetSchemaManager";
import { ISheetEntityBinder } from "./interfaces/sheet.mapper.interface";

@Injectable()
export class SheetEntityBinder implements ISheetEntityBinder {
    constructor(
        private readonly transformer: SheetDataTransformer,
        private readonly schemaManager: SheetSchemaManager

    ) { }
    // En SheetEntityBinder.ts

    public mapRowToEntityWithIndex<R extends object>(
        headers: string[],
        row: any[],
        EntityClass: ClassType<R>,
        physicalIndex: number
    ): R {
        // 1. Usamos tu lógica actual de creación de instancia
        const entity = new EntityClass();
        const targetProto = Object.getPrototypeOf(entity);
        const tz = process.env.TIMEZONE || 'America/Lima';

        // 2. Inyectamos el puntero físico
        (entity as any).__row = physicalIndex;

        // 3. Obtenemos metadatos (centralizado aquí)
        const columnsDetails: Record<string, ColumnOptions> =
            Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) || {};

        // 4. Mapeo y Casteo
        Object.keys(columnsDetails).forEach(propKey => {
            const colOptions = columnsDetails[propKey];
            const colName = colOptions?.name || propKey;
            const colIndex = headers.findIndex(h =>
                h?.toString().trim().toLowerCase() === colName.toLowerCase()
            );

            if (colIndex !== -1 && row[colIndex] !== undefined) {
                (entity as any)[propKey] = this.transformer.castValue(
                    row[colIndex],
                    colOptions.type,
                    colOptions.default,
                    tz
                );
            }
        });

        return entity;
    }


    public getDeltaUpdate<T extends object>(
        headers: string[],
        original: T,
        updated: T,
        entityClass: ClassType<T>
    ): { colIndex: number, value: any, header: string }[] {
        const delta: any[] = [];
        const target = entityClass.prototype;

        // Solo comparamos propiedades que existan en el objeto actualizado
        Object.keys(updated).forEach(key => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (!options) return;

            const headerName = options.name || key;
            const colIndex = headers.findIndex(h => h.toLowerCase() === headerName.toLowerCase());

            if (colIndex !== -1) {
                const oVal = (original as any)[key];
                const uVal = (updated as any)[key];

                // Usamos una comparación profunda simplificada
                if (!this.transformer.areEqual(oVal, uVal)) {
                    delta.push({
                        colIndex: colIndex + 1, // Google Sheets es base 1
                        value: this.transformer.prepareValueForSheet(uVal, options.type),
                        header: headerName
                    });
                }
            }
        });
        return delta;
    }
    /**
     * Convierte una instancia de entidad a un array (fila) para Google Sheets.
     * Utiliza la infraestructura inyectada para resolver nombres y formatos.
     */
    public mapEntityToRow<T>(entity: T, headers: string[], entityClass: ClassType<T>): any[] {
        // 1. Obtenemos los detalles de columna específicamente para esta clase.
        // El SchemaManager garantiza que obtengamos el mapa correcto (prop -> config).
        const columnDetails = this.schemaManager.getColumnDetails(entityClass);

        // 2. Mapeamos cada header de la hoja a un valor de la entidad.
        return headers.map(header => {
            // 3. Delegamos al SchemaManager la resolución: Header (Hoja) -> Propiedad (Clase)
            const propertyKey = this.schemaManager.getPropertyKeyByColumnName(entityClass, header);

            // Si no existe una propiedad asociada (ej: columna desconocida en la hoja), 
            // devolvemos una celda vacía para mantener la integridad de la fila.
            if (!propertyKey) return '';

            // 4. Extraemos el valor actual del objeto
            const value = (entity as any)[propertyKey];
            const options = columnDetails[propertyKey];

            // 5. Delegamos la transformación final al Transformer.
            // Esto abstrae la lógica de fechas, objetos JSON, o tipos primitivos 
            // sin ensuciar el Binder.
            return this.transformer.prepareValueForSheet(value, options?.type);
        });
    }
    /**
     * Convierte una fila de Sheets a una instancia de Entidad.
     */
    public mapFromRow<T>(headers: string[], row: any[], EntityClass: ClassType<T>): T {
        const entity = new (EntityClass as any)();

        // 🔒 Delegamos la obtención de metadatos al SchemaManager
        const columnDetails = this.schemaManager.getColumnDetails(EntityClass);

        headers.forEach((header, index) => {
            const rawValue = row[index];

            // 🔒 Usamos el SchemaManager para encontrar la propiedad real
            const propertyKey = this.schemaManager.getPropertyKeyByColumnName(EntityClass, header);

            if (propertyKey) {
                const options = columnDetails[propertyKey];

                // Aplicamos el casteo usando el transformer
                entity[propertyKey] = this.transformer.castValue(
                    rawValue,
                    options?.type,
                    options?.default
                );
            }
        });

        return entity;
    }

    public mapRowsToEntities<T>(headers: string[], rows: any[][], EntityClass: ClassType<T>): T[] {
        if (!rows || rows.length === 0) return [];
        return rows.map(row => this.mapFromRow(headers, row, EntityClass));
    }

}

