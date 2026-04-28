/*La mejor forma de implementarlo es ver el Pipeline como una banda transportadora. 
*El AggregationEngine recibe un arreglo de "etapas" (stages) y pasa los datos de una a otra.
*/

import { Injectable } from "@nestjs/common";
import { OperatorsComparationsHandleUtil } from "@database/utils/operators/operators.comparations.util";
import { OperatorsCollectionHandleUtil } from "@database/utils/operators/operators.collection.util";
import { OperatorsMathHandleUtil } from "@database/utils/operators/operators.math.util";
import { CompareEngine } from "./compare.engine";
import { ExpressionEngine } from "./expressionEngine";
import { SheetsDataGateway } from "@database/services/sheetDataGateway";
import { ModuleRef } from "@nestjs/core";
import { LookupConfig } from "@database/services/pipeline.stages.service";
import { BaseEngine } from "./Base.Engine";
import { ClassType } from "@database/types/query.types";


export class AggregationEngine extends BaseEngine {
    constructor(
        entityClass: ClassType,
        expression: ExpressionEngine,
        moduleRef: ModuleRef
    ) { super(entityClass); }
    handleGroup(data: any[], config: any): any[] {
        const { _id, ...accumulators } = config;
        const groups = new Map<string, any>();

        for (const item of data) {
            // Resolvemos el valor de la llave de grupo (ej: '$id_especialista')
            const groupId = item[_id.substring(1)];

            if (!groups.has(groupId)) {
                groups.set(groupId, { _id: groupId });
            }

            const group = groups.get(groupId);

            // Ejecutamos acumuladores ($sum, $avg, $count)
            Object.keys(accumulators).forEach(key => {
                const accConfig = accumulators[key];
                const operator = Object.keys(accConfig)[0]; // ej: '$sum'
                const field = accConfig[operator].substring(1); // ej: 'sueldo'

                if (operator === '$sum') {
                    group[key] = (group[key] || 0) + (Number(item[field]) || 0);
                } else if (operator === '$count') {
                    group[key] = (group[key] || 0) + 1;
                }
                // ... agregar más operadores como $avg, $max
            });
        }

        return Array.from(groups.values());
    }
    handleUnwind(data: any[], path: string): any[] {
        const field = path.startsWith('$') ? path.substring(1) : path;
        const result: any[] = [];

        for (const item of data) {
            const arrayToUnwind = item[field];
            if (Array.isArray(arrayToUnwind) && arrayToUnwind.length > 0) {
                for (const subItem of arrayToUnwind) {
                    result.push({ ...item, [field]: subItem });
                }
            } else {
                // Si está vacío, decidimos si mantenerlo o filtrarlo (preservar nulos)
                result.push({ ...item, [field]: null });
            }
        }
        return result;
    }
    async handleLookup(currentData: any[], config: any): Promise<any[]> {
        const { from, localField, foreignField, as } = config;

        // 1. Traemos los datos de la hoja secundaria (ej: 'especialistas')
        // Nota: El repositorio debe devolver los datos ya pasados por el GettersEngine
        const foreignData = await this.googleSpreedSheetService.findAllRaw();

        // 2. Creamos el ÍNDICE para evitar recorridos infinitos
        const indexMap = this.createIndexMap(foreignData, foreignField);

        // 3. Realizamos el cruce veloz
        return currentData.map(item => {
            const localVal = String(item[localField]);
            return {
                ...item,
                [as]: indexMap.get(localVal) || [] // Si no hay coincidencia, arreglo vacío
            };
        });
    }
    private createIndexMap(data: any[], key: string): Map<string, any[]> {
        const index = new Map<string, any[]>();
        for (const item of data) {
            const val = String(item[key]);
            if (!index.has(val)) index.set(val, []);
            index.get(val).push(item);
        }
        return index;
    }
    async run(data: any[], pipeline: any[]): Promise<any[]> {
        let result = [...data];

        for (const stage of pipeline) {
            const operator = Object.keys(stage)[0];
            const config = stage[operator];

            switch (operator) {
                case '$match':
                    result = result.filter(item => this.applyMatch(item, config));
                    break;
                case '$lookup':
                    result = await this.executeLookup(result, config); // Implementa tu lógica de Map/Índice aquí
                    break;
                case '$unwind':
                    result = this.executeUnwind(result, config);
                    break;
                case '$addFields':
                case '$project':
                    result = result.map(item => ({
                        ...item,
                        ...this.expressionEngine.execute(item, config)
                    }));
                    break;
                case '$group':
                    result = this.executeGroup(result, config);
                    break;
                case '$sort':
                    result = this.executeSort(result, config);
                    break;
            }
        }
        return result;
    }
    private applyMatch(item: any, query: Record<string, any>): boolean {
        // Recorremos cada condición del filtro (ej: { estado: 'ACTIVO', sueldo: { $gt: 1500 } })
        return Object.entries(query).every(([key, condition]) => {
            const value = item[key];

            // Si la condición es un objeto (operador como $gt, $in, $ne)
            if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
                const operator = Object.keys(condition)[0];
                const target = condition[operator];

                switch (operator) {
                    case '$gt': return value > target;
                    case '$gte': return value >= target;
                    case '$lt': return value < target;
                    case '$lte': return value <= target;
                    case '$ne': return value !== target;
                    case '$in': return Array.isArray(target) && target.includes(value);
                    case '$nin': return Array.isArray(target) && !target.includes(value);
                    case '$regex': return new RegExp(target, 'i').test(String(value));
                    default: return false;
                }
            }

            // Comparación directa de igualdad
            return value === condition;
        });
    }
    private executeUnwind(data: any[], path: string): any[] {
        // Quitamos el '$' si viene en el path (ej: '$cuadrilla' -> 'cuadrilla')
        const field = path.startsWith('$') ? path.substring(1) : path;
        const result: any[] = [];

        for (const item of data) {
            const arrayToUnwind = item[field];

            // Si no es un arreglo o está vacío, podemos optar por eliminar el registro
            // o mantenerlo como null (comportamiento por defecto: eliminar si no hay elementos)
            if (Array.isArray(arrayToUnwind) && arrayToUnwind.length > 0) {
                for (const subItem of arrayToUnwind) {
                    result.push({
                        ...item,
                        [field]: subItem // Sustituimos el arreglo por el elemento individual
                    });
                }
            } else {
                // Opcional: conservar el registro original con el campo en null 
                // (equivalente a preserveNullAndEmptyArrays: true en MongoDB)
                result.push({ ...item, [field]: null });
            }
        }
        return result;
    }

    private executeGroup(data: any[], config: any): any[] {
        const { _id, ...accumulators } = config;
        const groups = new Map<string, any>();

        for (const item of data) {
            // Resolvemos el ID de grupo (puede ser un campo o null para agrupar todo)
            const groupId = _id && typeof _id === 'string' && _id.startsWith('$')
                ? item[_id.substring(1)]
                : 'root';

            if (!groups.has(groupId)) {
                groups.set(groupId, { _id: groupId });
            }

            const group = groups.get(groupId);

            // Procesamos acumuladores
            for (const [key, accConfig] of Object.entries(accumulators)) {
                const operator = Object.keys(accConfig as object)[0];
                const fieldPath = (accConfig as any)[operator];
                const value = typeof fieldPath === 'string' && fieldPath.startsWith('$')
                    ? item[fieldPath.substring(1)]
                    : null;

                switch (operator) {
                    case '$sum':
                        group[key] = (group[key] || 0) + (Number(value) || 0);
                        break;
                    case '$count':
                        group[key] = (group[key] || 0) + 1;
                        break;
                    case '$avg':
                        group[`${key}_sum`] = (group[`${key}_sum`] || 0) + (Number(value) || 0);
                        group[`${key}_cnt`] = (group[`${key}_cnt`] || 0) + 1;
                        group[key] = group[`${key}_sum`] / group[`${key}_cnt`];
                        break;
                    case '$push':
                        if (!group[key]) group[key] = [];
                        group[key].push(item);
                        break;
                }
            }
        }

        return Array.from(groups.values()).map(g => {
            // Limpieza de auxiliares de AVG
            Object.keys(g).forEach(k => { if (k.includes('_sum') || k.includes('_cnt')) delete g[k]; });
            return g;
        });
    }
    private executeSort(data: any[], sortConfig: Record<string, 1 | -1>): any[] {
        return [...data].sort((a, b) => {
            for (const key in sortConfig) {
                const dir = sortConfig[key];
                if (a[key] > b[key]) return dir;
                if (a[key] < b[key]) return -dir;
            }
            return 0;
        });
    }

    private async executeLookup(data: any[], config: LookupConfig): Promise<any[]> {
        // Obtenemos el repositorio de la entidad destino (ej: 'PeonesRepository')
        // El nombre debe seguir una convención o estar registrado como provider
        const foreignRepository = this.moduleRef.get(`${config.from}Repository`, { strict: false });

        if (!foreignRepository) {
            throw new Error(`Repositorio para ${config.from} no encontrado.`);
        }

        const foreignData = await foreignRepository.findAllRaw();

        // ARTIMAÑA DEL ÍNDICE: Creamos el Map para búsqueda O(1)
        const index = new Map<string, any[]>();
        foreignData.forEach(row => {
            const key = String(row[config.foreignField]);
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(row);
        });

        return data.map(item => ({
            ...item,
            [config.as]: index.get(String(item[config.localField])) || []
        }));
    }


}