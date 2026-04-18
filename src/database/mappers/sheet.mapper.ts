import 'reflect-metadata';
import { TABLE_COLUMN_KEY, ColumnOptions } from '../decorators/column.decorator';
/*
*Descripcion: Clase encargada de mapear entidades a filas de Google Sheets y viceversa
*/
export class SheetMapper {
    // Lista de campos que sabemos que son fechas en tus entidades
    private static readonly DATE_FIELDS = ['fecha', 'fechaNacimiento', 'creadoEn', 'actualizadoEn'];

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
      * Convierte una entidad de TypeScript a un array de valores (fila)
      * basándose en el orden de los encabezados de la hoja.
      */
    static entityToRow<T>(entity: T, headers: string[]): any[] {
        return headers.map((header) => {
            const value = (entity as any)[header];

            // 1. Manejo de valores nulos o indefinidos
            if (value === undefined || value === null) {
                return '';
            }

            // 2. Manejo de objetos Date (convertir a formato que Sheets entienda)
            if (value instanceof Date) {
                // Podrías usar toLocaleDateString() si prefieres formato local
                return value.toISOString();
            }

            // 3. Manejo de Documentos Embebidos (si decidieras usar JSON en una celda)
            if (typeof value === 'object' && !Array.isArray(value)) {
                return JSON.stringify(value);
            }

            // 4. Manejo de Arrays (comentarios o etiquetas)
            if (Array.isArray(value)) {
                // Si son objetos complejos, los serializamos. Si son strings, los unimos.
                return typeof value[0] === 'object'
                    ? JSON.stringify(value)
                    : value.join(', ');
            }

            // 5. Valores primitivos (string, number, boolean)
            return value;
        });
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
        if (value === undefined || value === null || value === '') {
            return defaultValue;
        }

        switch (type) {
            case 'number':
                // Limpiamos espacios y aseguramos que el punto sea el separador decimal
                const cleanNum = String(value).replace(',', '.').trim();
                const num = Number(cleanNum);
                return isNaN(num) ? defaultValue : num;

            case 'currency':
                const cleanCurrency = String(value)
                    .replace(/[S/s.\s]/g, '')
                    .replace(',', '.');
                const currencyNum = parseFloat(cleanCurrency);
                return isNaN(currencyNum) ? defaultValue : currencyNum;

            case 'boolean':
                const strBool = String(value).toLowerCase().trim();
                return ['true', '1', 'si', 'yes', 'x'].includes(strBool);

            case 'date':
                // 1. Intentamos parsear lo que viene de Google
                let date = new Date(value);

                // 2. Si falla y parece fecha peruana (DD/MM/YYYY), la forzamos
                if (isNaN(date.getTime()) && typeof value === 'string' && value.includes('/')) {
                    const parts = value.split('/');
                    if (parts.length === 3) {
                        const [d, m, y] = parts.map(Number);
                        // El mes en JS es 0-11, por eso m - 1
                        date = new Date(y, m - 1, d);
                    }
                }

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