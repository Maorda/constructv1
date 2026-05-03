import 'reflect-metadata';
// Clave única para los metadatos de las columnas
// Exportamos la llave para que otros archivos (como SheetMapper) la vean
//export const TABLE_COLUMN_KEY1 = 'sheets:table_column';
export const TABLE_COLUMN_KEY = 'column:metadata';
export const TABLE_COLUMNS_METADATA_KEY = 'table:columns';
//export const TABLE_COLUMNS_METADATA_KEY = 'sheets:columns_list'; // Lista de propiedades (orden)
export const TABLE_COLUMN_DETAILS_KEY = 'sheets:columns_details'; // Mapa de configuración (detalles)


export interface ColumnOptions {
    name?: string;     // Nombre de la cabecera en Excel
    type?: 'string' | 'number' | 'boolean' | 'date' | 'currency';
    required?: boolean;
    default?: any;
    isDeleteControl?: boolean;
    isAutoIncrement?: boolean;
}

/**
 * Decorador @Column
 * Permite mapear propiedades de clase con cabeceras de Google Sheets.
 * * @param options Nombre de la columna o configuración completa
 */
/*export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: Object, propertyKey: string | symbol) => {
        // 1. Guardar metadatos individuales de la columna
        Reflect.defineMetadata(TABLE_COLUMN_KEY, options, target, propertyKey);

        // 2. Registrar el nombre de la propiedad en la lista global de la clase
        const columns = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target) || [];
        columns.push(propertyKey);
        Reflect.defineMetadata(TABLE_COLUMNS_METADATA_KEY, columns, target);
    };
}*/
/*export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const metadata = Reflect.getMetadata('SHEETS_COLUMNS', target) || {};
        metadata[propertyKey] = {
            name: options?.name || propertyKey.toString(),
            isDeleteControl: options?.isDeleteControl || false,
            // ... otros metadatos como el índice
        };
        Reflect.defineMetadata('SHEETS_COLUMNS', metadata, target);
    };
}*/

export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        // 'target' en un PropertyDecorator es el prototipo de la clase.
        // 'target.constructor' es la clase misma (donde residen los metadatos estáticos).
        const classConstructor = target.constructor;

        // 1. Registrar en la LISTA GLOBAL (en el constructor para acceso fácil)
        const columnsList: (string | symbol)[] =
            Reflect.getOwnMetadata(TABLE_COLUMNS_METADATA_KEY, classConstructor) || [];

        if (!columnsList.includes(propertyKey)) {
            columnsList.push(propertyKey);
            // Usamos defineOwnMetadata para evitar colisiones con clases padre/hijas
            Reflect.defineMetadata(TABLE_COLUMNS_METADATA_KEY, columnsList, classConstructor);
        }

        // 2. Configuración limpia
        const config: ColumnOptions = {
            name: options.name || propertyKey.toString(),
            type: options.type || 'string',
            required: options.required ?? false,
            default: options.default ?? null,
            isDeleteControl: options.isDeleteControl || false,
            isAutoIncrement: options.isAutoIncrement || false,
            ...options
        };

        // 3. Registrar DETALLES (en el prototipo, vinculado a la propiedad específica)
        // Esto permite que getMetadata(TABLE_COLUMN_KEY, target, propertyKey) funcione.
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // 4. (Opcional) Registrar en el Mapa de detalles para búsqueda rápida
        const columnsDetails = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, target) || {};
        columnsDetails[propertyKey] = config;
        Reflect.defineMetadata(TABLE_COLUMN_DETAILS_KEY, columnsDetails, target);
    };
}