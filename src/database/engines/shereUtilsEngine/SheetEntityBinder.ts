import { SHEETS_COLUMN_LIST, TABLE_COLUMN_KEY } from "@database/constants/metadata.constants";
import { ColumnOptions } from "@database/decorators/column.decorator";
import { ClassType } from "@database/types/query.types";
import { Injectable } from "@nestjs/common";
import { SheetMapper } from "./sheet.mapper";
import { SheetDataTransformer } from "./SheetDataTransformer";
import { SheetSchemaManager } from "./SheetSchemaManager";
import { ISheetEntityBinder } from "./interfaces/sheet.mapper.interface";

@Injectable()
export class SheetEntityBinder<T extends object> implements ISheetEntityBinder {
    constructor(
        private readonly transformer: SheetDataTransformer,
        private readonly schemaManager: SheetSchemaManager<T>
    ) { }

    // Refactorizamos mapToRow para que sea más limpio
    public mapToRow<T>(entity: T, headers: string[]): any[] {
        // Mapa inverso: Nombre de Cabecera (Excel) -> Propiedad de Clase
        const headerToPropMap: Record<string, string> = {};
        const columnDetails = this.schemaManager.getColumnDetails();

        Object.keys(columnDetails).forEach(propKey => {
            const config = columnDetails[propKey];
            if (!config) return;
            const headerName = config.name || propKey;
            headerToPropMap[headerName.trim().toLowerCase()] = propKey;
        });

        // Construcción de la fila
        return headers.map(header => {
            const propKey = headerToPropMap[header.trim().toLowerCase()];
            if (!propKey) return '';

            const value = (entity as any)[propKey];
            const config = columnDetails[propKey];

            return this.transformer.prepareValueForSheet(value, config.type);
        });
    }

    mapRowToEntity<T>(headers: string[], row: any[], rowIndex: number, entityClass: ClassType<T>): T {
        const instance = new entityClass();
        const target = entityClass.prototype;

        // Metadata interna para rastreo físico
        (instance as any).__row = rowIndex;

        // DEFINICIÓN CORRECTA DE TZ (como string)
        const appTimezone = process.env.TIMEZONE || 'America/Lima';

        const columns: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass) || [];

        columns.forEach(propKey => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propKey);
            if (!options) return;

            const colName = options.name || propKey;

            const colIndex = headers.findIndex(h =>
                h.trim().toLowerCase() === colName.toString().toLowerCase()
            );

            if (colIndex !== -1 && row[colIndex] !== undefined) {
                (instance as any)[propKey] = this.transformer.castValue(
                    row[colIndex],
                    options.type,
                    options.default,
                    appTimezone // Ahora pasamos el string, no el plugin
                );
            }
        });

        return instance;
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
    public mapEntityToRow<T>(entity: T, headers: string[], entityClass: ClassType<T>): any[] {
        // 1. Obtenemos los detalles de columna desde el SchemaManager (que ya tiene los metadatos cacheados)
        const columnDetails = this.schemaManager.getColumnDetails();

        return headers.map(header => {
            // 2. Usamos el SchemaManager para encontrar la propiedad TS correspondiente al header de Excel
            const propKey = this.schemaManager.getPropertyKeyByColumnName(entityClass, header);

            // Si no encontramos la propiedad (ej: columna extra en excel), enviamos vacío
            if (!propKey) return '';

            // 3. Obtenemos los valores y opciones de forma segura
            const options = columnDetails[propKey];
            const value = (entity as any)[propKey]; // El casting es necesario aquí porque tratamos con objetos genéricos

            // 4. Transformamos usando el Transformer
            return this.transformer.prepareValueForSheet(value, options?.type);
        });
    }
    public entityToRow<T>(entity: T): any[] {
        // 1. Obtenemos la clase constructora y el prototipo
        const EntityClass = entity.constructor as new () => T;
        const target = EntityClass.prototype;

        // 2. Obtenemos los headers directamente desde los metadatos de la clase
        // Esto asegura que la fila siempre coincida con el esquema actual de la entidad
        const headers = this.schemaManager.getColumnHeaders(EntityClass);

        return headers.map((header) => {
            // 3. Traducimos el nombre de la columna del Excel a la propiedad de la clase TS
            const propertyKey = this.schemaManager.getPropertyKeyByColumnName(target, header);

            if (!propertyKey) return '';

            const value = (entity as any)[propertyKey];

            // --- Lógica de Serialización de Datos ---

            // Manejo de nulos o indefinidos
            if (value === undefined || value === null) {
                return '';
            }

            // Manejo de Fechas (Formato ISO para consistencia)
            if (value instanceof Date) {
                return value.toISOString();
            }

            // Manejo de Arrays (Strings unidos por coma, Objetos como JSON)
            if (Array.isArray(value)) {
                return value.length > 0 && typeof value[0] === 'object'
                    ? JSON.stringify(value)
                    : value.join(', ');
            }

            // Manejo de Objetos/Documentos embebidos
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }

            // Valores primitivos (number, string, boolean)
            return value;
        });
    }

    public mapFromRow<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const entity = new EntityClass();
        const target = EntityClass.prototype;

        headers.forEach((header, index) => {
            const rawValue = row[index];
            const propertyKey = this.schemaManager.getPropertyKeyByColumnName(target, header);

            if (propertyKey) {
                // 1. Extraemos los metadatos de la columna para saber el TIPO
                const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propertyKey);

                // 2. INTEGRAMOS CASTVALUE AQUÍ
                // Ahora el valor no es solo un string, es un número, fecha o booleano real.
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
        // Si rows es nulo o vacío, devolvemos array vacío
        if (!rows || rows.length === 0) return [];

        // Mapeamos cada fila usando el método que ya tienes (mapFromRow)
        return rows.map(row => this.mapFromRow(headers, row, EntityClass));
    }

}

