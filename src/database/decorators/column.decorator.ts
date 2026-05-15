import 'reflect-metadata';

import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_DELETE_CONTROL,
    TABLE_COLUMN_KEY,
    TABLE_COLUMNS_METADATA_KEY
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
export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const classConstructor = target.constructor;

        // --- 1. LISTA ORDENADA (En el Constructor) ---
        // Usamos TABLE_COLUMNS_METADATA_KEY porque es lo que busca getColumnHeaders()
        const columnsList: (string | symbol)[] =
            Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, classConstructor) || [];

        if (!columnsList.includes(propertyKey)) {
            columnsList.push(propertyKey);
            Reflect.defineMetadata(TABLE_COLUMNS_METADATA_KEY, columnsList, classConstructor);
        }

        // --- 2. CONFIGURACIÓN NORMALIZADA ---
        const config: ColumnOptions = {
            name: options.name || propertyKey.toString(),
            type: options.type || 'string',
            required: options.required ?? false,
            default: options.default ?? null,
            isDeleteControl: options.isDeleteControl || false,
            isAutoIncrement: options.isAutoIncrement || false,
            generated: options.generated
        };

        // --- 3. METADATA INDIVIDUAL (En el Prototipo) ---
        // IMPORTANTE: El Mapper busca TABLE_COLUMN_KEY propiedad por propiedad
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // --- 4. ACCESO RÁPIDO PARA BORRADO LÓGICO ---
        if (config.isDeleteControl) {
            Reflect.defineMetadata(SHEETS_DELETE_CONTROL, propertyKey, classConstructor);
        }

        // --- 5. MAPA DE DETALLES (En el Prototipo) ---
        // Este es el que usa SheetDocument para toObject() y prepareForPersistence()
        const columnsDetails = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, target) || {};
        columnsDetails[propertyKey] = config;
        Reflect.defineMetadata(SHEETS_COLUMN_DETAILS, columnsDetails, target);
    };
}