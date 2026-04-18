import 'reflect-metadata';
import { TABLE_COLUMN_KEY } from './column.decorator';

export const PRIMARY_KEY_METADATA_KEY = Symbol('primaryKey');

export function PrimaryKey(): PropertyDecorator {
    return (target: Object, propertyKey: string | symbol) => {
        Reflect.defineMetadata(PRIMARY_KEY_METADATA_KEY, propertyKey, target.constructor);
    };
}

/**
 * Obtiene el nombre real de la columna (en Sheets) marcada como PrimaryKey
 */
export function getPrimaryKeyColumnName(EntityClass: any): string | undefined {
    const propertyKey = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, EntityClass);
    if (!propertyKey) return undefined;

    // Buscamos el nombre definido en el decorador @Column de esa propiedad
    const options = Reflect.getMetadata(TABLE_COLUMN_KEY, EntityClass.prototype, propertyKey);
    return options?.name || (propertyKey as string);
}