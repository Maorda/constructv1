
import dayjs from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export class OperatorsMutationHandleUtil {

    /**
     * HANDLERS DE CADENA Y LÓGICA (Strings & Logic)
     * Manipulación de texto y estructuras de control.
     */
    static mutationHandlers = {
        // Simplificado para que el motor lo llame directamente
        upper: (val: any) => String(val || '').toUpperCase(),
        trim: (val: any) => String(val || '').trim(),

        // El condicional que usa el ManipulateEngine
        conditional: (config: { if: boolean, then: any, else: any }) => {
            return config.if ? config.then : config.else;
        },
        /**
         * $concat: Une una lista de elementos en un solo string.
         * @param parts Arreglo de valores ya resueltos por el motor.
         */
        /** Recibe un arreglo de valores ya resueltos */
        concat: (parts: any[]): string => {
            return parts.map(p => String(p ?? '')).join('');
        },

        /** Recibe el arreglo resuelto y el string del delimitador */
        join: (data: any[], delimiter: string): string => {
            return data
                .map(p => String(p ?? ''))
                .filter(val => val.trim() !== '') // Evita separadores dobles si hay vacíos
                .join(delimiter);
        },
        /** $dateAdd: Sumar tiempo */
        /** $dateAdd: Sumar tiempo de forma atómica */
        dateAdd: (baseDate: any, amount: number, unit: string): Date => {
            // 1. Prioridad: baseDate (ya resuelta) o fecha actual como fallback
            const d = new Date(baseDate || new Date());

            // 2. Validación de seguridad
            if (isNaN(d.getTime())) return new Date();

            const result = new Date(d);
            const unitClean = unit?.toLowerCase();

            // 3. Lógica de suma simplificada
            switch (unitClean) {
                case 'day': case 'days':
                    result.setDate(result.getDate() + amount);
                    break;
                case 'month': case 'months':
                    result.setMonth(result.getMonth() + amount);
                    break;
                case 'year': case 'years':
                    result.setFullYear(result.getFullYear() + amount);
                    break;
                case 'hour': case 'hours':
                    result.setHours(result.getHours() + amount);
                    break;
                case 'minute': case 'minutes':
                    result.setMinutes(result.getMinutes() + amount);
                    break;
            }

            return result;
        }
        ,

        /** $dateTrunc: Resetear a inicio de día/mes */
        dateTrunc: (date: any, unit: 'day' | 'month'): Date => {
            const d = new Date(date);
            if (unit === 'day') d.setHours(0, 0, 0, 0);
            if (unit === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); }
            return d;
        },


        /**
         * $round: Redondea un número a una cantidad específica de decimales.
         * @param value El número a redondear.
         * @param decimals Cantidad de decimales (por defecto 2).
         */
        round: (value: any, decimals: number = 2): number => {
            const num = parseFloat(value);
            if (isNaN(num)) return 0;
            // Lógica de redondeo precisa
            const factor = Math.pow(10, decimals);
            return Math.round(num * factor) / factor;
        },
        dateDiff: (date1: any, date2: any, unit: string = 'day'): number => {
            // Función auxiliar para convertir "HH:mm" en una fecha válida de hoy
            const parseDate = (val: any) => {
                if (typeof val === 'string' && val.includes(':') && !val.includes('-')) {
                    const [hh, mm] = val.split(':');
                    const d = new Date();
                    d.setHours(parseInt(hh), parseInt(mm), 0, 0);
                    return d;
                }
                return new Date(val);
            };

            const d1 = parseDate(date1);
            const d2 = parseDate(date2);

            if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;

            const diffInMs = d2.getTime() - d1.getTime();

            switch (unit) {
                case 'hour':
                    // Usamos parseFloat si quieres decimales (ej: 6.5 horas) 
                    // o Math.floor para horas enteras.
                    return diffInMs / (1000 * 60 * 60);
                // ... resto de casos
            }
        }

    }


}