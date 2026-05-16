import 'reflect-metadata';
import { ColumnOptions } from '../../decorators/column.decorator';
import dayjs, { tz } from 'dayjs';
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
import { GettersEngine } from '@database/engine/getters.engine';
import { ClassType } from '@database/types/query.types';


// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
import {
    SHEETS_COLUMN_LIST,
    TABLE_COLUMN_KEY
} from '@database/constants/metadata.constants';


/*
*Descripcion: Clase encargada de mapear entidades a filas de Google Sheets y viceversa
*/
export class SheetMapper<T extends object> {
    private readonly logger = new Logger(SheetMapper.name);
    constructor(
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly entity: ClassType<T>,
        private readonly googleAuthService: GoogleAutenticarService,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) { }
    private static getPropertyKeyByColumnName(entityClass: ClassType<any>, columnName: string): string | undefined {
        const target = entityClass.prototype;

        // 1. CORRECCIÓN: Usar la constante unificada SHEETS_COLUMN_LIST
        const columns: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass) || [];

        return columns.find(key => {
            // Los detalles individuales están en el prototipo
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            // Comparamos de forma segura ignorando mayúsculas/minúsculas y espacios
            const currentColumnName = options?.name || String(key);
            return currentColumnName.trim().toLowerCase() === columnName.trim().toLowerCase();
        });
    }
    private getFullRange(specificRange: string): string {
        // Verificamos que el gateway ya tenga el nombre procesado
        const name = this.gateway.sheetName || this.entity.name;

        /**
         * IMPORTANTE: Usamos comillas simples alrededor del nombre de la hoja.
         * Esto previene el error "Unable to parse range" si el nombre tiene
         * caracteres especiales o es puramente numérico.
         */
        return `'${name}'!${specificRange}`;
    }

    /**
     * Sincroniza el esquema de la hoja de Google Sheets.
     * Compara las cabeceras actuales con las definidas en los decoradores de la Entidad.
     */
    async syncSchema(force: boolean = false): Promise<void> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const sheetName = this.gateway.sheetName; //this.EntityClass.name;

        try {
            // Fuente de verdad: Metadatos del código (con tu caché)
            const expected = await this.gateway.getHeaders();
            const headerRange = this.getFullRange('1:1');

            // Realidad actual: Fila 1 de Google Sheets (sin caché)
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                range: headerRange,
            });
            const current = response.data.values?.[0] || [];

            // Validación usando el nuevo método
            if (force || this.checkDesync(expected, current)) {
                this.logger.warn(`Desincronización detectada en ${sheetName}. Actualizando...`);

                await this.gateway.updateRowRaw(spreadsheetId, `${sheetName}!1:1`, [expected]);

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
            case 'json':
                try {
                    // Si ya es objeto, lo devolvemos, si no, intentamos parsear
                    return typeof value === 'string' ? JSON.parse(value) : value;
                } catch (e) {
                    return defaultValue || {};
                }
            case 'number':
                // Quitamos espacios y normalizamos la coma decimal
                const cleanNum = String(value).replace(/\s/g, '').replace(',', '.');
                const num = Number(cleanNum);
                return isNaN(num) ? defaultValue : num;

            case 'currency':
                // Limpieza agresiva de símbolos peruanos y espacios
                let clean = String(value).replace(/[S/$.\s,]/g, (match) => {
                    // Si es coma y hay punto después, es separador de miles, lo quitamos.
                    // Si es la última coma, podría ser decimal.
                    return match === ',' ? '' : '';
                });

                // Lógica simplificada: eliminamos todo lo que no sea dígito o punto decimal
                const numericString = String(value).replace(/[^0-9.,-]/g, '');
                // Convertimos formato "1.200,50" a "1200.50"
                const normalized = numericString.includes(',') && numericString.includes('.')
                    ? numericString.replace(/\./g, '').replace(',', '.')
                    : numericString.replace(',', '.');

                const currencyNum = parseFloat(normalized);
                return isNaN(currencyNum) ? defaultValue : currencyNum;

            case 'boolean':
                const strBool = String(value).toLowerCase().trim();
                // Mantenemos tu excelente lista inclusiva
                return ['true', '1', 'si', 'yes', 'x', 'checked'].includes(strBool);

            case 'date':
                if (value instanceof Date) return dayjs(value).tz(appTimezone).toDate();

                const formats = 'DD/MM/YYYY'//, 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY'];
                // Plugin customParseFormat habilitado
                const djsDate = dayjs.tz(String(value), formats, appTimezone);

                return djsDate.isValid()
                    ? djsDate.hour(12).minute(0).second(0).toDate()
                    : defaultValue;
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
     * Convierte una Entidad TS a una fila (array) respetando los headers actuales del Excel.
     */
    mapEntityToRow(headers: string[], entity: T): any[] {
        const target = this.entity.prototype;

        return headers.map(header => {
            // CORRECCIÓN DE LLAMADA: Pasamos this.entity (que es la clase)
            const propKey = SheetMapper.getPropertyKeyByColumnName(this.entity, header);
            if (!propKey) return '';

            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propKey);
            const value = (entity as any)[propKey];

            return SheetMapper.prepareValueForSheet(value, options?.type);
        });
    }


    /**
 * Transforma una fila de Google Sheets en una instancia de Entidad,
 * inyectando el índice de fila para futuras actualizaciones.
 */
    // --- MÉTODOS DE MAPEO (INSTANCIA) ---

    /**
     * Convierte una fila del Excel a una Entidad TS.
     * Centraliza mapRowToEntity, mapFromRow y mapToEntity.
     */
    /**
     * CENTRALIZADO: Convierte una fila de Sheets a una Entidad TS.
     * Reemplaza a mapRowToEntity, mapFromRow y mapToEntity.
     */
    /**
     * CENTRALIZADO: Convierte una fila de Sheets a una Entidad TS.
     * Reemplaza todos los métodos anteriores de mapeo de entrada.
     */
    mapRowToEntity(headers: string[], row: any[], rowIndex: number): T {
        const instance = new this.entity();
        const target = this.entity.prototype;

        // Metadata interna para rastreo físico
        (instance as any).__row = rowIndex;

        // DEFINICIÓN CORRECTA DE TZ (como string)
        const appTimezone = process.env.TIMEZONE || 'America/Lima';

        const columns: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, this.entity) || [];

        columns.forEach(propKey => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propKey);
            if (!options) return;

            const colName = options.name || propKey;

            const colIndex = headers.findIndex(h =>
                h.trim().toLowerCase() === colName.toString().toLowerCase()
            );

            if (colIndex !== -1 && row[colIndex] !== undefined) {
                (instance as any)[propKey] = SheetMapper.castValue(
                    row[colIndex],
                    options.type,
                    options.default,
                    appTimezone // Ahora pasamos el string, no el plugin
                );
            }
        });

        return instance;
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
    static getColumnHeaders(EntityClass: ClassType<any>): string[] {
        // 1. Buscamos la lista de propiedades (el array ['dni', 'nombres', etc.])
        // Intentamos primero en la Clase (Constructor), que es donde el decorador Column lo inyecta.
        const props: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, EntityClass);

        if (!props || props.length === 0) {
            // Log de ayuda para debuguear en la consola de NestJS
            console.error(`[Metadata Error] No se encontraron columnas para: ${EntityClass.name}. 
        Verifica que las propiedades tengan el decorador @Column() y que estés importando 'reflect-metadata'.`);

            throw new Error(`La entidad ${EntityClass.name} no tiene columnas decoradas.`);
        }

        // 2. Mapeamos cada propiedad TS a su nombre de cabecera en Google Sheets
        return props.map(key => {
            // Los detalles de cada columna (@Column options) SIEMPRE están en el prototipo
            const options = Reflect.getMetadata(
                TABLE_COLUMN_KEY,
                EntityClass.prototype,
                key
            ) as ColumnOptions;

            // Si existe el nombre decorado (ej: "DNI_OBRERO"), lo usamos. 
            // Si no, usamos el nombre de la variable (ej: "dni").
            return options?.name || String(key);
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




    /**
     * Formatea valores de TypeScript a formatos amigables para Google Sheets (Perú)
     */
    static formatValueForSheet(value: any, type: string = 'string'): any {
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

    /**
         * Compara los datos actuales contra los originales y devuelve 
         * solo las columnas que necesitan actualizarse.
         * * @param headers Los encabezados de la hoja (orden estricto)
         * @param originalEntity La entidad tal como estaba en la hoja
         * @param updatedEntity La entidad procesada con los nuevos cambios
         * @returns Un objeto con el índice de la columna y el nuevo valor
         */
    static getDeltaUpdate<T extends object>(
        headers: string[],
        original: T,
        updated: T,
        entityClass: ClassType<T>
    ): { colIndex: number, value: any, header: string }[] {
        const delta: any[] = [];
        const target = entityClass.prototype;

        // Solo comparamos propiedades que existan en el objeto actualizado
        Object.keys(updated).forEach(key => {
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (!options) return;

            const headerName = options.name || key;
            const colIndex = headers.findIndex(h => h.toLowerCase() === headerName.toLowerCase());

            if (colIndex !== -1) {
                const oVal = (original as any)[key];
                const uVal = (updated as any)[key];

                // Usamos una comparación profunda simplificada
                if (!this.areEqual(oVal, uVal)) {
                    delta.push({
                        colIndex: colIndex + 1, // Google Sheets es base 1
                        value: this.prepareValueForSheet(uVal, options.type),
                        header: headerName
                    });
                }
            }
        });
        return delta;
    }



}