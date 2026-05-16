import 'reflect-metadata';

import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_COLUMN_LIST,
    SHEETS_DELETE_CONTROL,
    TABLE_COLUMN_KEY,
} from '../constants/metadata.constants'; // Ajusta la ruta a tu archivo de constantes

export interface ColumnOptions {
    /** Nombre de la cabecera en Google Sheets */
    name?: string;

    /** * Tipo de dato para validación e hidratación.
     * Se añaden 'json' y 'array' para datos complejos serializados.
     */
    type?: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'json' | 'array' | any;

    /** Si es true, el ManipulateEngine lanzará error si el valor es nulo/vacío */
    required?: boolean;

    /** Valor por defecto si no se proporciona uno */
    default?: any;

    /** Identifica la columna de 'deleted_at' o estado para borrado lógico */
    isDeleteControl?: boolean;

    /** * Marca la columna como autoincrementable (1, 2, 3...). 
     * Nota: Requiere lógica de conteo en el PersistenceEngine.
     */
    isAutoIncrement?: boolean;

    /** Estrategia de generación de ID automático al crear */
    generated?: 'uuid' | 'short-id' | 'increment';
}

/**
 * Decorador @Column
 * Actúa como acumulador para el motor de Sheets.
 */
export interface ColumnOptions {
    name?: string;
    type?: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'json' | 'array' | any;
    required?: boolean;
    default?: any;
    isDeleteControl?: boolean;
    isAutoIncrement?: boolean;
    generated?: 'uuid' | 'short-id' | 'increment';
}

export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const classConstructor = target.constructor;
        const propString = propertyKey.toString();

        // 1. LISTA ORDENADA DE PROPIEDADES EN EL CONSTRUCTOR
        const columnsList = Reflect.getMetadata(SHEETS_COLUMN_LIST, classConstructor) || [];
        if (!columnsList.includes(propString)) {
            columnsList.push(propString);
            Reflect.defineMetadata(SHEETS_COLUMN_LIST, columnsList, classConstructor);
        }

        // 2. CONFIGURACIÓN NORMALIZADA
        const config: ColumnOptions = {
            name: options.name || propString,
            type: options.type || 'string',
            required: options.required ?? false,
            default: options.default ?? null,
            isDeleteControl: options.isDeleteControl || false,
            isAutoIncrement: options.isAutoIncrement || false,
            generated: options.generated
        };

        // 3. METADATA INDIVIDUAL (En el Prototipo por propiedad)
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // 4. ACCESO RÁPIDO PARA BORRADO LÓGICO
        if (config.isDeleteControl) {
            Reflect.defineMetadata(SHEETS_DELETE_CONTROL, propString, classConstructor);
        }

        // 5. MAPA GLOBAL DE DETALLES (Sincronizado para SchemaFactory y PrimaryKey)
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, target.constructor) || {};
        details[propString] = config;
        Reflect.defineMetadata(SHEETS_COLUMN_DETAILS, details, target.constructor);
    };
}