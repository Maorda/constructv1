import { COLUMN_METADATA_KEY, COLUMN_NAMES_KEY, PRIMARY_KEY_METADATA_KEY, TABLE_COLUMN_KEY } from "@database/constants/metadata.constants";
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
    /**
     * Obtiene las opciones del decorador @Column para una propiedad específica.
     * Soporta rutas profundas (deep paths) si se le provee el contexto necesario.
     */
    getColumnOptions(target: any, path: string): ColumnOptions | undefined {
        if (!target || !path) return undefined;

        // Si el path es profundo (ej: "cuadrilla.obra.nombre"), 
        // necesitamos resolver el target hasta el último nivel.
        const parts = path.split('.');

        if (parts.length === 1) {
            // Caso simple: "nombre"
            // Buscamos en el prototipo de la clase
            const prototype = typeof target === 'function' ? target.prototype : Object.getPrototypeOf(target);
            return Reflect.getMetadata(TABLE_COLUMN_KEY, prototype, path);
        } else {
            /**
             * Caso complejo: "cuadrilla.nombre"
             * Aquí hay un reto: Para saber el tipo de "nombre" dentro de "cuadrilla",
             * necesitamos saber de qué CLASE es la propiedad "cuadrilla".
             */
            return this.resolveDeepMetadata(target, parts);
        }
    }

    /**
     * Resuelve metadatos navegando a través de las clases relacionadas.
     */
    private resolveDeepMetadata(target: any, parts: string[]): ColumnOptions | undefined {
        let currentTarget = typeof target === 'function' ? target.prototype : Object.getPrototypeOf(target);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, currentTarget, part);

            // Si es el último elemento del path, devolvemos sus opciones
            if (i === parts.length - 1) {
                return options;
            }

            // Si no es el último, necesitamos saltar a la clase de la relación
            // Esto requiere que tu decorador @Column guarde el 'target' o 'type' de la relación.
            if (options && (options as any).target) {
                currentTarget = (options as any).target.prototype;
            } else {
                // Si no hay información de la clase hija, no podemos seguir navegando
                return undefined;
            }
        }
        return undefined;
    }


}