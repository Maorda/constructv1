import 'reflect-metadata';
import {
    SHEETS_COLUMN_DETAILS,
    SHEETS_COLUMN_LIST,
    SHEETS_DELETE_CONTROL,
    TABLE_COLUMN_KEY,
} from '../constants/metadata.constants';

export interface ColumnOptions {
    /** Nombre de la cabecera física real en la pestaña de Google Sheets */
    name?: string;

    /** * Tipo de dato para validación, formateo e hidratación.
     * Se añaden 'json' y 'array' para serialización automática de datos complejos.
     */
    type?: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'json' | 'array' | any;

    /** Si es true, el motor de validación impedirá almacenar valores nulos o vacíos */
    required?: boolean;

    /** Valor por defecto asignado automáticamente si la propiedad llega como undefined o null */
    default?: any;

    /** Identifica la propiedad que controla el borrado lógico (Soft Delete) */
    isDeleteControl?: boolean;

    /** Marca la columna como autoincrementable pura en secuencia (1, 2, 3...) */
    isAutoIncrement?: boolean;

    /** Estrategia de generación automatizada de claves al insertar registros */
    generated?: 'uuid' | 'short-id' | 'increment';
}

/**
 * Decorador @Column
 * Registra y estructura las propiedades de la entidad convirtiéndolas en celdas para el ecosistema Google Sheets.
 */
export function Column(options: ColumnOptions = {}): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const classConstructor = target.constructor;
        const propString = propertyKey.toString();

        // 1. LISTA ESTRUCTURAL ORDENADA (Para indexación posicional de celdas A, B, C...)
        const columnsList = Reflect.getMetadata(SHEETS_COLUMN_LIST, classConstructor) || [];
        if (!columnsList.includes(propString)) {
            columnsList.push(propString);
            Reflect.defineMetadata(SHEETS_COLUMN_LIST, columnsList, classConstructor);
        }

        // 2. NORMALIZACIÓN ESTRICTA DE OPCIONES
        const config: ColumnOptions = {
            name: options.name || propString,
            type: options.type || 'string',
            required: options.required ?? false,
            default: options.default ?? null,
            isDeleteControl: options.isDeleteControl || false,
            isAutoIncrement: options.isAutoIncrement || (options.generated === 'increment'),
            generated: options.generated
        };

        // 3. METADATA INDIVIDUAL POR PROPIEDAD
        Reflect.defineMetadata(TABLE_COLUMN_KEY, config, target, propertyKey);

        // 4. ACCESO DIRECTO PARA BORRADO LÓGICO (Optimiza búsquedas del motor)
        if (config.isDeleteControl) {
            Reflect.defineMetadata(SHEETS_DELETE_CONTROL, propString, classConstructor);
        }

        // 5. MAPA MAESTRO DE DETALLES (Es el búfer unificado que lee el PersistenceEngine)
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, classConstructor) || {};
        details[propString] = config;
        Reflect.defineMetadata(SHEETS_COLUMN_DETAILS, details, classConstructor);
    };
}