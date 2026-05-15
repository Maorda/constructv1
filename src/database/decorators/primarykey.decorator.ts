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
        // Guardamos cuál es la propiedad TS que es PK en el constructor
        Reflect.defineMetadata(SHEETS_PRIMARY_KEY, propertyKey, target.constructor);
    };
}

/**
 * Obtiene el nombre real de la cabecera (en Google Sheets) marcada como PrimaryKey
 */
export function getPrimaryKeyColumnName(EntityClass: any): string | undefined {
    const propertyKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, EntityClass);
    if (!propertyKey) return undefined;

    // Buscamos en el mapa de detalles que acabamos de asegurar arriba
    const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, EntityClass.prototype) || {};
    const config = details[propertyKey];

    return config?.name || (propertyKey as string);
}