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
export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const classConstructor = target.constructor;

        // --- 1. LISTA ORDENADA (En el Constructor) ---
        // Obtenemos la lista existente o un array vacío
        const existingList = Reflect.getMetadata(SHEETS_COLUMN_LIST, classConstructor) || [];

        // Clonamos para evitar mutar metadatos de clases padre accidentalmente
        const columnsList = [...existingList];

        if (!columnsList.includes(propertyKey)) {
            columnsList.push(propertyKey);
            Reflect.defineMetadata(SHEETS_COLUMN_LIST, columnsList, classConstructor);
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
        // Clave para que getPropertyKeyByColumnName funcione
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // --- 4. ACCESO RÁPIDO PARA BORRADO LÓGICO ---
        if (config.isDeleteControl) {
            Reflect.defineMetadata(SHEETS_DELETE_CONTROL, propertyKey, classConstructor);
        }

        // --- 5. MAPA DE DETALLES (En el Prototipo) ---
        // Vital para SchemaFactory y SheetDocument (Evita el retorno {})
        const existingDetails = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, target) || {};
        const details = { ...existingDetails, [propertyKey]: config }; // Clonación de objeto

        Reflect.defineMetadata(SHEETS_COLUMN_DETAILS, details, target);
    };

}