export class OperatorsMathHandleUtil {
    static MathHandlers = {
        /**
         * $inc: Incremento atómico. Compatible con Upsert (si current es null).
         */
        increment: (current: any, val: number): number => {
            const base = Number(current) || 0;
            return base + (Number(val) || 0);
        },

        /**
         * $mul: Multiplicación atómica.
         */
        multiply: (current: any, val: number): number => {
            const base = Number(current) || 0;
            return base * (Number(val) || 0);
        },

        /**
         * $minMax: Resuelve límites. 
         * Mejorado para ser consistente con tipos 'min' | 'max'
         */
        minMax: (current: any, target: number, type: 'min' | 'max'): number => {
            const proposedValue = Number(target);
            if (current === undefined || current === null || current === '') {
                return proposedValue;
            }
            const currentValue = Number(current);
            if (isNaN(currentValue)) return proposedValue;

            return type === 'min'
                ? Math.min(currentValue, proposedValue)
                : Math.max(currentValue, proposedValue);
        },

        /**
         * $round: Redondeo con precisión dinámica.
         */
        round: (value: any, precisionFromConfig?: number): number => {
            let num: number;
            let precision: number = precisionFromConfig || 0;

            if (value && typeof value === 'object') {
                num = Number(value.val) || 0;
                precision = Number(value.precision) || precision;
            } else {
                num = Number(value) || 0;
            }

            const factor = Math.pow(10, precision);
            return Math.round(num * factor) / factor;
        },

        /**
         * $math: Evaluación de expresiones.
         * Se agregó soporte para Math.abs, Math.round, etc., muy usados en presupuestos.
         */
        math(expression: string, record: any): number {
            if (!expression || typeof expression !== 'string') return 0;

            try {
                const resolvedExpression = expression.replace(/\$([a-zA-Z0-9_]+)/g, (match, fieldName) => {
                    const value = record && record[fieldName] !== undefined ? record[fieldName] : 0;
                    return `(${Number(value) || 0})`;
                });

                // Whitelist extendida para permitir funciones matemáticas básicas de JS
                const safeExpression = resolvedExpression.replace(/[^0-9+\-*/().\s,Mathabsroundceilfloor]/g, '');

                return Function(`"use strict"; return (${safeExpression})`)();
            } catch (error) {
                console.error(`[MathHandler] Error: ${expression}`, error);
                return 0;
            }
        }
    };
}