export class OperatorsCollectionHandleUtil {
    /**
     * HANDLERS DE COLECCIONES (Agregaciones)
     * Operaciones que reducen un arreglo de valores a un solo resultado.
     */
    static CollectionHandlers = {
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


        /**
         * @description Realiza cálculos de agregación sobre un arreglo de valores.
         * @param values Arreglo de datos (generalmente de una columna de Google Sheets)
         * @param type Tipo de operación: 'sum' (Suma) o 'avg' (Promedio)
         */
        aggregate: (values: any[], type: 'sum' | 'avg'): number => {
            if (!Array.isArray(values) || values.length === 0) return 0;

            // 1. Filtramos y convertimos a números válidos (limpieza de datos)
            const numericValues = values
                .map(v => (typeof v === 'string' ? v.trim().replace(',', '.') : v)) // Manejo de decimales con coma
                .map(v => Number(v))
                .filter(v => !isNaN(v) && v !== null && typeof v === 'number');

            if (numericValues.length === 0) return 0;

            // 2. Ejecución de la lógica según el tipo
            const sum = numericValues.reduce((acc, curr) => acc + curr, 0);

            switch (type) {
                case 'sum':
                    return sum;

                case 'avg':
                    return sum / numericValues.length;

                default:
                    return 0;
            }
        }
    };
}