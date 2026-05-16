import { RelationOptions } from '@database/decorators/relation.decorator';
import { ColumnOptions } from '@database/decorators/column.decorator';
import {
    SHEETS_TABLE_NAME,
    SHEETS_PRIMARY_KEY,
    SHEETS_COLUMN_DETAILS,
    SHEETS_RELATIONS_LIST,
    SHEETS_ALL_RELATIONS,
    SHEETS_VIRTUALS
} from '@database/constants/metadata.constants';

export interface SheetSchema<T> {
    target: new () => T;
    sheetName: string;
    primaryKey: string;
    columns: Record<string, ColumnOptions>;
    virtuals: Record<string, any>;
    relations: { property: string; config: RelationOptions }[];
}

export class SchemaFactory {
    static createForClass<T extends object>(target: new () => T): SheetSchema<T> {
        const targetClass = target;

        // 1. Obtener nombre de la tabla (Hoja) - Metadata de Clase (Constructor)
        let sheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetClass);

        if (!sheetName) {
            let baseName = targetClass.name.replace(/(Entity|Model|Schema)$/i, '');
            const lastChar = baseName.slice(-1).toLowerCase();
            if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
                sheetName = `${baseName}S`.toUpperCase();
            } else {
                sheetName = `${baseName}ES`.toUpperCase();
            }
        }

        // 2. Obtener la llave primaria (la propiedad string, ej: 'dni')
        const primaryKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) || 'id';

        // 3. Obtener el mapa de detalles de columnas desde el CONSTRUCTOR centralizado
        const columns = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetClass) || {};

        // 4. Obtener virtuales (cálculos en memoria)
        const virtuals = Reflect.getMetadata(SHEETS_VIRTUALS, targetClass.prototype) || {};

        // 5. Obtener y mapear relaciones desde el prototipo
        const relationKeys: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, targetClass.prototype) || [];

        const relations = relationKeys.map(key => ({
            property: key,
            config: Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetClass.prototype, key) as RelationOptions
        }));

        return {
            target,
            sheetName,
            primaryKey,
            columns,
            virtuals,
            relations
        };
    }


}
