import { COLUMN_METADATA_KEY, COLUMN_NAMES_KEY, PRIMARY_KEY_METADATA_KEY } from "@database/constants/metadata.constants";
import { ColumnOptions } from "@database/decorators/column.decorator";
import { getPrimaryKeyColumnName } from "@database/decorators/primarykey.decorator";
import { Injectable } from "@nestjs/common";

@Injectable()
export class MetadataRegistry {
    /**
     * Obtiene el nombre de la propiedad (TS) marcada como PrimaryKey
     */
    getPrimaryKeyField(entityClass: any): string {
        return Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, entityClass) || 'id';
    }

    /**
     * Obtiene el nombre de la columna (Sheets) de la PrimaryKey
     * Usando tu función helper
     */
    getPrimaryKeySheetName(entityClass: any): string {
        return getPrimaryKeyColumnName(entityClass) || 'id';
    }
    /**
   * Obtiene la configuración de todas las columnas decoradas en una clase.
   * @param target La clase de la entidad (ej: Obrero)
   */
    getColumnDetails(target: Function): Record<string, ColumnOptions> {
        // Recuperamos el array de nombres de propiedades que tienen el decorador @Column
        const columns: string[] = Reflect.getMetadata(COLUMN_NAMES_KEY, target.prototype) || [];
        const details: Record<string, ColumnOptions> = {};

        columns.forEach(propertyKey => {
            // Recuperamos la configuración específica de cada columna
            const options = Reflect.getMetadata(COLUMN_METADATA_KEY, target.prototype, propertyKey);
            if (options) {
                details[propertyKey] = options;
            }
        });

        return details;
    }
    /**
     * Obtiene el mapa de columnas: { propertyName: columnIndex }
     */
    getColumnMap(entityClass: any): Record<string, number> {
        // Aquí recuperamos los metadatos que tus decoradores @Column guardaron
        // PRIMARY_KEY_METADATA_KEY es el símbolo que usas en tus decoradores
        const columns = Reflect.getMetadata('columns', entityClass.prototype) || {};

        // Si no usas reflect-metadata para guardar el objeto completo, 
        // podrías tener una lógica que itere las propiedades.
        return columns;
    }


}