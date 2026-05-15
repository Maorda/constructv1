import 'reflect-metadata';



import {
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
    // 1. Obtenemos la propiedad TS (ej: 'dni')
    const propertyKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, EntityClass);
    if (!propertyKey) return undefined;

    // 2. Buscamos su configuración en el mapa de detalles del prototipo
    const details = Reflect.getMetadata(TABLE_COLUMN_KEY, EntityClass.prototype) || {};
    const config = details[propertyKey];

    // 3. Devolvemos el nombre de la columna (ej: 'DNI') o la propiedad como fallback
    return config?.name || (propertyKey as string);
}