/*
eq, ne, gt, lt, gte, lte: Son comparaciones matemáticas/lógicas puras.
in, nin: Son comparaciones de pertenencia a conjuntos.
exists: Para saber si una celda de Google Sheets tiene datos.
regex: Para búsquedas por patrones de texto.
after, before, afterOrEqual, beforeOrEqual: Aunque son de fechas, su resultado es un SÍ o un NO. Ponerlos aquí permite que tu evaluateCondition sea genérico y no tenga que saltar entre diferentes archivos para una simple comparación.
*/
export class OperatorsLogicalHandleUtil {

    /**
         * HANDLERS DE COMPARACIÓN (Query & Logic)
         * Utilizados para filtros y evaluaciones booleanas.
         * Aquí deben ir todos los operadores que sirven para evaluar una condición dentro de un $if o un filtro.
         */
    static ComparisonHandlers = {
        // Verificación de arreglos
        in: (val: any, array: any[]) => Array.isArray(array) && array.includes(val),
        nin: (val: any, array: any[]) => Array.isArray(array) && !array.includes(val),
        and: (results: boolean[]) => results.every(res => res === true),
        or: (results: boolean[]) => results.some(res => res === true),
        exists: (a: any, b: any) => (a !== undefined && a !== null) === !!b,
        regex: (a: any, b: any) => new RegExp(String(b), 'i').test(String(a)),
        // Lógica de fechas (Compatibilidad con lo que pediste anteriormente)
        after: (a: any, b: any) => {
            const d1 = new Date(a);
            const d2 = new Date(b);
            return !isNaN(d1.getTime()) && !isNaN(d2.getTime()) && d1 > d2;
        },
        before: (a: any, b: any) => {
            const d1 = new Date(a);
            const d2 = new Date(b);
            return !isNaN(d1.getTime()) && !isNaN(d2.getTime()) && d1 < d2;
        }
    };

    /**
     * HANDLERS DE CADENA Y LÓGICA (Strings & Logic)
     * Manipulación de texto y estructuras de control.
     */
    static LogicHandlers = {
        // Simplificado para que el motor lo llame directamente
        upper: (val: any) => String(val || '').toUpperCase(),
        trim: (val: any) => String(val || '').trim(),

        // El condicional que usa el ManipulateEngine
        conditional: (config: { if: boolean, then: any, else: any }) => {
            return config.if ? config.then : config.else;
        },
        /**
      * $concat: Une elementos en un solo string sin separadores adicionales.
      * @param parts Arreglo de strings o referencias (ej: ["Cod-", "$id"])
      * @param record El registro actual para resolver las variables $
      */
        concat: (parts: any[], record: any): string => {
            if (!Array.isArray(parts)) return '';

            return parts.map(part => {
                if (typeof part === 'string' && part.startsWith('$')) {
                    const fieldName = part.substring(1);
                    return record?.[fieldName] ?? '';
                }
                return part ?? '';
            }).join('');
        },

        /**
     * $join: Une elementos usando un delimitador específico.
     * @param params Objeto con { data: string[], delimiter: string }
     * @param record El registro actual
     */
        join: (params: { data: any[], delimiter: string }, record: any): string => {
            const { data, delimiter = ' ' } = params;
            if (!Array.isArray(data)) return '';

            return data.map(item => {
                if (typeof item === 'string' && item.startsWith('$')) {
                    const fieldName = item.substring(1);
                    return record?.[fieldName] ?? '';
                }
                return item ?? '';
            })
                .filter(val => val !== '') // Opcional: evita separadores dobles si un campo está vacío
                .join(delimiter);
        },
    };


}