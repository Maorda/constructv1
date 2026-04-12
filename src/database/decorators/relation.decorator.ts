import 'reflect-metadata';

// Clave única para los metadatos de relación
export const RELATION_METADATA_KEY = Symbol('sheets:relation');

/**
 * Define cómo se conecta una entidad con otra
 */
export interface RelationOptions {
    /** Función que retorna la clase de la entidad destino (evita dependencias circulares) */
    targetEntity: () => new () => any;

    /** Nombre de la pestaña en Google Sheets donde están los datos relacionados */
    targetSheet: string;

    /** La columna en la pestaña DESTINO que hace de llave foránea (ej: 'DNI') */
    joinColumn: string;

    /** El campo en la entidad LOCAL que contiene el valor para el match (ej: 'dni') */
    localField: string;

    /** Indica si la relación es un array (Uno a Muchos) o un objeto único (Uno a Uno) */
    isMany?: boolean;
}

/**
 * Decorador @Relation
 * Se usa para definir vínculos entre diferentes pestañas de Google Sheets.
 */
export function Relation(options: RelationOptions): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        // Por defecto asumimos que es una relación de muchos (ej: un empleado tiene muchos adelantos)
        const config: RelationOptions = {
            isMany: true,
            ...options,
        };

        Reflect.defineMetadata(RELATION_METADATA_KEY, config, target, propertyKey);

        // Opcional: Registrar que esta propiedad es una relación para el motor de populate
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', target) || [];
        if (!relations.includes(propertyKey.toString())) {
            relations.push(propertyKey.toString());
            Reflect.defineMetadata('sheets:all_relations', relations, target);
        }
    };
}