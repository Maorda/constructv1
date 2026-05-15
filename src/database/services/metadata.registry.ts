import { ColumnOptions } from "@database/decorators/column.decorator";
import { getPrimaryKeyColumnName } from "@database/decorators/primarykey.decorator";
import { Injectable } from "@nestjs/common";

import {
    SHEETS_PRIMARY_KEY,
    SHEETS_COLUMN_DETAILS,
    SHEETS_ALL_RELATIONS
} from '../constants/metadata.constants';

@Injectable()
export class MetadataRegistry {
    /**
     * Obtiene el nombre de la propiedad TS (ej: 'id' o 'dni') marcada como PK.
     * Se busca en el Constructor.
     */
    getPrimaryKeyField(entityClass: any): string {
        return Reflect.getMetadata(SHEETS_PRIMARY_KEY, entityClass) || 'id';
    }

    /**
     * Obtiene el nombre real de la cabecera en Google Sheets para la PK.
     */
    getPrimaryKeySheetName(entityClass: any): string {
        return getPrimaryKeyColumnName(entityClass) || 'id';
    }

    /**
     * Obtiene la configuración de todas las columnas.
     * Ya no itera ni reconstruye: lee directamente el mapa centralizado.
     */
    getColumnDetails(target: Function): Record<string, ColumnOptions> {
        // Buscamos en el prototipo el mapa que llenó el decorador @Column
        return Reflect.getMetadata(SHEETS_COLUMN_DETAILS, target.prototype) || {};
    }

    /**
     * Obtiene las opciones de una columna específica por su path.
     * Soporta acceso directo y navegación profunda.
     */
    getColumnOptions(target: any, path: string): ColumnOptions | undefined {
        if (!target || !path) return undefined;

        const prototype = typeof target === 'function' ? target.prototype : Object.getPrototypeOf(target);
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, prototype) || {};

        if (!path.includes('.')) {
            return details[path];
        }

        // Para paths profundos (ej: "obra.nombre"), delegamos a la resolución de tipos
        return this.resolveDeepMetadata(target, path.split('.'));
    }

    /**
     * Resuelve metadatos navegando por las relaciones @Relation
     */
    private resolveDeepMetadata(target: any, parts: string[]): ColumnOptions | undefined {
        let currentTarget = typeof target === 'function' ? target : target.constructor;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;

            // 1. Obtener detalles del nivel actual
            const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, currentTarget.prototype) || {};

            if (isLast) {
                return details[part];
            }

            // 2. Si no es el último, buscar la clase de la relación para saltar a ella
            const relOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, currentTarget.prototype, part);

            if (relOptions && relOptions.targetEntity) {
                currentTarget = relOptions.targetEntity(); // Saltamos a la clase destino
            } else {
                return undefined; // Rompe el path si no hay relación decorada
            }
        }
        return undefined;
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