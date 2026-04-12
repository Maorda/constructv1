import 'reflect-metadata';
import { TABLE_COLUMN_KEY, ColumnOptions } from '../decorators/column.decorator';

export class SheetMapper {

    static getColumnHeaders(EntityClass: new () => any): string[] {
        const instance = new EntityClass();
        const target = EntityClass.prototype; // Los metadatos de @Column viven aquí

        // Obtenemos las propiedades. 
        // Nota: Si props sale vacío, asegúrate de inicializar tus variables en la Entity (ej: dni: string = '')
        const props = Object.getOwnPropertyNames(instance);
        const headers: string[] = [];

        for (const key of props) {
            // Buscamos el metadato vinculado al prototipo Y a la propiedad específica
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key) as ColumnOptions;

            if (options) {
                // Si el decorador tiene 'name', lo usamos; si no, el nombre de la variable
                headers.push(options.name || key);
            }
        }

        return headers;
    }
    /**
     * Transforma una fila de Google Sheets en una instancia de Entidad
     */
    static mapToEntity<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const instance = new EntityClass();
        const target = EntityClass.prototype;

        // Obtenemos todas las propiedades decoradas de la clase
        const props = Object.getOwnPropertyNames(instance);
        for (const key of props) {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (options) {
                const colIndex = headers.indexOf(options.name || key)
                //const colIndex = headers.indexOf(options.name);
                const rawValue = colIndex !== -1 ? row[colIndex] : undefined;
                // Si es requerido y no existe, lanzamos advertencia o error
                if (options.required && (rawValue === undefined || rawValue === '')) {
                    console.warn(`[SheetsMapper] Campo requerido "${options.name}" está vacío para la propiedad "${key}"`);
                }
                // Asignamos el valor procesado o el valor por defecto
                instance[key] = this.castValue(rawValue, options.type, options.default);
            }
        }
        return instance;
    }
    // src/database/utils/sheet-mapper.ts

    static mapFromRow<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const entity = new EntityClass();
        const target = EntityClass.prototype;

        headers.forEach((header, index) => {
            const value = row[index];
            // Aquí podrías buscar qué propiedad de la clase tiene el @Column(name: header)
            // Para simplificar, buscamos la propiedad que coincida con el metadato
            const propertyKey = this.getPropertyKeyByColumnName(target, header);

            if (propertyKey) {
                entity[propertyKey] = value;
            }
        });

        return entity;
    }


    private static getPropertyKeyByColumnName(target: any, columnName: string): string | undefined {
        // Obtenemos todas las propiedades de la clase que tienen metadatos
        const properties = Object.getOwnPropertyNames(target);

        // Si Object.getOwnPropertyNames no devuelve las propiedades decoradas (común en TS),
        // podemos iterar sobre las llaves de metadatos si tu decorador las registra.
        // Pero una forma segura es buscar en las llaves del prototipo:
        return properties.find(key => {
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            return options && options.name === columnName;
        });
    }

    /**
     * Sistema de casting inteligente
     */
    private static castValue(value: any, type: string = 'string', defaultValue: any = null) {
        // Si el valor es nulo o vacío, usamos el default
        if (value === undefined || value === null || value === '') {
            return defaultValue;
        }

        switch (type) {
            case 'number':
                const num = Number(String(value).replace(',', '.').trim());
                return isNaN(num) ? defaultValue : num;

            case 'currency':
                // Limpia "S/", espacios y comas para el contexto peruano
                const cleanCurrency = String(value)
                    .replace(/[S/s.\s]/g, '')
                    .replace(',', '.');
                const currencyNum = parseFloat(cleanCurrency);
                return isNaN(currencyNum) ? defaultValue : currencyNum;

            case 'boolean':
                const strBool = String(value).toLowerCase().trim();
                return ['true', '1', 'si', 'yes', 'x'].includes(strBool);

            case 'date':
                // Maneja fechas de Sheets. Si es un número (serial de Excel/Sheets), lo convierte.
                const date = new Date(value);
                return isNaN(date.getTime()) ? defaultValue : date;

            default:
                return String(value).trim();
        }
    }

    /**
     * Convierte una entidad de vuelta a un array para guardar en Sheets
     */
    static mapToRow<T>(headers: string[], entity: T): any[] {
        const target = Object.getPrototypeOf(entity);
        const row = new Array(headers.length).fill('');

        for (const key of Object.getOwnPropertyNames(entity)) {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            if (options) {
                const colIndex = headers.indexOf(options.name);
                if (colIndex !== -1) {
                    row[colIndex] = this.formatForSheet(entity[key], options.type);
                }
            }
        }
        return row;
    }

    private static formatForSheet(value: any, type: string): any {
        if (value instanceof Date) {
            return value.toLocaleDateString('es-PE'); // Formato DD/MM/YYYY para Perú
        }
        return value;
    }
}