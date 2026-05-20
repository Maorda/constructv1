import { Logger } from '@nestjs/common';
import { ClassType, FilterQuery } from '@database/types/query.types';
import { SHEETS_COLUMN_DETAILS } from '@database/constants/metadata.constants';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { SheetDataTransformer } from '@database/engines/shereUtilsEngine/SheetDataTransformer';

export class QueryNormalizer {

    constructor(
        private readonly transformer: SheetDataTransformer
    ) {

    }
    private static readonly logger = new Logger('QueryNormalizer 🔍');

    public normalize<T>(entityClass: ClassType<T>, filter: FilterQuery<T>): FilterQuery<T> {
        if (!filter || typeof filter !== 'object') return filter;

        const entityName = entityClass.name;
        const normalizedFilter: any = { ...filter };

        // 🚀 SOPORTE RECURSIVO INTEGRAL ($or, $and)
        if (filter['$or'] && Array.isArray(filter['$or'])) {
            return { $or: filter['$or'].map(subFilter => this.normalize(entityClass, subFilter)) } as any;
        }
        if (filter['$and'] && Array.isArray(filter['$and'])) {
            return { $and: filter['$and'].map(subFilter => this.normalize(entityClass, subFilter)) } as any;
        }

        const columnsDetails =
            Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityClass) ||
            Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityClass.prototype) ||
            {};

        for (const propertyKey of Object.keys(normalizedFilter)) {
            if (propertyKey.startsWith('$')) continue;

            // 🛡️ CONTROL DEFENSIVO ABSOLUTO: 
            // Eliminamos '__row' del filtro de consulta para que los repositorios busquen de forma limpia 
            // por los identificadores lógicos (DNI, UUID) y no asuman índices físicos heredados o cruzados.
            if (propertyKey === '__row') {
                delete normalizedFilter[propertyKey];
                continue;
            }

            let columnConfig = columnsDetails[propertyKey];

            if (!columnConfig) {
                const foundKey = Object.keys(columnsDetails).find(
                    key => columnsDetails[key].name?.toLowerCase() === propertyKey.toLowerCase()
                );
                if (foundKey) {
                    columnConfig = columnsDetails[foundKey];
                }
            }

            if (!columnConfig) {
                continue;
            }

            let targetType = columnConfig.type || 'string';
            if (targetType === 'string' && (columnConfig.isDeleteControl || propertyKey.toLowerCase().includes('eliminado'))) {
                targetType = 'boolean';
            }

            let filterValue = normalizedFilter[propertyKey];

            // CASO 1: OPERADORES NOSQL AVANZADOS
            if (filterValue && typeof filterValue === 'object' && !(filterValue instanceof Date)) {
                const operatorKey = Object.keys(filterValue).find(k => k.startsWith('$'));

                if (operatorKey) {
                    const mutableOperator: any = { ...filterValue };
                    const innerValue = mutableOperator[operatorKey];
                    mutableOperator[operatorKey] = this.transformer.castValue(innerValue, targetType);
                    normalizedFilter[propertyKey] = mutableOperator;
                    continue;
                }
            }

            // CASO 2: VALORES DIRECTOS PLANOS
            if (targetType === 'boolean') {
                const isTrue = filterValue === true || String(filterValue).toLowerCase() === 'true';
                if (!isTrue) {
                    normalizedFilter[propertyKey] = { $in: [false, "false", "FALSE", "falso", "FALSO", ""] };
                } else {
                    normalizedFilter[propertyKey] = { $in: [true, "true", "TRUE", "verdadero", "VERDADERO"] };
                }
                continue;
            }

            if (targetType === 'string' && filterValue !== undefined && filterValue !== null) {
                const stringValue = String(filterValue).trim();
                const isNumericString = /^\d+$/.test(stringValue);

                if (isNumericString) {
                    normalizedFilter[propertyKey] = { $in: [stringValue, Number(stringValue)] };
                    continue;
                }
            }

            normalizedFilter[propertyKey] = this.transformer.castValue(filterValue, targetType);
        }

        return normalizedFilter as FilterQuery<T>;
    }
}