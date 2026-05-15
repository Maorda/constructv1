import { RelationOptions } from '@database/decorators/relation.decorator';
import {
    TABLE_NAME_KEY,
    PRIMARY_KEY_METADATA_KEY,
    TABLE_COLUMN_DETAILS_KEY,
    SHEETS_ALL_RELATIONS, // El Symbol que definimos antes
    RELATION_METADATA_LIST, // Nueva constante para la lista de props con relación
    SHEETS_VIRTUALS
} from '../constants/metadata.constants'
import { ColumnOptions } from '@database/decorators/column.decorator';

export class SchemaFactory {
    static createForClass<T extends object>(target: new () => T) {
        // 1. Obtener nombre de la tabla (Hoja)
        let sheetName = Reflect.getMetadata(TABLE_NAME_KEY, target);
        // 1. Obtener nombre de la tabla


        // Fallback de seguridad: Si por alguna razón el decorador no inyectó el nombre
        if (!sheetName) {
            sheetName = target.name.replace(/(Entity|Model|Schema)$/i, '').toUpperCase() + 'S';
        }

        // 2. Obtener la llave primaria
        const primaryKey = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, target);

        // 3. Obtener el mapa de columnas (TABLE_COLUMN_DETAILS_KEY está en el prototipo)
        const columns = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, target.prototype) || {};

        // --- AGREGAR ESTO ---
        const virtuals = Reflect.getMetadata(SHEETS_VIRTUALS, target.prototype) || {};
        // 4. Obtener nombres de las relaciones registradas
        const relationKeys: string[] = Reflect.getMetadata(SHEETS_ALL_RELATIONS, target.prototype) || [];
        const relations = relationKeys.map(key => ({
            property: key,
            config: Reflect.getMetadata(RELATION_METADATA_LIST, target.prototype, key)
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
export interface SheetSchema<T> {
    target: new () => T;
    sheetName: string;
    primaryKey: string;
    columns: Record<string, ColumnOptions>; // Usamos la interfaz ColumnOptions que ya tienes
    virtuals: Record<string, any>;
    relations: { property: string; config: RelationOptions }[];
}