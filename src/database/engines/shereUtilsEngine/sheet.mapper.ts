import 'reflect-metadata';
import { TABLE_COLUMN_KEY, ColumnOptions, TABLE_COLUMNS_METADATA_KEY } from '../../decorators/column.decorator';

import dayjs from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí


// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
/*
*Descripcion: Clase encargada de mapear entidades a filas de Google Sheets y viceversa
*/
export class SheetMapper<T> {
    private readonly logger = new Logger(SheetMapper.name);
    constructor(@
        Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly EntityClass: new () => T,
        private readonly googleAuthService: GoogleAutenticarService,
        private readonly sheetService: SheetsDataGateway<T>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) {

    }

    /**
     * Sincroniza el esquema de la hoja de Google Sheets.
     * Compara las cabeceras actuales con las definidas en los decoradores de la Entidad.
     */
    async syncSchema(force: boolean = false): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const sheetName = this.EntityClass.name;

        try {
            // Fuente de verdad: Metadatos del código (con tu caché)
            const expected = await this.sheetService.getHeaders();

            // Realidad actual: Fila 1 de Google Sheets (sin caché)
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!1:1`,
            });
            const current = response.data.values?.[0] || [];

            // Validación usando el nuevo método
            if (force || this.checkDesync(expected, current)) {
                this.logger.warn(`Desincronización detectada en ${sheetName}. Actualizando...`);

                await this.sheetService.updateRowRaw(spreadsheetId, `${sheetName}!1:1`, [expected]);

                // Opcional: Limpiar el caché después de actualizar para asegurar consistencia
                await this.cacheManager.del(`headers_strict:${sheetName}`);
            }
        } catch (error) {
            this.logger.error(`Error en sync: ${error.message}`);
        }
    }

    /**
    * Compara los encabezados esperados (código) con los actuales (Google Sheets).
    * @returns true si hay un desajuste y se requiere sincronización.
    */
    private checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
        // 1. Si la longitud es distinta, hay desincronización inmediata
        if (expectedHeaders.length !== currentHeaders.length) {
            return true;
        }

        // 2. Comparamos cada elemento
        // Usamos .some() para que en cuanto encuentre uno diferente, devuelva true
        return expectedHeaders.some((expected, index) => {
            const current = currentHeaders[index];

            // Normalizamos ambos valores para una comparación justa:
            // - Convertimos a String (por si Google devuelve números o nulls)
            // - Quitamos espacios en blanco (.trim())
            // - Pasamos a Mayúsculas (.toUpperCase())
            const normalizedExpected = String(expected || '').trim().toUpperCase();
            const normalizedCurrent = String(current || '').trim().toUpperCase();

            return normalizedExpected !== normalizedCurrent;
        });
    }

    /*
    *Descripcion: Convierte un valor crudo de la hoja de cálculo al tipo de dato
    *             correcto de TypeScript.
    */
    static castValue(value: any, type: string = 'string', defaultValue: any = null, appTimezone: string = 'UTC') {
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
                // 1. Normalización total: quitamos S/, $, espacios y letras
                let clean = String(value).replace(/[A-Za-z/$\s]/g, '');

                // 2. Inteligencia de Separadores (Soporte para S/ 1,200.50 o 1.200,50)
                const hasComma = clean.includes(',');
                const hasDot = clean.includes('.');

                if (hasComma && hasDot) {
                    // Si tiene ambos, el último es el decimal. 
                    // Si la coma está después del punto, el formato es Europeo/Manual.
                    if (clean.lastIndexOf(',') > clean.lastIndexOf('.')) {
                        clean = clean.replace(/\./g, '').replace(',', '.');
                    } else {
                        clean = clean.replace(/,/g, '');
                    }
                } else if (hasComma) {
                    // Si solo hay coma, asumimos que es decimal (1200,50 -> 1200.50)
                    clean = clean.replace(',', '.');
                }

                const currencyNum = parseFloat(clean);
                return isNaN(currencyNum) ? defaultValue : currencyNum;

            case 'boolean':
                const strBool = String(value).toLowerCase().trim();
                // Mantenemos tu excelente lista inclusiva
                return ['true', '1', 'si', 'yes', 'x', 'checked'].includes(strBool);

            case 'date':
                if (value instanceof Date) return dayjs(value).tz(appTimezone).toDate();

                // Definimos los formatos como una constante
                const formats = ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY'];

                // CORRECCIÓN: Usamos dayjs.tz con el valor y el array de formatos.
                // Si TS sigue quejándose del array, usamos (formats as any) 
                // porque el plugin customParseFormat es el que habilita esta capacidad.
                const djsDate = dayjs.tz(String(value), formats as any, appTimezone);

                if (djsDate.isValid()) {
                    // Retornamos mediodía para evitar saltos de día internacionales
                    return djsDate.hour(12).minute(0).second(0).toDate();
                }
                return defaultValue;
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
    static mapToRow<T extends object>(
        headers: string[],
        entity: T,
        columnDetails: Record<string, ColumnOptions>
    ): any[] {
        // Creamos un mapa inverso: Nombre de Cabecera -> Propiedad de Clase
        // Esto es vital porque headers[] contiene lo que hay en el Excel (ej: "ID_OBRERO")
        const headerToPropMap: Record<string, string> = {};
        Object.keys(columnDetails).forEach(propKey => {
            const config = columnDetails[propKey];
            const headerName = config.name || propKey;
            headerToPropMap[headerName.toLowerCase()] = propKey;
        });

        // Construimos la fila basándonos ESTRICTAMENTE en el orden de los headers del Excel
        return headers.map(header => {
            const propKey = headerToPropMap[header.trim().toLowerCase()];

            if (!propKey) return ''; // Columna en Excel que no existe en la Entidad

            const value = (entity as any)[propKey];
            const config = columnDetails[propKey];

            // Aplicamos el "uncast" o formateo de salida
            return this.prepareValueForSheet(value, config.type);
        });
    }


    /**
 * Transforma una fila de Google Sheets en una instancia de Entidad,
 * inyectando el índice de fila para futuras actualizaciones.
 */
    static mapRowToEntity<T>(
        headers: string[],
        row: any[],
        index: number, // Recibimos el índice de la iteración
        EntityClass: new () => T,
        columnDetails: Record<string, ColumnOptions>
    ): T {
        //const entity = new EntityClass();
        // 1. Mapeo normal de columnas físicas (lo que ya tenemos)
        const entity = this.createPhysicalEntity(headers, row, index, EntityClass, columnDetails);

        // Inyectamos el índice de fila (base 0)
        // Usamos 'as any' para evitar que TS se queje de la propiedad invisible
        (entity as any).__row = index;

        Object.keys(columnDetails).forEach((propKey) => {
            const config = columnDetails[propKey];
            const colName = config.name || propKey;

            const colIndex = headers.findIndex(
                h => h.trim().toLowerCase() === colName.toLowerCase()
            );

            if (colIndex !== -1) {
                const rawValue = row[colIndex];
                const tz = process.env.TIMEZONE || 'America/Lima';

                (entity as any)[propKey] = this.castValue(
                    rawValue,
                    config.type,
                    config.default,
                    tz
                );
            }
        });

        return entity;
    }
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
        // Ya no necesitas instanciar con 'new EntityClass()'
        // Buscamos directamente en el constructor (la clase)
        const props: string[] = Reflect.getOwnMetadata(TABLE_COLUMNS_METADATA_KEY, EntityClass) || [];

        return props.map(key => {
            // Los detalles están en el prototipo
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, EntityClass.prototype, key) as ColumnOptions;
            return options ? options.name : key;
        });
    }

    /**
      * Convierte una entidad de TypeScript a un array de valores (fila)
      * basándose en el orden de los encabezados de la hoja.
      */
    /**
 * Convierte una instancia de entidad en una fila (array) para Google Sheets,
 * garantizando que cada valor esté bajo su encabezado correcto según los metadatos.
 */
    static entityToRow<T>(entity: T): any[] {
        // 1. Obtenemos la clase constructora y el prototipo
        const EntityClass = entity.constructor as new () => T;
        const target = EntityClass.prototype;

        // 2. Obtenemos los headers directamente desde los metadatos de la clase
        // Esto asegura que la fila siempre coincida con el esquema actual de la entidad
        const headers = this.getColumnHeaders(EntityClass);

        return headers.map((header) => {
            // 3. Traducimos el nombre de la columna del Excel a la propiedad de la clase TS
            const propertyKey = this.getPropertyKeyByColumnName(target, header);

            if (!propertyKey) return '';

            const value = (entity as any)[propertyKey];

            // --- Lógica de Serialización de Datos ---

            // Manejo de nulos o indefinidos
            if (value === undefined || value === null) {
                return '';
            }

            // Manejo de Fechas (Formato ISO para consistencia)
            if (value instanceof Date) {
                return value.toISOString();
            }

            // Manejo de Arrays (Strings unidos por coma, Objetos como JSON)
            if (Array.isArray(value)) {
                return value.length > 0 && typeof value[0] === 'object'
                    ? JSON.stringify(value)
                    : value.join(', ');
            }

            // Manejo de Objetos/Documentos embebidos
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }

            // Valores primitivos (number, string, boolean)
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


    /**
     * 1. ¿Para qué sirve?
    *  Sirve para reconstruir el objeto basándose estrictamente en lo que existe en el Excel. Es especialmente útil cuando la hoja de cálculo tiene columnas que quizás no están mapeadas en tu entidad, 
    *o cuando el orden de las columnas en la web no coincide con el de la realidad física de la hoja.
     * Transforma una fila (array) en una instancia de Entidad con tipos correctos.
     * Basado en las propiedades decoradas de la clase.
     */
    static mapFromRow<T>(headers: string[], row: any[], EntityClass: new () => T): T {
        const entity = new EntityClass();
        const target = EntityClass.prototype;

        headers.forEach((header, index) => {
            const rawValue = row[index];
            const propertyKey = this.getPropertyKeyByColumnName(target, header);

            if (propertyKey) {
                // 1. Extraemos los metadatos de la columna para saber el TIPO
                const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propertyKey);

                // 2. INTEGRAMOS CASTVALUE AQUÍ
                // Ahora el valor no es solo un string, es un número, fecha o booleano real.
                entity[propertyKey] = this.castValue(
                    rawValue,
                    options?.type,
                    options?.default
                );
            }
        });

        return entity;
    }


    private static getPropertyKeyByColumnName(target: any, columnName: string): string | undefined {
        // 1. Intentamos obtener la lista de columnas registradas por el decorador @Column
        // Usamos el constructor del target porque ahí es donde se suelen guardar los metadatos de clase
        const columns: string[] = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target.constructor) || [];

        // 2. Buscamos cuál de esas propiedades tiene el 'name' que coincide con el header del Excel
        const foundKey = columns.find(key => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            // Si el decorador no tiene nombre explícito, se asume que el nombre de la columna es el de la propiedad
            const effectiveColumnName = options?.name || key;
            return effectiveColumnName === columnName;
        });

        // 3. Fallback: Si no está en la lista registrada, intentamos el método tradicional por si acaso
        if (!foundKey) {
            return Object.getOwnPropertyNames(target).find(key => {
                const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
                return options && options.name === columnName;
            });
        }

        return foundKey;
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
    /*
    *Descripcion: Formatea valores de TypeScript a formatos amigables para 
    *              Google Sheets (Perú)
    */
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

    /**
 * Prepara el valor para ser insertado en la celda de Google Sheets.
 */
    public static prepareValueForSheet(value: any, type: string = 'string'): any {
        if (value === undefined || value === null) return '';

        switch (type) {
            case 'date':
                // Si es Date de JS, lo enviamos tal cual; la API de Google lo detecta
                // si la celda tiene formato fecha. Si no, usamos un string ISO.
                if (value instanceof Date) return value;
                return value;

            case 'number':
            case 'currency':
                // Nos aseguramos de que sea un número real. 
                // Google Sheets se encargará de poner el "S/." según el formato de la celda.
                const num = parseFloat(value);
                return isNaN(num) ? 0 : num;

            case 'boolean':
                // Google Sheets maneja TRUE/FALSE nativos (útil para checkboxes)
                return !!value;

            default:
                return String(value).trim();
        }
    }


}