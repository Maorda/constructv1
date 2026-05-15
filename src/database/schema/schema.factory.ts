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

export class SchemaFactory {
    static createForClass<T extends object>(target: new () => T): SheetSchema<T> {
        // 1. Obtener nombre de la tabla (Hoja) - Metadata de Clase
        let sheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, target);

        // Fallback de seguridad: ObreroEntity -> OBREROS
        if (!sheetName) {
            sheetName = target.name
                .replace(/(Entity|Model|Schema)$/i, '')
                .toUpperCase() + 'S';
        }

        // 2. Obtener la llave primaria (la propiedad TS, ej: 'dni')
        const primaryKey = Reflect.getMetadata(SHEETS_PRIMARY_KEY, target) ||
            Reflect.getMetadata(SHEETS_PRIMARY_KEY, target.prototype?.constructor);

        // 3. Obtener el mapa de detalles de columnas (Metadata de Prototipo)
        // Este mapa es el que asegura que Insomnia no devuelva {}
        const columns = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, target.prototype) || {};

        // 4. Obtener virtuales (cálculos)
        const virtuals = Reflect.getMetadata(SHEETS_VIRTUALS, target.prototype) || {};

        // 5. Obtener y mapear relaciones
        // Primero obtenemos la LISTA de nombres de propiedades que son relaciones
        const relationKeys: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target.prototype) || [];

        // Luego buscamos la CONFIGURACIÓN individual de cada una
        const relations = relationKeys.map(key => ({
            property: key,
            config: Reflect.getMetadata(SHEETS_ALL_RELATIONS, target.prototype, key) as RelationOptions
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
    columns: Record<string, ColumnOptions>;
    virtuals: Record<string, any>;
    relations: { property: string; config: RelationOptions }[];
}