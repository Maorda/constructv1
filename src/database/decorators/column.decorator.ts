import 'reflect-metadata';
// Clave única para los metadatos de las columnas
// Exportamos la llave para que otros archivos (como SheetMapper) la vean
export const TABLE_COLUMN_KEY = 'sheets:table_column';

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
    return (target: any, propertyKey: string | symbol) => {
        // IMPORTANTE: Definir el metadato sobre el target (prototipo) y la llave de la propiedad
        Reflect.defineMetadata(TABLE_COLUMN_KEY, options, target, propertyKey);
    };
}