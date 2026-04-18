import { EntityFilterQuery } from "@database/types/query.types";
import { ExpressionEvaluator } from "./expression.evaluator";
import { OperatorsComparationsHandle } from "@database/utils/operators/operators.comparations.util";

export class QueryEngine<T extends object> {
    /**
         * Lógica interna para comparar el registro con el FilterQuery.
         * Soporta operadores de campo ($gt, $lt, etc.) y operadores lógicos ($and, $or, $not).
         */
    applyFilter(record: T, filter: EntityFilterQuery<T>): boolean {

        if (!filter || Object.keys(filter).length === 0) return true;
        return Object.entries(filter).every(([key, filterValue]) => {
            // 1. MANEJO DE OPERADORES LÓGICOS (RECURSIVOS)
            if (key === '$and' && Array.isArray(filterValue)) {
                return filterValue.every(subFilter => this.applyFilter(record, subFilter));
            }
            if (key === '$or' && Array.isArray(filterValue)) {
                return filterValue.some(subFilter => this.applyFilter(record, subFilter));
            }
            if (key === '$not') {
                return !this.applyFilter(record, filterValue as EntityFilterQuery<T>);
            }
            const recordValue = record[key as keyof T];
            const resolveDynamicValue = (val: any): any => {
                if (typeof val !== 'object' || val === null || val instanceof Date || Array.isArray(val)) {
                    return val;
                }
                const operator = Object.keys(val)[0];
                if (operator.startsWith('$date') || operator.startsWith('$day') || operator === '$add' || operator === '$subtract') {
                    return ExpressionEvaluator.evaluate(operator, val[operator], record);
                }
                return val;
            };
            if (typeof filterValue !== 'object' || filterValue === null || filterValue instanceof Date || Array.isArray(filterValue)) {
                return this.compare(recordValue, '$eq', filterValue);
            }
            return Object.entries(filterValue).every(([operator, value]) => {
                const finalExpectedValue = resolveDynamicValue(value);
                return this.compare(recordValue, operator, finalExpectedValue);
            });
        });
    }

    /**
    * Motor de comparación relacional mejorado
    */
    compare(actual: any, operator: string, expected: any): boolean {
        const normalize = (val: any) => {
            if (val instanceof Date) return val.getTime();
            if (val === null || val === undefined) return val;
            // Limpieza agresiva para Sheets: quitar espacios en blanco extra
            const cleanVal = typeof val === 'string' ? val.trim() : val;
            // Si es un número o un string que representa un número
            if (cleanVal !== '' && !isNaN(Number(cleanVal)) && typeof cleanVal !== 'boolean') { return Number(cleanVal); }
            return String(cleanVal).toLowerCase().trim();
        }; const a = normalize(actual); const e = normalize(expected);
        switch (operator) {
            case '$eq': return OperatorsComparationsHandle.ComparisonHandlers.eq([a, e]);
            case '$ne': return OperatorsComparationsHandle.ComparisonHandlers.ne([a, e]);
            case '$gt': return OperatorsComparationsHandle.ComparisonHandlers.gt([a, e]);
            case '$gte': return OperatorsComparationsHandle.ComparisonHandlers.gte([a, e]);
            case '$lt': return OperatorsComparationsHandle.ComparisonHandlers.lt([a, e]);
            case '$lte': return OperatorsComparationsHandle.ComparisonHandlers.lte([a, e]);
            case '$in': return OperatorsComparationsHandle.ComparisonHandlers.in([a, e]);
            //not in se usa generalmente en el filtrado o validaciones dentro de un if 
            // o en el motor de busqueda
            case '$nin': return OperatorsComparationsHandle.ComparisonHandlers.nin(a, e);
            case '$exists': return OperatorsComparationsHandle.ComparisonHandlers.exists(a, e);
            case '$regex':
                try {
                    return OperatorsComparationsHandle.ComparisonHandlers.regex(a, e);
                } catch {
                    return false;
                }
            default: return false;
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