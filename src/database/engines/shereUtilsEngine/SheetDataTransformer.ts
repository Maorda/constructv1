import { Injectable } from "@nestjs/common";
import dayjs, { tz } from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { ISheetDataTransformer } from "./interfaces/sheet.mapper.interface";

@Injectable()
export class SheetDataTransformer implements ISheetDataTransformer {
    /*
    *Descripcion: Convierte un valor crudo de la hoja de cálculo al tipo de dato
    *             correcto de TypeScript.
    */
    public castValue(value: any, type: string = 'string', defaultValue: any = null, appTimezone: string = 'UTC') {
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
     * Prepara el valor para ser insertado en la celda de Google Sheets.
     */
    prepareValueForSheet(value: any, type: string = 'string'): any {
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
         * Formatea valores de TypeScript a formatos amigables para Google Sheets (Perú)
         */
    public formatValueForSheet(value: any, type: string = 'string'): any {
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
    public areEqual(val1: any, val2: any): boolean {
        if (val1 instanceof Date && val2 instanceof Date) {
            return val1.getTime() === val2.getTime();
        }
        // Comparación simple para strings, numbers, booleans
        return val1 === val2;
    }

    public formatForSheet(value: any, type: string): any {
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
