import { Injectable } from "@nestjs/common";

/*
* QueryEngine: El motor de procesamiento de datos.
* Recibe los datos crudos de Google Sheets y aplica las instrucciones 
* del QueryBuilder (filtros, orden, límites).
* Es el equivalente al "Cursor" de MongoDB que ejecuta la consulta.
*/

@Injectable()
export class QueryEngine {

    /**
     * Ejecuta la receta completa enviada por el QueryBuilder
     */
    execute<T extends object>(data: T[], instructions: any): any[] {
        // Trabajamos sobre una copia para no afectar la caché original
        let result = [...data];

        // 1. Filtrar: Reducimos el número de filas
        if (instructions.where && Object.keys(instructions.where).length > 0) {
            result = this.applyFilters(result, instructions.where);
        }

        // 2. Ordenar: Organizamos las filas resultantes
        if (instructions.orderBy) {
            result = this.applySort(result, instructions.orderBy);
        }

        // 3. Limitar: Cortamos la cantidad de filas (Paginación)
        if (instructions.limit) {
            result = this.applyLimit(result, instructions.limit);
        }

        // 4. Seleccionar: Reducimos el número de columnas (campos)
        // Se ejecuta al final porque los filtros y el orden necesitan los campos originales
        if (instructions.select && instructions.select.length > 0) {
            return this.applySelect(result, instructions.select);
        }

        return result;
    }

    private applyFilters<T>(data: T[], where: Record<string, any>): T[] {
        return data.filter(item => {
            return Object.keys(where).every(key => {
                const itemValue = (item as any)[key];
                const targetValue = where[key];
                return itemValue === targetValue; // Aquí puedes expandir a operadores $gt, $lt
            });
        });
    }

    private applySort<T>(data: T[], orderBy: { field: keyof T; order: 'ASC' | 'DESC' }): T[] {
        const { field, order } = orderBy;
        return data.sort((a, b) => {
            if (a[field] < b[field]) return order === 'ASC' ? -1 : 1;
            if (a[field] > b[field]) return order === 'ASC' ? 1 : -1;
            return 0;
        });
    }

    private applyLimit<T>(data: T[], limit: number): T[] {
        return data.slice(0, limit);
    }

    /**
     * Implementación de applySelect
     * Transforma el objeto completo en uno que solo contiene las llaves solicitadas
     */
    private applySelect<T extends object>(data: T[], fields: (keyof T)[]): any[] {
        return data.map(item => {
            const projection: any = {};
            fields.forEach(field => {
                projection[field] = item[field];
            });
            return projection;
        });
    }

    /**
     * Evalúa operadores complejos (Soporte para evolución estilo Mongoose)
     */
    private evaluateOperator(itemValue: any, operatorObj: any): boolean {
        const operator = Object.keys(operatorObj)[0];
        const value = operatorObj[operator];

        switch (operator) {
            case '$gt': return itemValue > value;
            case '$lt': return itemValue < value;
            case '$gte': return itemValue >= value;
            case '$lte': return itemValue <= value;
            case '$ne': return itemValue !== value;
            case '$contains':
                return String(itemValue).toLowerCase().includes(String(value).toLowerCase());
            default:
                return itemValue === value;
        }
    }

}

