import { ClassType, FilterQuery } from "@database/types/query.types";
import { ExpressionEvaluator } from "./expression.evaluator";
import { Injectable } from "@nestjs/common";
import { OperatorsComparationsHandleUtil } from "@database/utils/operators/operators.comparations.util";
import { ModuleRef } from "@nestjs/core";

@Injectable()
export class CompareEngine {
    /**
         * Lógica interna para comparar el registro con el FilterQuery.
         * Soporta operadores de campo ($gt, $lt, etc.) y operadores lógicos ($and, $or, $not).
         */
    constructor(
        private readonly moduleRef: ModuleRef,

    ) {
        //super(entityClass);
        // En el constructor de QueryEngine
        //this.applyFilter = this.applyFilter.bind(this)
    }

    /**
     * EVALUADOR DE FILTROS (Punto de entrada)
     * Mejora: Uso de bucles for...of y extracción de lógica estática para maximizar velocidad.
     */
    applyFilter<T extends Record<string, any>>(record: T, filter: FilterQuery<T>): boolean {
        // 1. Short-circuit: Si no hay filtro, el registro es válido.
        if (!filter || Object.keys(filter).length === 0) return true;

        // 🔬 LOG TEMPORAL DE DIAGNÓSTICO
        if (filter['dni'] || filter['DNI']) {
            console.log('====================================================');
            console.log('[CompareEngine 🎯] FILA LEÍDA DESDE GOOGLE SHEETS:', JSON.stringify(record));
            console.log('[CompareEngine 🎯] FILTRO COMPLETO RECIBIDO:', JSON.stringify(filter));
            console.log('====================================================');
        }
        // 2. Iteración sobre las condiciones del filtro
        // Mejora: Object.entries es necesario aquí para obtener llave/valor, 
        // pero evaluamos la salida temprana (fail-fast).
        for (const [key, filterValue] of Object.entries(filter)) {

            // --- BLOQUE 1: OPERADORES LÓGICOS (RECURSIVOS) ---
            if (key === '$and' && Array.isArray(filterValue)) {
                if (!filterValue.every(subFilter => this.applyFilter(record, subFilter))) return false;
                continue;
            }
            if (key === '$or' && Array.isArray(filterValue)) {
                if (!filterValue.some(subFilter => this.applyFilter(record, subFilter))) return false;
                continue;
            }
            if (key === '$not') {
                if (this.applyFilter(record, filterValue as FilterQuery<T>)) return false;
                continue;
            }

            // --- BLOQUE 2: EXTRACCIÓN DE VALOR Y NORMALIZACIÓN ---
            const recordValue = record[key];

            // Si el valor del filtro NO es un objeto (es un valor directo como string, number, Date)
            // se asume una comparación de igualdad ($eq)
            if (this.isPrimitive(filterValue)) {
                if (!this.evaluateOperator(recordValue, '$eq', filterValue)) return false;
                continue;
            }

            // --- BLOQUE 3: OPERADORES DE COMPARACIÓN ($gt, $in, $regex, etc.) ---
            // Mejora: Iteramos los operadores del campo (ej: { $gt: 10, $lt: 20 })
            for (const [operator, val] of Object.entries(filterValue as object)) {
                const finalExpectedValue = this.resolveDynamicValue(val, record);
                if (!this.evaluateOperator(recordValue, operator, finalExpectedValue)) {
                    return false; // Si un operador del campo falla, todo el campo falla (AND implícito)
                }
            }
        }

        return true; // Pasó todas las pruebas
    }

    /**
     * MEJORA: Método privado estático para evitar recrear la función resolveDynamicValue.
     */
    private resolveDynamicValue(val: any, record: any): any {
        // Si no es un objeto de expresión, devolvemos el valor tal cual
        if (typeof val !== 'object' || val === null || val instanceof Date || Array.isArray(val)) {
            return val;
        }

        const keys = Object.keys(val);
        if (keys.length === 0) return val;

        const operator = keys[0];

        // Verificamos si es una expresión computable (Diferenciamos operadores de valores)
        if (operator.startsWith('$date') || operator.startsWith('$day') || operator === '$add' || operator === '$subtract') {
            return ExpressionEvaluator.evaluate(operator, val[operator], record);
        }

        return val;
    }

    /**
     * Identifica si un valor es primitivo o una instancia "final" (no un objeto de filtros)
     */
    private isPrimitive(val: any): boolean {
        return (
            typeof val !== 'object' ||
            val === null ||
            val instanceof Date ||
            Array.isArray(val)
        );
    }

    private evaluateOperator(currentValue: any, operator: string, expectedValue: any): boolean {
        // 1. NORMALIZACIÓN DE FECHAS
        // Si ambos son fechas (o uno es fecha y el otro string de fecha), los convertimos a timestamp
        // para que las comparaciones (<, >, ===) funcionen matemáticamente.
        let valA = currentValue;
        let valB = expectedValue;

        if (valA instanceof Date || valB instanceof Date) {
            valA = valA instanceof Date ? valA.getTime() : new Date(valA).getTime();
            valB = valB instanceof Date ? valB.getTime() : new Date(valB).getTime();
        }

        switch (operator) {
            case '$eq':
                return valA === valB;

            case '$ne':
                return valA !== valB;

            case '$gt':
                return valA > valB;

            case '$gte':
                return valA >= valB;

            case '$lt':
                return valA < valB;

            case '$lte':
                return valA <= valB;

            case '$in':
                if (!Array.isArray(expectedValue)) return false;
                // Para $in con fechas, normalizamos el array de búsqueda
                return expectedValue.map(v => (v instanceof Date ? v.getTime() : v)).includes(valA);

            case '$nin':
                if (!Array.isArray(expectedValue)) return true;
                // $nin es la negación exacta de $in
                const normalizedIn = expectedValue.map(v => (v instanceof Date ? v.getTime() : v));
                return !normalizedIn.includes(valA);

            case '$regex':
                try {
                    return new RegExp(expectedValue, 'i').test(String(currentValue));
                } catch {
                    return false;
                }

            case '$exists':
                const exists = currentValue !== undefined && currentValue !== null;
                return expectedValue ? exists : !exists;

            default:
                return false;
        }
    }

    /**
 * Ordena un array de registros basándose en uno o varios campos.
 * @param records El array de datos traídos de Sheets.
 * @param sortOptions Un objeto tipo { presupuesto: -1, nombre: 1 }
 * 1 = Ascendente, -1 = Descendente
 */
    applySort(records: any[], sortOptions: Record<string, 1 | -1>): any[] {
        if (!sortOptions || Object.keys(sortOptions).length === 0) return records;

        return [...records].sort((a, b) => {
            for (const key in sortOptions) {
                const direction = sortOptions[key];
                const valA = a[key];
                const valB = b[key];

                if (valA === valB) continue;

                // Lógica de comparación universal (Soporta números, strings y fechas)
                if (valA > valB) return direction === 1 ? 1 : -1;
                if (valA < valB) return direction === 1 ? -1 : 1;
            }
            return 0;
        });
    }

    /**
 * Aplica recortes al array de resultados (Paginación).
 * @param records El array (ya filtrado y ordenado).
 * @param limit Cantidad máxima de registros a devolver.
 * @param skip Cantidad de registros a saltar (offset).
 */
    applyPagination(records: any[], limit?: number, skip?: number): any[] {
        let startIndex = skip || 0;
        let endIndex = records.length;

        if (limit !== undefined) {
            endIndex = startIndex + limit;
        }

        return records.slice(startIndex, endIndex);
    }

}