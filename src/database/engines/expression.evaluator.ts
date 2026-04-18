import { OperatorsDateHandle } from "@database/utils/operators/operators.date.utils";
import { normalizeForMath } from "@database/utils/tools";

export class ExpressionEvaluator {

    static evaluate<T extends object>(operator: string, params: any, record: T): any {
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
                return DateUtils.dateAdd(record, params);
            } case '$dateTrunc': {
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