import { CompareEngine } from "@database/engines/compare.engine";
import { ExpressionEvaluator } from "@database/engines/expression.evaluator";
import { IQueryEngine } from "@database/interfaces/engine/IQueryEngine";
import { FilterQuery } from "@database/types/query.types";
import { OperatorsCollectionHandleUtil } from "@database/utils/operators/operators.collection.util";
import { Injectable } from "@nestjs/common";

/*
* QueryEngine: El motor de procesamiento de datos.
* Recibe los datos crudos de Google Sheets y aplica las instrucciones 
* del QueryBuilder (filtros, orden, límites).
* Es el equivalente al "Cursor" de MongoDB que ejecuta la consulta.
*/


export class QueryEngine implements IQueryEngine {

    constructor(private readonly compareEngine: CompareEngine) { }

    // ========================================================================
    // 1. MOTOR CLÁSICO (Instrucciones: where, select, limit)
    // ========================================================================

    execute<T extends object>(data: T[], instructions: any): any[] {
        let result = [...data];

        if (instructions.where && Object.keys(instructions.where).length > 0) {
            result = this.applyFilter(result, instructions.where);
        }

        if (instructions.orderBy) {
            result = this.applySort(result, instructions.orderBy);
        }

        if (instructions.limit) {
            result = this.applyLimit(result, instructions.limit);
        }

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
    private applyFilter<T>(data: T[], where: Record<string, any>): T[] {
        // 1. Si no hay condiciones, devolvemos la data intacta (Optimización)
        if (!where || Object.keys(where).length === 0) {
            return data;
        }

        // 2. Filtramos la colección delegando al "Juez" (CompareEngine)
        // Usamos el método applyFilter del CompareEngine que ya maneja:
        // - Operadores lógicos ($and, $or, $not)
        // - Normalización de datos (trim, lowercase, dates)
        // - Operadores de comparación ($gt, $regex, $in, etc.)
        return data.filter(item => this.compareEngine.applyFilter(item, where));
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

    aggregate<T extends object>(data: T[], pipeline: any[]): any[] {
        let result: any[] = [...data];

        for (const stage of pipeline) {
            const stageName = Object.keys(stage)[0];
            const stageConfig = stage[stageName];

            switch (stageName) {
                case '$match':
                    // Reutilizamos el applyFilters mejorado
                    result = this.applyFilter(result, stageConfig);
                    break;

                case '$project':
                    result = result.map(item => this.applyProjection(item, stageConfig));
                    break;

                case '$group':
                    result = this.applyGroup(result, stageConfig);
                    break;

                case '$sort':
                    result = this.applySortAggregate(result, stageConfig);
                    break;

                case '$limit':
                    result = this.applyLimit(result, stageConfig);
                    break;

                case '$skip':
                    result = result.slice(stageConfig);
                    break;
            }
        }

        return result;
    }

    private applyProjection(item: any, projectionConfig: Record<string, any>): any {
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

