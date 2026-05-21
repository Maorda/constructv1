import { Logger } from '@nestjs/common';
import { ClassType, FilterQuery } from '@database/types/query.types';
import { SHEETS_COLUMN_DETAILS } from '@database/constants/metadata.constants';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { SheetDataTransformer } from '@database/engines/shereUtilsEngine/SheetDataTransformer';
import { SheetSchemaManager } from '@database/gatewayManager/SheetSchemaManager';

export class QueryNormalizer {

    private static readonly logger = new Logger('QueryNormalizer 🔍');

    constructor(
        private readonly transformer: SheetDataTransformer,
        private readonly schemaManager: SheetSchemaManager // 🔒 Ahora sí inyectado
    ) { }


    public normalize<T>(entityClass: ClassType<T>, filter: FilterQuery<T>): FilterQuery<T> {
        if (!filter || typeof filter !== 'object') return filter;

        const normalizedFilter: any = { ...filter };

        // 🚀 Soporte recursivo para operadores lógicos
        if (filter['$or'] && Array.isArray(filter['$or'])) {
            return { $or: filter['$or'].map(subFilter => this.normalize(entityClass, subFilter)) } as any;
        }
        if (filter['$and'] && Array.isArray(filter['$and'])) {
            return { $and: filter['$and'].map(subFilter => this.normalize(entityClass, subFilter)) } as any;
        }

        // 🔒 USAMOS EL SCHEMA MANAGER
        // El Manager ya tiene la lógica para extraer los detalles usando el MetadataRegistry
        const columnsDetails = this.schemaManager.getColumnDetails(entityClass) || {};

        for (const propertyKey of Object.keys(filter)) {
            if (propertyKey === '$or' || propertyKey === '$and') continue;

            const filterValue = filter[propertyKey];
            const config = columnsDetails[propertyKey];
            const targetType = config?.type || 'string';

            // CASO 1: OPERADORES DE MONGO
            if (this.isMongoOperator(filterValue)) {
                const mutableOperator: any = { ...filterValue };
                for (const operatorKey of Object.keys(mutableOperator)) {
                    const innerValue = mutableOperator[operatorKey];
                    mutableOperator[operatorKey] = Array.isArray(innerValue)
                        ? innerValue.map(val => this.transformer.castValue(val, targetType))
                        : this.transformer.castValue(innerValue, targetType);
                }
                normalizedFilter[propertyKey] = mutableOperator;
                continue;
            }

            // CASO 2: VALORES DIRECTOS (Casteo inteligente vía Transformer)
            normalizedFilter[propertyKey] = this.transformer.castValue(filterValue, targetType);
        }

        return normalizedFilter as FilterQuery<T>;
    }

    private isMongoOperator(value: any): boolean {
        return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && Object.keys(value).some(k => k.startsWith('$'));
    }
}