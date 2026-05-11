import 'reflect-metadata';

// 1. Definición de llaves usando Symbols para mayor seguridad
export const TABLE_COLUMN_KEY = Symbol('sheets:column_config');
export const TABLE_COLUMNS_METADATA_KEY = Symbol('sheets:columns_list');
export const TABLE_COLUMN_DETAILS_KEY = Symbol('sheets:columns_details');

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
        // En un PropertyDecorator, 'target' es el prototipo.
        // Usamos el constructor para guardar la lista global de la clase.
        const classConstructor = target.constructor;

        // --- 1. ACUMULADOR: LISTA GLOBAL (ORDEN) ---
        // Usamos getMetadata para permitir herencia, o getOwnMetadata si prefieres aislamiento total
        const columnsList: (string | symbol)[] =
            Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, classConstructor) || [];

        if (!columnsList.includes(propertyKey)) {
            columnsList.push(propertyKey);
            Reflect.defineMetadata(TABLE_COLUMNS_METADATA_KEY, columnsList, classConstructor);
        }

        // --- 2. NORMALIZACIÓN DE CONFIGURACIÓN ---
        const config: ColumnOptions = {
            name: options.name || propertyKey.toString(),
            type: options.type || 'string',
            required: options.required ?? false,
            default: options.default ?? null,
            isDeleteControl: options.isDeleteControl || false,
            isAutoIncrement: options.isAutoIncrement || false,
        };

        // --- 3. REGISTRO DE DETALLES INDIVIDUALES ---
        // Esto permite rescatar la info de una sola propiedad:
        // Reflect.getMetadata(TABLE_COLUMN_KEY, target, propertyKey)
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // --- 4. ACUMULADOR: MAPA DE DETALLES ---
        // Útil para el SheetMapper: evita múltiples llamadas a Reflect en un bucle
        const columnsDetails = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, target) || {};
        columnsDetails[propertyKey] = config;
        Reflect.defineMetadata(TABLE_COLUMN_DETAILS_KEY, columnsDetails, target);
    };
}