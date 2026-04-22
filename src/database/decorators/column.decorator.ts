import 'reflect-metadata';
// Clave única para los metadatos de las columnas
// Exportamos la llave para que otros archivos (como SheetMapper) la vean
//export const TABLE_COLUMN_KEY1 = 'sheets:table_column';
export const TABLE_COLUMN_KEY = 'column:metadata';
export const TABLE_COLUMNS_METADATA_KEY = 'table:columns';

export interface ColumnOptions {
    name?: string;     // Nombre de la cabecera en Excel
    type?: 'string' | 'number' | 'boolean' | 'date' | 'currency';
    required?: boolean;
    default?: any;
}

/**
 * Decorador @Column
 * Permite mapear propiedades de clase con cabeceras de Google Sheets.
 * * @param options Nombre de la columna o configuración completa
 */
export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: Object, propertyKey: string | symbol) => {
        // 1. Guardar metadatos individuales de la columna
        Reflect.defineMetadata(TABLE_COLUMN_KEY, options, target, propertyKey);

        // 2. Registrar el nombre de la propiedad en la lista global de la clase
        const columns = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target) || [];
        columns.push(propertyKey);
        Reflect.defineMetadata(TABLE_COLUMNS_METADATA_KEY, columns, target);
    };
}