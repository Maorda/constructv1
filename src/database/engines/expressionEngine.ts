
import { Injectable } from "@nestjs/common";
import dayjs from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { OperatorsMathHandleUtil } from "@database/utils/operators/operators.math.util";
import { OperatorsMutationHandleUtil } from "@database/utils/operators/operators.mutation.util";
import { OperatorsExpressionUtil } from "@database/utils/operators/operators.expression.util";
import { ClassType } from "@database/types/query.types";
import { BaseEngine } from "./Base.Engine";

// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export class ExpressionEngine extends BaseEngine {
    constructor(
        entityClass: ClassType
    ) { super(entityClass); }
    // En ExpressionEngine / OperatorsExpressionUtil
    static expressionHandlers = {
        /**
         * Calcula la diferencia entre dos tiempos.
         * Ideal para: (Hora Salida - Hora Entrada)
         */
        timeDiff: (config: { start: any, end: any, unit: 'hour' | 'minute' | 'second' | 'day' }): number => {
            if (!config.start || !config.end) return 0;

            const start = dayjs(config.start);
            const end = dayjs(config.end);

            if (!start.isValid() || !end.isValid()) return 0;

            // Calculamos la diferencia
            let diff = end.diff(start, config.unit, true);

            // Lógica para Turnos Nocturnos: 
            // Si el fin es menor al inicio, asumimos que pasó a la medianoche (ej: 22:00 a 06:00)
            if (diff < 0 && config.unit === 'hour') {
                diff += 24;
            }

            return OperatorsMathHandleUtil.MathHandlers.round(diff, 2);
        }

    }

    private resolveValue(val: any, record: any): any {
        if (typeof val === 'string' && val.startsWith('$')) {
            return record[val.substring(1)] ?? null;
        }
        return val;
    }

    private executeOperator(operator: string, args: any, record: any): any {
        // Aquí conectas con OperatorsExpressionUtil (que crearemos)
        // Ejemplo simplificado para $timeDiff
        if (operator === '$timeDiff') {
            const start = this.resolveValue(args.start, record);
            const end = this.resolveValue(args.end, record);
            return ExpressionEngine.expressionHandlers.timeDiff({ start, end, unit: args.unit });
        }
        // ... otros operadores
    }

    /**
     * Resuelve una expresión de forma recursiva.
     */
    public evaluate(expression: any, record: any): any {
        // 1. Si es referencia a un campo (ej: "$sueldo_base")
        if (typeof expression === 'string' && expression.startsWith('$')) {
            return record[expression.substring(1)] ?? null;
        }

        // 2. Si es un objeto con un operador (ej: { $multiply: [...] })
        if (expression && typeof expression === 'object' && !Array.isArray(expression)) {
            const operator = Object.keys(expression).find(key => key.startsWith('$'));
            if (operator) {
                return this.runOperator(operator, expression[operator], record);
            }
            return expression; // Es un objeto literal sin operadores
        }

        // 3. Si es un valor primitivo (número, string, fecha)
        return expression;
    }

    private runOperator(op: string, config: any, record: any): any {
        switch (op) {
            case '$dateAdd':
                // RECURSIVIDAD: Resolvemos cada parámetro antes de llamar a la función
                const baseDate = this.evaluate(config.startDate, record);
                const amount = Number(this.evaluate(config.amount, record)) || 0;
                const unit = this.evaluate(config.unit, record) || 'day';

                // Llamada con los 3 parámetros posicionales exactos
                return OperatorsMutationHandleUtil.mutationHandlers.dateAdd(baseDate, amount, unit);

            case '$multiply':
                // Evalúa cada elemento del arreglo (que pueden ser otros operadores)
                if (Array.isArray(config)) {
                    return config.reduce((acc, curr) => {
                        return acc * (Number(this.evaluate(curr, record)) || 0);
                    }, 1);
                }
                return 0;

            case '$timeDiff':
                const start = this.evaluate(config.start, record);
                const end = this.evaluate(config.end, record);
                const unitT = this.evaluate(config.unit, record) || 'hour';
                return OperatorsMutationHandleUtil.mutationHandlers.dateDiff(start, end, unitT);

            default:
                return null;
        }
    }

    /** Punto de entrada para proyecciones y creación de campos */
    execute(record: any, projection: any): any {
        const result: any = {};
        for (const key in projection) {
            result[key] = this.evaluate(projection[key], record);
        }
        return result;
    }
}