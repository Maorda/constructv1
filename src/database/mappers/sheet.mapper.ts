import 'reflect-metadata';
import { TABLE_COLUMN_KEY, ColumnOptions, TABLE_COLUMNS_METADATA_KEY } from '../decorators/column.decorator';
/*
*Descripcion: Clase encargada de mapear entidades a filas de Google Sheets y viceversa
*/
export class SheetMapper {
    /**
     * Compara los datos actuales contra los originales y devuelve 
     * solo las columnas que necesitan actualizarse.
     * * @param headers Los encabezados de la hoja (orden estricto)
     * @param originalEntity La entidad tal como estaba en la hoja
     * @param updatedEntity La entidad procesada con los nuevos cambios
     * @returns Un objeto con el índice de la columna y el nuevo valor
     */
    static getDeltaUpdate<T>(
        headers: string[],
        originalEntity: T,
        updatedEntity: T
    ): { colIndex: number, value: any, header: string }[] {
        const delta: { colIndex: number, value: any, header: string }[] = [];
        const target = Object.getPrototypeOf(updatedEntity);

        // Iteramos sobre las propiedades de la entidad actualizada
        Object.getOwnPropertyNames(updatedEntity).forEach(key => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            if (options) {
                const headerName = options.name || key;
                const colIndex = headers.indexOf(headerName);

                if (colIndex !== -1) {
                    const originalVal = originalEntity[key];
                    const updatedVal = updatedEntity[key];

                    // Comparación profunda para fechas y valores primitivos
                    if (!this.areEqual(originalVal, updatedVal)) {
                        delta.push({
                            colIndex,
                            value: this.formatForSheet(updatedVal, options.type),
                            header: headerName
                        });
                    }
                }
            }
        });

        return delta;
    }

    /**
     * Comparador de igualdad para evitar actualizaciones innecesarias
     */
    private static areEqual(val1: any, val2: any): boolean {
        if (val1 instanceof Date && val2 instanceof Date) {
            return val1.getTime() === val2.getTime();
        }
        // Comparación simple para strings, numbers, booleans
        return val1 === val2;
    }

    /**
     * Obtiene los nombres de las columnas (headers) definidos en los decoradores @Column
     */
    static getColumnHeaders(EntityClass: new () => any): string[] {
        const instance = new EntityClass();
        const target = EntityClass.prototype;
        // Obtenemos todas las claves que tienen metadatos de columna registrados
        const props = Reflect.getMetadata('sheets:all_columns', target) || Object.getOwnPropertyNames(instance);

        return props
            .map(key => {
                const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key) as ColumnOptions;
                return options ? (options.name || key) : null;
            })
            .filter(header => header !== null);
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
     * Transforma una fila (array) en una instancia de Entidad con tipos correctos.
     * Basado en las propiedades decoradas de la clase.
     */
    static mapToEntity<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const instance = new EntityClass();
        const target = EntityClass.prototype;

        // Obtenemos todas las propiedades que tienen el decorador @Column
        // Esto es más fiable que Object.getOwnPropertyNames
        const columns: string[] = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target) || [];

        for (const key of columns) {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            if (options) {
                const columnName = options.name || key;
                const colIndex = headers.indexOf(columnName);
                const rawValue = colIndex !== -1 ? row[colIndex] : undefined;

                // Aplicamos el casting inteligente
                (instance as any)[key] = this.castValue(
                    rawValue,
                    options.type,
                    options.default
                );
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

    static castValue(value: any, type: string = 'string', defaultValue: any = null) {
        if (value === undefined || value === null || String(value).trim() === '') {
            return defaultValue;
        }

        switch (type) {
            case 'number':
                // Quitamos espacios y normalizamos la coma decimal
                const cleanNum = String(value).replace(/\s/g, '').replace(',', '.');
                const num = Number(cleanNum);
                return isNaN(num) ? defaultValue : num;

            case 'currency':
                // 1. Quitamos "S/", "$", y cualquier letra, pero MANTENEMOS el punto y la coma
                let valStr = String(value).replace(/[A-Za-z/$\s]/g, '');

                // 2. Si hay comas y puntos (ej: 1,200.50), quitamos la coma de miles
                if (valStr.includes(',') && valStr.includes('.')) {
                    valStr = valStr.replace(/,/g, '');
                } else {
                    // 3. Si solo hay coma, la volvemos punto decimal (ej: 1200,50)
                    valStr = valStr.replace(',', '.');
                }

                const currencyNum = parseFloat(valStr);
                return isNaN(currencyNum) ? defaultValue : currencyNum;

            case 'boolean':
                const strBool = String(value).toLowerCase().trim();
                // Mantenemos tu excelente lista inclusiva
                return ['true', '1', 'si', 'yes', 'x', 'checked'].includes(strBool);

            case 'date':
                if (value instanceof Date) return value;

                let date = new Date(value);

                // Parser manual para formatos latinos DD/MM/YYYY
                if (isNaN(date.getTime()) && typeof value === 'string') {
                    const parts = value.split(/[-/]/); // Acepta 21-04-2026 o 21/04/2026
                    if (parts.length === 3) {
                        const [d, m, y] = parts.map(Number);
                        // Validamos que el año sea razonable (ej: evitar años de 2 dígitos si es necesario)
                        const fullYear = y < 100 ? y + 2000 : y;
                        date = new Date(fullYear, m - 1, d);
                    }
                }
                return isNaN(date.getTime()) ? defaultValue : date;

            default:
                return typeof value === 'string' ? value.trim() : String(value);
        }
    }
    /**
     * Convierte una entidad a fila (array), respetando el orden de los headers de la hoja
     */
    /**
 * Transforma una instancia de Entidad en una fila (array) para Google Sheets.
 * Mantiene la correspondencia con el orden de los encabezados.
 */
    static mapToRow<T>(headers: string[], entity: T): any[] {
        // Creamos un array vacío con la longitud de las columnas de la hoja
        const row = new Array(headers.length).fill('');
        const target = entity.constructor.prototype;

        headers.forEach((header, index) => {
            // 1. Obtenemos el valor de la propiedad (buscando por el nombre en el decorador o el nombre de la propiedad)
            const columns: string[] = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target) || [];

            // Buscamos qué propiedad de la clase corresponde a este encabezado de la columna
            const propKey = columns.find(key => {
                const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
                return (options?.name || key) === header;
            });

            if (propKey) {
                const value = (entity as any)[propKey];
                const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propKey);

                // 2. Aplicamos formato de salida según el tipo
                row[index] = this.formatValueForSheet(value, options?.type);
            }
        });

        return row;
    }

    /**
     * Formatea valores de TypeScript a formatos amigables para Google Sheets (Perú)
     */
    private static formatValueForSheet(value: any, type: string = 'string'): any {
        if (value === undefined || value === null) return '';

        switch (type) {
            case 'currency':
                // Formato moneda peruana: S/ 1,200.50
                if (typeof value !== 'number') return value;
                return new Intl.NumberFormat('es-PE', {
                    style: 'currency',
                    currency: 'PEN',
                    minimumFractionDigits: 2
                }).format(value);

            case 'date':
                // Formato de fecha peruana: DD/MM/YYYY
                if (!(value instanceof Date)) {
                    const d = new Date(value);
                    if (isNaN(d.getTime())) return value;
                    value = d;
                }
                return value.toLocaleDateString('es-PE');

            case 'boolean':
                // Convertimos a "SI" o "NO" para que sea más legible en la hoja
                return value === true ? 'SI' : 'NO';

            case 'number':
                // Aseguramos que el punto decimal sea el correcto según la configuración
                return typeof value === 'number' ? value : parseFloat(value);

            default:
                return String(value).trim();
        }
    }

    private static formatForSheet(value: any, type: string): any {
        if (value === null || value === undefined) return '';

        if (value instanceof Date) {
            // Formato estándar para que Google Sheets lo reconozca como fecha
            return value.toLocaleDateString('es-PE');
        }

        if (type === 'currency' && typeof value === 'number') {
            return value; // Dejamos que Sheets aplique el formato de moneda
        }

        return value;
    }
}