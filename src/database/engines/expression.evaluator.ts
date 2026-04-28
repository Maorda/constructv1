import { OperatorsMutationHandleUtil } from "@database/utils/operators/operators.mutation.util";
import { normalizeForMath } from "@database/utils/tools";

export class ExpressionEvaluator {
    /*
    *@description: Este metodo es el encargado de evaluar las expresiones
    *@param operator: El operador a evaluar
    *@param params: Los parametros del operador
    *@param record: El registro a evaluar
    *@param currentFieldPath: El path del campo actual
    *@returns: El resultado de la evaluacion
    */
    static evaluate<T extends object>(operator: string, params: any, record: T, currentFieldPath?: string): any {
        const getValue = (p: any) => record[p as keyof T] !== undefined ? record[p as keyof T] : p;
        const asDate = (p: any) => {
            const v = getValue(p); return v instanceof Date ? v : new Date(v);
        };
        switch (operator) {
            // --- OPERADORES ARITMÉTICOS ---
            case '$add':
                return params.reduce((acc: number, curr: any) => {
                    const val = getValue(curr); return acc + (isNaN(Number(val)) ? 0 : Number(val));
                }, 0);
            case '$subtract':
                return Number(normalizeForMath(getValue(params[0])) || 0) -
                    Number(normalizeForMath(getValue(params[1])) || 0);
            // --- OPERADORES DE EXTRACCIÓN ---
            case '$dayOfMonth': return asDate(params).getDate();
            case '$dayOfWeek': return asDate(params).getDay() + 1;
            case '$hour': return asDate(params).getHours();
            // --- OPERADORES DE MANIPULACIÓN ---
            case '$dateAdd': {
                // 1. Intentamos obtener la fecha base de tres lugares en orden de prioridad:
                //    A. De params.startDate (si el usuario definió una fecha específica)
                //    B. Del campo actual en el registro (usando currentFieldPath)
                //    C. Fecha actual (fallback total)

                const baseDate = params.startDate
                    ? getValue(params.startDate)
                    : (currentFieldPath ? record[currentFieldPath as keyof T] : new Date());

                const resultDate = OperatorsMutationHandleUtil.mutationHandlers.dateAdd(baseDate, params, currentFieldPath);

                return resultDate.toISOString();
            }
            case '$dateTrunc': {
                const date = asDate(params.date);
                if (params.unit === 'day') date.setHours(0, 0, 0, 0);
                if (params.unit === 'month') date.setDate(1);
                return date;
            } case '$dateToString': {
                const date = asDate(params.date);
                if (params.format === '%Y-%m-%d') return date.toISOString().split('T')[0];
                return date.toLocaleString();
            } default: return params;
        }
    }
}