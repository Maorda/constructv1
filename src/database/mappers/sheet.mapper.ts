import 'reflect-metadata';
import { TABLE_COLUMN_KEY, ColumnOptions } from '../decorators/column.decorator';
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
     * Transforma una fila (array) en una instancia de Entidad con tipos correctos
     */
    static mapToEntity<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const instance = new EntityClass();
        const target = EntityClass.prototype;
        const props = Object.getOwnPropertyNames(instance);

        for (const key of props) {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (options) {
                const colIndex = headers.indexOf(options.name || key);
                const rawValue = colIndex !== -1 ? row[colIndex] : undefined;

                // Aplicamos el casting inteligente que ya programaste
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
     * Convierte una entidad a fila (array), respetando el orden de los headers de la hoja
     */
    static mapToRow<T>(headers: string[], entity: T): any[] {
        const target = Object.getPrototypeOf(entity);
        const row = new Array(headers.length).fill('');

        // Iteramos sobre las propiedades de la entidad
        Object.getOwnPropertyNames(entity).forEach(key => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (options) {
                const headerName = options.name || key;
                const colIndex = headers.indexOf(headerName);
                if (colIndex !== -1) {
                    row[colIndex] = this.formatForSheet(entity[key], options.type);
                }
            }
        });

        return row;
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