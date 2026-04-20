/*
Aquí deben ir todos los operadores que sirven para evaluar una condición
dentro de un $if o un filtro.
eq, ne, gt, lt, gte, lte: Son comparaciones matemáticas/lógicas puras.
in, nin: Son comparaciones de pertenencia a conjuntos.
exists: Para saber si una celda de Google Sheets tiene datos.
regex: Para búsquedas por patrones de texto.
after, before, afterOrEqual, beforeOrEqual: Aunque son de fechas,
su resultado es un SÍ o un NO. Ponerlos aquí permite que tu evaluateCondition sea genérico
y no tenga que saltar entre diferentes archivos para una simple comparación.
*/
export class OperatorsComparationsHandleUtil {
    /**
     * HANDLERS DE COMPARACIÓN (Query & Logic)
     * Utilizados para filtros y evaluaciones booleanas.
     * Aquí deben ir todos los operadores que sirven para evaluar una condición dentro de un $if o un filtro.
     */
    static ComparisonHandlers = {
        // Compara si dos valores son iguales
        eq: (args: any[]) => args[0] === args[1],
        // Compara si son diferentes
        ne: (args: any[]) => args[0] !== args[1],
        // Mayor que y Menor que (con conversión numérica de seguridad)
        gt: (args: any[]) => Number(args[0]) > Number(args[1]),
        // Menor que
        lt: (args: any[]) => Number(args[0]) < Number(args[1]),
        // Mayor o igual que
        gte: (args: any[]) => Number(args[0]) >= Number(args[1]),
        // Menor o igual que
        lte: (args: any[]) => Number(args[0]) <= Number(args[1]),
        // Verifica si un valor existe dentro de un arreglo
        in: (args: any[]) => Array.isArray(args[1]) && args[1].includes(args[0]),
        // Lógica de arreglos para múltiples condiciones
        and: (results: boolean[]) => results.every(res => res === true),
        or: (results: boolean[]) => results.some(res => res === true),
        exists: (a: any, b: any) => (a !== undefined && a !== null) === !!b,
        regex: (a: any, b: any) => new RegExp(String(b), 'i').test(String(a)),
        /**
     * $nin: Verifica si un valor NO está presente en un arreglo.
     * @param value Valor a buscar (puede venir del record)
     * @param array Arreglo de valores prohibidos
     * @returns boolean (true si NO está en el arreglo)
     */
        nin: (value: any, array: any[]): boolean => {
            if (!Array.isArray(array)) return true; // Si no hay arreglo, por defecto no está en él

            // Normalizamos strings para evitar errores por espacios o mayúsculas
            const normalizedValue = typeof value === 'string' ? value.trim() : value;

            return !array.some(item => {
                const normalizedItem = typeof item === 'string' ? item.trim() : item;
                return normalizedItem === normalizedValue;
            });
        },
        /** $after: Posterior a... */
        after: (date: any, limit: any): boolean => {
            const d = new Date(date);
            const l = new Date(limit);
            return !isNaN(d.getTime()) && !isNaN(l.getTime()) && d.getTime() > l.getTime();
        },

        /** $before: Anterior a... */
        before: (date: any, limit: any): boolean => {
            const d = new Date(date);
            const l = new Date(limit);
            return !isNaN(d.getTime()) && !isNaN(l.getTime()) && d.getTime() < l.getTime();
        },

        /**
         * $afterOrEqual: (>=) Verifica si la fecha es igual o posterior.
         */
        afterOrEqual: (date: any, limit: any): boolean => {
            const d = new Date(date);
            const l = new Date(limit);
            if (isNaN(d.getTime()) || isNaN(l.getTime())) return false;

            return d.getTime() >= l.getTime();
        },

        /**
         * $beforeOrEqual: (<=) Verifica si la fecha es igual o anterior.
         */
        beforeOrEqual: (date: any, limit: any): boolean => {
            const d = new Date(date);
            const l = new Date(limit);
            if (isNaN(d.getTime()) || isNaN(l.getTime())) return false;

            return d.getTime() <= l.getTime();
        },

    };

}