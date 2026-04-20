import { OperatorsGettersHandleUtil } from '@database/utils/operators/operators.getters';
import { Injectable, Logger } from '@nestjs/common';


@Injectable()
export class GettersEngine {
    private readonly logger = new Logger(GettersEngine.name);

    /**
     * Procesa un objeto buscando operadores de extracción (getters).
     * @param data El DTO o fragmento de datos a procesar.
     * @param record El registro fuente (la fila de la base de datos o Sheets).
     */
    public execute(data: any, record: any): any {
        if (!data || typeof data !== 'object') return data;
        if (Array.isArray(data)) return data.map(item => this.execute(item, record));

        const result = { ...data };

        for (const key in result) {
            const value = result[key];

            // Verificamos si el valor es un objeto operador (ej: { $year: ... })
            if (this.isOperatorObject(value)) {
                const operatorKey = Object.keys(value)[0]; // "$year"
                const pureKey = operatorKey.substring(1);  // "year"

                if (OperatorsGettersHandleUtil.getters.hasOwnProperty(pureKey)) {
                    // 1. Resolvemos el valor ($fecha -> valor de la columna)
                    const resolvedValue = this.resolveValue(value[operatorKey], record);

                    // 2. Ejecutamos el getter de la utilidad y asignamos
                    result[key] = OperatorsGettersHandleUtil.getters[pureKey](resolvedValue);
                    continue;
                }
            }

            // Si es un objeto normal, recursión
            if (value && typeof value === 'object') {
                result[key] = this.execute(value, record);
            }
        }

        return result;
    }

    private isOperatorObject(obj: any): boolean {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const keys = Object.keys(obj);
        return keys.length === 1 && keys[0].startsWith('$');
    }

    private resolveValue(val: any, record: any): any {
        if (typeof val === 'string' && val.startsWith('$')) {
            const fieldName = val.substring(1);
            return record && record.hasOwnProperty(fieldName) ? record[fieldName] : null;
        }
        return val;
    }


}