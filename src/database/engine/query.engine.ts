import { CompareEngine } from "@database/engines/compare.engine";
import { ExpressionEvaluator } from "@database/engines/expression.evaluator";
import { IQueryEngine } from "@database/interfaces/engine/IQueryEngine";
import { FilterQuery } from "@database/types/query.types";
import { OperatorsCollectionHandleUtil } from "@database/utils/operators/operators.collection.util";
import { Injectable } from "@nestjs/common";
import { RelationEngine } from "./relationEngine";
import { ModuleRef } from "@nestjs/core";

/*
* QueryEngine: El motor de procesamiento de datos.
* Recibe los datos crudos de Google Sheets y aplica las instrucciones 
* del QueryBuilder (filtros, orden, límites).
* Es el equivalente al "Cursor" de MongoDB que ejecuta la consulta.
*/


export class QueryEngine<T extends object> implements IQueryEngine {

    constructor(
        private readonly compareEngine: CompareEngine,
        private readonly relationEngine: RelationEngine<T>,

    ) { }

    // ========================================================================
    // 1. MOTOR CLÁSICO (Instrucciones: where, select, limit)
    // ========================================================================

    /**
 * Orquestador principal del motor de consultas.
 * Aplica el pipeline de procesamiento: Filter -> Sort -> Limit -> Select.
 */
    execute<T extends object>(data: T[], instructions: any): any[] {
        // 1. Clonamos la data para evitar mutar el caché original (Inmutabilidad)
        let result = [...data];

        // 2. Aplicación de Filtros
        // CAMBIO CLAVE: Usamos el .filter() nativo de JS con la nueva lógica booleana
        if (instructions.where && Object.keys(instructions.where).length > 0) {
            result = result.filter(item => this.applyFilter(item, instructions.where));
        }

        // 3. Ordenamiento
        // Soporta tanto { campo: 1 } como { field: 'campo', order: 'ASC' }
        if (instructions.orderBy) {
            result = this.applySort(result, instructions.orderBy);
        }

        // 4. Paginación (Skip y Limit)
        // Agregamos skip por si decides implementarlo en el futuro para tu planilla
        if (instructions.skip) {
            result = result.slice(instructions.skip);
        }

        if (instructions.limit) {
            result = result.slice(0, instructions.limit);
        }

        // 5. Proyección (Selección de campos específicos)
        // Se ejecuta al final para no perder datos necesarios en el filtro/sort
        if (instructions.select && instructions.select.length > 0) {
            return this.applySelect(result, instructions.select);
        }

        return result;
    }
    /**
     * Filtra una colección de datos basándose en un FilterQuery.
     * Delega toda la inteligencia de comparación al CompareEngine para mantener
     * la consistencia en todo el ODM.
     */
    /**
 * Evalúa si una entidad cumple con los criterios de un FilterQuery.
 * @param item El objeto de la entidad (instancia o plano mapeado)
 * @param where El objeto de condiciones (soporta operadores y columnas dinámicas)
 */
    applyFilter<T>(item: T, where: FilterQuery<T>): boolean {
        // 1. Si el filtro es nulo o vacío, el registro es válido (Short-circuit)
        if (!where || Object.keys(where).length === 0) {
            return true;
        }

        /**
         * 2. Delegación al CompareEngine.
         * El CompareEngine debe ser el encargado de iterar sobre las llaves del 
         * FilterQuery y compararlas contra el 'item'.
         */
        return this.compareEngine.applyFilter(item, where);
    }



    /**
  * Soporta ordenamiento dinámico.
  * @param data Array de entidades T[]
  * @param sortConfig Objeto tipo { campo: 1 | -1 } o { campo: 'ASC' | 'DESC' }
  */
    applySort<T>(data: T[], sortConfig: Record<string, any>): T[] {
        if (!sortConfig || Object.keys(sortConfig).length === 0) return data;

        // 1. Extraemos el criterio
        const [field, direction] = Object.entries(sortConfig)[0];
        const isAsc = direction === 1 || direction === 'ASC';

        return [...data].sort((a, b) => {
            // MEJORA: Usamos variables de tipo 'any' para la comparación interna
            // Esto evita que TS intente validar si el resultado es asignable a T[keyof T]
            let valA: any = a[field as keyof T];
            let valB: any = b[field as keyof T];

            // 2. Normalización de fechas a nivel de valor local
            if (valA instanceof Date || valB instanceof Date) {
                valA = valA instanceof Date ? valA.getTime() : new Date(valA).getTime();
                valB = valB instanceof Date ? valB.getTime() : new Date(valB).getTime();
            }

            // 3. Manejo de nulos/undefined (importante en Sheets)
            if (valA === null || valA === undefined) return isAsc ? 1 : -1;
            if (valB === null || valB === undefined) return isAsc ? -1 : 1;

            // 4. Comparación final
            if (valA < valB) return isAsc ? -1 : 1;
            if (valA > valB) return isAsc ? 1 : -1;
            return 0;
        });
    }

    private applyLimit<T>(data: T[], limit: number): T[] {
        return data.slice(0, limit);
    }

    private applySelect<T extends object>(data: T[], fields: (keyof T)[]): any[] {
        return data.map(item => {
            const projection: any = {};
            fields.forEach(field => {
                projection[field] = item[field];
            });
            return projection;
        });
    }

    // ========================================================================
    // 2. MOTOR DE AGREGACIÓN (Pipeline: $match, $project, $group)
    // ========================================================================

    /**
 * Motor de agregación por etapas (Pipeline).
 * Procesa la data secuencialmente según las instrucciones de Mongo-like aggregation.
 */
    async aggregate<T extends object>(data: T[], pipeline: any[]): Promise<any[]> {
        // 1. Clonamos la referencia inicial
        let result: any[] = [...data];

        // 2. Procesamiento secuencial del Pipeline
        for (const stage of pipeline) {
            const stageName = Object.keys(stage)[0];
            const stageConfig = stage[stageName];

            switch (stageName) {
                case '$match':
                    /**
                     * MEJORA: Sincronización con el nuevo motor de filtros.
                     * Usamos el filtro nativo invocando la lógica booleana por cada ítem.
                     */
                    if (stageConfig && Object.keys(stageConfig).length > 0) {
                        result = result.filter(item => this.applyFilter(item, stageConfig));
                    }
                    break;

                case '$project':
                    // La proyección transforma el objeto, por lo que usamos map
                    result = result.map(item => this.applyProjection(item, stageConfig));
                    break;

                case '$group':
                    // El agrupamiento reduce la colección (esta lógica suele ser interna en el motor)
                    result = this.applyGroup(result, stageConfig);
                    break;

                case '$sort':
                    /**
                     * MEJORA: Reutilizamos el applySort optimizado que ya maneja 
                     * la normalización de fechas y direcciones (1 / -1).
                     */
                    result = this.applySort(result, stageConfig);
                    break;

                case '$limit':
                    // Truncado de seguridad
                    result = result.slice(0, stageConfig);
                    break;

                case '$skip':
                    // Desplazamiento
                    result = result.slice(stageConfig);
                    break;

                case '$lookup':
                    // Ahora esperamos la resolución de la relación
                    result = await this.relationEngine.applyLookup(result, stageConfig);
                    break;

                default:
                    console.warn(`[QueryEngine] Stage ${stageName} no reconocido o no implementado.`);
                    break;
            }
        }

        return result;
    }

    applyProjection(item: any, projectionConfig: Record<string, any>): any {
        const result: any = {};

        Object.entries(projectionConfig).forEach(([key, rule]) => {
            if (rule === 1 || rule === true) {
                result[key] = item[key];
            } else if (typeof rule === 'string' && rule.startsWith('$')) {
                result[key] = item[rule.substring(1)];
            } else if (typeof rule === 'object' && rule !== null && !Array.isArray(rule)) {
                const operator = Object.keys(rule)[0];
                result[key] = ExpressionEvaluator.evaluate(operator, rule[operator], item);
            } else {
                result[key] = rule;
            }
        });

        if (item.__row !== undefined) result.__row = item.__row;
        return result;
    }

    private applyGroup(data: any[], groupConfig: Record<string, any>): any[] {
        const idRule = groupConfig._id;
        const groupMap = new Map<string, any[]>();

        data.forEach(item => {
            const groupKey = typeof idRule === 'string' && idRule.startsWith('$')
                ? String(item[idRule.substring(1)])
                : (typeof idRule === 'object' ? JSON.stringify(this.applyProjection(item, idRule)) : String(idRule));

            if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
            groupMap.get(groupKey)!.push(item);
        });

        const groupedResults: any[] = [];

        groupMap.forEach((items, key) => {
            const groupResult: any = { _id: key !== 'null' ? key : null };

            Object.entries(groupConfig).forEach(([fieldKey, rule]) => {
                if (fieldKey === '_id') return;

                const operator = Object.keys(rule)[0];
                const targetFieldPath = rule[operator];
                const targetField = targetFieldPath.startsWith('$') ? targetFieldPath.substring(1) : targetFieldPath;

                const valuesToAggregate = items.map(i => i[targetField]);

                if (['$sum', '$avg', '$max', '$min', '$count'].includes(operator)) {
                    const type = operator.substring(1) as 'sum' | 'avg' | 'max' | 'min' | 'count';
                    groupResult[fieldKey] = OperatorsCollectionHandleUtil.CollectionHandlers.aggregateArray(valuesToAggregate, type);
                }
            });

            groupedResults.push(groupResult);
        });

        return groupedResults;
    }

    private applySortAggregate(data: any[], sortConfig: Record<string, 1 | -1>): any[] {
        return data.sort((a, b) => {
            for (const [key, direction] of Object.entries(sortConfig)) {
                if (a[key] > b[key]) return direction;
                if (a[key] < b[key]) return -direction;
            }
            return 0;
        });
    }

}

