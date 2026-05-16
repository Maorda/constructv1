import 'reflect-metadata';



import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_PRIMARY_KEY,
    TABLE_COLUMN_KEY // <--- CAMBIO: Usar esta en lugar de details
} from '../constants/metadata.constants';

/**
 * Decorador @PrimaryKey
 * Identifica la propiedad que actúa como identificador único en la hoja.
 */
export function PrimaryKey(): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        // Almacenamos la propiedad string en el constructor de la clase
        Reflect.defineMetadata(SHEETS_PRIMARY_KEY, propertyKey.toString(), target.constructor);
    };
}

/**
 * Obtiene el nombre de cabecera física real mapeada en Google Sheets
 */
export function getPrimaryKeyColumnName(EntityClass: any): string | undefined {
    const propertyKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, EntityClass);
    if (!propertyKey) return undefined;

    // Buscamos directamente en el Constructor de la clase (Centralizado)
    const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, EntityClass) || {};
    const config = details[propertyKey];

    return config?.name || (propertyKey as string);
}