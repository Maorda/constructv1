//clase estatica que me permita ejecutar directmante la clase sin instanciarla 
//es decir que pueda usar los metodos directamente sin crear una instancia de la clase
//por ejemplo: MathHandlers.simple(current, val, op) en lugar de MathHandlers.getInstance().simple(current, val, op)

/**
* HANDLERS DE TIEMPO (Cronos)
* Operaciones de fechas, duraciones y comparaciones temporales.
*/
/*
 * Utilidades puras para la manipulación de fechas en el motor de Sheets.
 * Centraliza la lógica para evitar duplicidad en los evaluadores.
 */
import { asDate, getValue, normalizeForMath } from "../tools";
import { OperatorsLogicalHandleUtil } from "./operators.logical.util";
export class OperatorsDateHandleUtil {

    /**
     * @description Agrega una cantidad de tiempo a una fecha
     * @param record Registro de la entidad
     * @param params Parámetros de la operación
     * @returns Fecha modificada
     */
    static dateAdd<T extends object>(record: T, params: any): Date | number | string {
        const date = asDate(params.startDate || params.date, record);
        const amount = Number(normalizeForMath(getValue(params.amount, record)) || 0);
        if (params.unit === 'day') date.setDate(date.getDate() + amount);
        if (params.unit === 'month') date.setMonth(date.getMonth() + amount);
        if (params.unit === 'year') date.setFullYear(date.getFullYear() + amount);
        if (params.unit === 'hour') date.setHours(date.getHours() + amount);
        if (params.unit === 'minute') date.setMinutes(date.getMinutes() + amount);
        if (params.unit === 'second') date.setSeconds(date.getSeconds() + amount);

        return date;
    };
    static dateTrunc<T extends object>(record: T, params: any): any {
        const date = getBaseDate(record, params);
        if (params.unit === 'day') date.setHours(0, 0, 0, 0);
        if (params.unit === 'month') date.setDate(1); // Inicio de mes
        return date;
    }
    static hour<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getHours();
    }
    static minute<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getMinutes();
    }
    static second<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getSeconds();
    }
    static day<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getDate();
    }
    static month<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getMonth() + 1;
    }
    static year<T extends object>(record: T, params: any): any {
        const date = getBaseDate(record, params);
        return date.getFullYear();
    }
    static dateDiff<T extends object>(record: T, params: any): any {
        const date1 = asDate(params.date1, record);
        const date2 = asDate(params.date2, record);
        const diffInMs = Math.abs(date1.getTime() - date2.getTime());
        const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
        return diffInDays;
    }
    static dayOfMonth<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getDate();
    }
    static dayOfWeek<T extends object>(record: T, params: any): any {
        return new Date(resolveValue(record, params)).getDay() + 1;
    }
    static week<T extends object>(record: T, params: any): any {
        const date = getBaseDate(record, params);
        const startOfYear = new Date(date.getFullYear(), 0, 1);
        const diff = date.getTime() - startOfYear.getTime();
        const oneDay = 1000 * 60 * 60 * 24;
        const days = Math.floor(diff / oneDay);
        return Math.floor(days / 7) + 1;
    }






    /**
     * Mapa literal para resolver los operadores de condición
     */
    static ConditionHandlers: Record<string, Function> = {
        '$eq': OperatorsLogicalHandleUtil.ComparisonHandlers.eq,
        '$ne': OperatorsLogicalHandleUtil.ComparisonHandlers.ne,
        '$gt': OperatorsLogicalHandleUtil.ComparisonHandlers.gt,
        '$lt': OperatorsLogicalHandleUtil.ComparisonHandlers.lt,
        '$gte': OperatorsLogicalHandleUtil.ComparisonHandlers.gte,
        '$lte': OperatorsLogicalHandleUtil.ComparisonHandlers.lte,
        '$in': OperatorsLogicalHandleUtil.ComparisonHandlers.in,
        '$and': OperatorsLogicalHandleUtil.ComparisonHandlers.and,
        '$or': OperatorsLogicalHandleUtil.ComparisonHandlers.or
    };


    /**
     * $after: Verifica si la fecha A es estrictamente posterior a la fecha B.
     * @param date Fecha a evaluar
     * @param limit Fecha de referencia (límite)
     */
    static after(date: any, limit: any): boolean {
        const d = new Date(date);
        const l = new Date(limit);

        if (isNaN(d.getTime()) || isNaN(l.getTime())) return false;

        return d.getTime() > l.getTime();
    };

    /**
     * $before: Verifica si la fecha A es estrictamente anterior a la fecha B.
     * @param date Fecha a evaluar
     * @param limit Fecha de referencia (límite)
     */
    static before(date: any, limit: any): boolean {
        const d = new Date(date);
        const l = new Date(limit);

        if (isNaN(d.getTime()) || isNaN(l.getTime())) return false;

        return d.getTime() < l.getTime();
    }


}




// Función auxiliar para resolver si el valor es un campo de la fila o un valor fijo
function resolveValue<T extends object>(record: T, keyOrValue: any): any {
    return record[keyOrValue as keyof T] !== undefined ? record[keyOrValue as keyof T] : keyOrValue;
}
// Obtenemos la fecha base (si se provee una propiedad de la entidad o un string)
function getBaseDate<T extends object>(record: T, params: any) {
    if (params.date) return new Date(resolveValue(record, params.date));
    return new Date();
}