import { OperatorsMathHandleUtil } from "./operators.math.util";
import dayjs from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { OperatorsMutationHandleUtil } from "@database/utils/operators/operators.mutation.util";

// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
export class OperatorsExpressionUtil {
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
}