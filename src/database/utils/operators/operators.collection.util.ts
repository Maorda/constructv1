export class OperatorsCollectionHandleUtil {

    static CollectionHandlers = {
        /**
         * El operador $aggregate funciona como un embudo procesador.
         * Su objetivo no es transformar una fila individual (como lo hace el $concat),
         * sino tomar una colección de datos (un arreglo de valores) y reducirla a un único número
         * significativo, como una suma o un promedio.
         * $aggregate: Reductor de colecciones a un valor escalar.
         * @param values Arreglo de datos (ej: columna de montos)
         * @param type 'sum' | 'avg' | 'max' | 'min' | 'count'
         */
        aggregateArray: (values: any[], type: 'sum' | 'avg' | 'max' | 'min' | 'count' = 'sum'): number => {
            if (!Array.isArray(values) || values.length === 0) return 0;

            let sum = 0;
            let count = 0;
            let min = Infinity;
            let max = -Infinity;

            for (const raw of values) {
                // Sanitización rápida: quitamos símbolos de moneda y normalizamos comas
                let val = raw;
                if (typeof raw === 'string') {
                    val = raw.replace(/[S/,\s]/g, '').replace(',', '.');
                }

                const num = parseFloat(val);

                if (!isNaN(num) && num !== null) {
                    sum += num;
                    count++;
                    if (num < min) min = num;
                    if (num > max) max = num;
                }
            }

            if (count === 0) return 0;

            switch (type) {
                case 'sum': return sum;
                case 'avg': return sum / count;
                case 'count': return count;
                case 'max': return max;
                case 'min': return min;
                default: return sum;
            }
        }
    };
}