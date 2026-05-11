import { TABLE_COLUMN_DETAILS_KEY } from "@database/decorators/column.decorator";
import { PRIMARY_KEY_METADATA_KEY } from "@database/decorators/primarykey.decorator";
import { RELATION_METADATA_KEY } from "@database/decorators/relation.decorator";
import { TABLE_NAME_KEY } from "@database/decorators/table.decorator";
import { createModel } from "@database/factory/model.factory";
import { SheetsRepositoryFactory } from "@database/repositories/sheets.repository.factory";

export class SchemaFactory {
    static createForClass<T extends object>(target: new () => T) {
        // 1. Obtener nombre de la tabla (Hoja)
        const sheetName = Reflect.getMetadata(TABLE_NAME_KEY, target);

        // 2. Obtener la llave primaria
        const primaryKey = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, target);

        // 3. Obtener el mapa de columnas (TABLE_COLUMN_DETAILS_KEY está en el prototipo)
        const columns = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, target.prototype) || {};

        // --- AGREGAR ESTO ---
        const virtuals = Reflect.getMetadata('sheets:virtuals', target.prototype) || {};
        // 4. Obtener nombres de las relaciones registradas
        const relationKeys: string[] = Reflect.getMetadata('sheets:all_relations', target.prototype) || [];
        const relations = relationKeys.map(key => ({
            property: key,
            config: Reflect.getMetadata(RELATION_METADATA_KEY, target.prototype, key)
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
