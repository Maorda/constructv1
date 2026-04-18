
import { Logger } from "@nestjs/common";

export class DateOperatorService {
    private readonly logger = new Logger(DateOperatorService.name);

    /**
     * @param operator Nombre del operador (ej: '$dateAdd', '$dateDiff')
     * @param params Parámetros del operador (ej: { unit: 'days', amount: 5 })
     * @param record El registro actual (puede ser {} en caso de Upsert)
     */
    public evaluateDateOperator(operator: string, params: any, record: any): any {

        // 1. Validar que existan parámetros
        if (!params) {
            throw new Error(`Los parámetros para ${operator} son obligatorios.`);
        }

        // 2. Determinar la fecha base (Lógica de Upsert)
        // Si el record tiene la fecha, la usamos; si no, usamos la fecha actual (now)
        // Asumimos que la fecha base viene en params.startDate o es el valor actual del campo
        let baseDateRaw = params.startDate
            ? (record[params.startDate] || params.startDate)
            : null;

        // Si no hay baseDate en params, intentamos usar una fecha genérica o el record actual
        let date = this.isValidDate(baseDateRaw)
            ? new Date(baseDateRaw)
            : new Date(); // Fallback para Upsert: Fecha actual

        // 3. Ejecución de operadores
        switch (operator) {
            case '$dateAdd':
                return this.handleDateAdd(date, params);

            case '$dateDiff':
                return this.handleDateDiff(date, params, record);

            case '$dayOfWeek':
                // Retorna un número del 1 (Domingo) al 7 (Sábado)
                return date.getDay() + 1;

            default:
                console.warn(`Operador de fecha no reconocido: ${operator}`);
                return date;
        }
    }
    /**
      * Mapa de estrategias: cada llave es un operador y su valor es la función que lo ejecuta.
      */
    private readonly operators: Record<string, (record: any, params: any) => any> = {
        '$dateAdd': (record, params) => DateUtils.dateAdd(record, params),
        '$dayOfMonth': (record, params) => DateUtils.dayOfMonth(record, params),
        '$dayOfWeek': (record, params) => DateUtils.dayOfWeek(record, params),
        '$hour': (record, params) => DateUtils.hour(record, params),
        '$dateDiff': (record, params) => DateUtils.dateDiff(record, params),
        '$dateTrunc': (record, params) => DateUtils.dateTrunc(record, params),
        '$minute': (record, params) => DateUtils.minute(record, params),
        '$second': (record, params) => DateUtils.second(record, params),
        '$day': (record, params) => DateUtils.day(record, params),
        '$month': (record, params) => DateUtils.month(record, params),
        '$year': (record, params) => DateUtils.year(record, params),
        '$week': (record, params) => DateUtils.week(record, params),

    };

    /**
     * Ejecuta un operador de fecha con validación integral
     */
    public execute(params: Record<string, any>, record?: any): any {
        try {
            // 1. Identificar el operador
            const operator = Object.keys(params)[0];
            const handler = this.operators[operator];

            // 2. Validaciones preventivas
            if (!handler) return params; // Si no es un operador conocido, devolver tal cual

            const config = params[operator];
            if (!config || typeof config !== 'object') {
                throw new Error(`Configuración inválida para ${operator}. Se esperaba un objeto.`);
            }

            // 3. Ejecución y validación de resultado
            const result = handler(config, record);

            if (result === 'Invalid Date' || (result instanceof Date && isNaN(result.getTime()))) {
                throw new Error(`El cálculo de ${operator} resultó en una fecha no válida.`);
            }

            return result;
        } catch (error) {
            this.logger.error(`[DateOperatorService] Error ejecutando ${this.operators[Object.keys(params)[0]]}:`, error.message);
            throw error; // Re-lanzamos para que ManipulateEngine lo capture
        }
    }
    private isValidDate(d: any): boolean {
        const date = new Date(d);
        return d && !isNaN(date.getTime());
    }
}