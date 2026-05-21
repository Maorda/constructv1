import { ColumnOptions } from '@database/decorators/column.decorator';
import {
    SHEETS_TABLE_NAME,
    SHEETS_PRIMARY_KEY,
    SHEETS_COLUMN_DETAILS,
    SHEETS_RELATIONS_LIST,
    SHEETS_ALL_RELATIONS,
    SHEETS_VIRTUALS
} from '@database/constants/metadata.constants';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '@database/decorators/relation.sub.collections.decorator';

export interface ISheetSchemaFactory<T> {
    target: new () => T;
    sheetName: string;
    primaryKey: string;
    columns: Record<string, ColumnOptions>;
    virtuals: Record<string, any>;
    relations: { property: string; config: RelationOptions }[];
}

export class SchemaFactory {
    static createForClass<T extends object>(targetClass: new () => T): ISheetSchemaFactory<T> {
        const parentEntityName = targetClass.name;

        // 1. Obtener nombre de la tabla (Hoja)
        let sheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetClass);
        if (!sheetName) {
            sheetName = this.inferSheetName(parentEntityName);
        }

        // 2. Obtener la llave primaria
        const primaryKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) || 'id';

        // 3. Obtener detalles de columnas
        const columns = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetClass) || {};

        // 4. Obtener virtuales
        const virtuals = Reflect.getMetadata(SHEETS_VIRTUALS, targetClass.prototype) || {};

        // 5. Mapear relaciones con resolución diferida (Lazy)
        const relationKeys: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, targetClass.prototype) || [];

        const relations = relationKeys.map(key => {
            const rawConfig = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetClass.prototype, key);

            // 🚀 AQUÍ OCURRE LA MAGIA: Resolvemos la función flecha de manera segura
            const targetEntityClass = rawConfig.targetEntity();

            const targetSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetEntityClass) ||
                this.inferSheetName(targetEntityClass.name);

            const inferredJoinColumn = rawConfig.options?.joinColumn ||
                `${parentEntityName.replace(/(Entity|Model)$/i, '').toLowerCase()}Id`;

            const inferredLocalField = rawConfig.options?.localField || primaryKey;
            const selectedOnDelete = rawConfig.options?.onDelete || 'RESTRICT';

            const finalConfig: RelationOptions = {
                targetEntity: rawConfig.targetEntity,
                targetSheet: targetSheetName,
                localField: inferredLocalField,
                joinColumn: inferredJoinColumn,
                isMany: rawConfig.isMany,
                onDelete: selectedOnDelete
            };

            // 🚀 Alimentamos el registro de cascadas global de forma segura en este punto
            this.registerInGlobalRegistry(parentEntityName, finalConfig);

            return {
                property: key,
                config: finalConfig
            };
        });

        return {
            target: targetClass,
            sheetName,
            primaryKey,
            columns,
            virtuals,
            relations
        };
    }

    private static inferSheetName(className: string): string {
        const baseName = className.replace(/(Entity|Model|Schema)$/i, '');
        const lastChar = baseName.slice(-1).toLowerCase();
        return ['a', 'e', 'i', 'o', 'u'].includes(lastChar)
            ? `${baseName}S`.toUpperCase()
            : `${baseName}ES`.toUpperCase();
    }

    private static registerInGlobalRegistry(parentName: string, config: RelationOptions) {
        const existingDeps = GLOBAL_RELATION_REGISTRY.get(parentName) || [];
        const alreadyRegistered = existingDeps.some(d =>
            d.childSheet === config.targetSheet && d.joinColumn === config.joinColumn
        );

        if (!alreadyRegistered) {
            existingDeps.push({
                parentEntity: parentName,
                childSheet: config.targetSheet,
                childRepository: config.childRepository,
                joinColumn: config.joinColumn,
                localField: config.localField,
                onDelete: config.onDelete
            });
            GLOBAL_RELATION_REGISTRY.set(parentName, existingDeps);
        }
    }


}
