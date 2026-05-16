import { ColumnOptions } from "@database/decorators/column.decorator";
import { getPrimaryKeyColumnName } from "@database/decorators/primarykey.decorator";
import { Injectable } from "@nestjs/common";

import {
    SHEETS_PRIMARY_KEY,
    SHEETS_COLUMN_DETAILS,
    SHEETS_ALL_RELATIONS,
    SHEETS_COLUMN_LIST
} from '../constants/metadata.constants';

@Injectable()
export class MetadataRegistry {
    /* Obtiene el nombre de la propiedad TS (ej: 'id' o 'dni') marcada como PK.
     * Se busca directamente en la clase constructora.
     */
    getPrimaryKeyField(entityClass: any): string {
        const targetClass = typeof entityClass === 'function' ? entityClass : entityClass.constructor;
        return Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) || 'id';
    }

    /**
     * Obtiene el nombre real de la cabecera en Google Sheets para la PK.
     */
    getPrimaryKeySheetName(entityClass: any): string {
        const targetClass = typeof entityClass === 'function' ? entityClass : entityClass.constructor;
        return getPrimaryKeyColumnName(targetClass) || 'id';
    }

    /**
     * Obtiene la configuración de todas las columnas.
     * Lee directamente del mapa centralizado guardado en el Constructor de la Clase.
     */
    getColumnDetails(target: Function): Record<string, ColumnOptions> {
        const targetClass = typeof target === 'function' ? target : (target as any).constructor;
        return Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetClass) || {};
    }

    /**
     * Obtiene las opciones de una columna específica por su path jerárquico.
     */
    getColumnOptions(target: any, path: string): ColumnOptions | undefined {
        if (!target || !path) return undefined;

        const targetClass = typeof target === 'function' ? target : target.constructor;
        const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetClass) || {};

        if (!path.includes('.')) {
            return details[path];
        }

        return this.resolveDeepMetadata(targetClass, path.split('.'));
    }

    /**
     * Resuelve metadatos navegando por las relaciones @Relation
     */
    private resolveDeepMetadata(targetClass: any, parts: string[]): ColumnOptions | undefined {
        let currentTarget = targetClass;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;

            const details = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, currentTarget) || {};

            if (isLast) {
                return details[part];
            }

            // Las relaciones se guardan en el prototipo de la propiedad
            const relOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, currentTarget.prototype, part);

            if (relOptions && relOptions.targetEntity) {
                currentTarget = relOptions.targetEntity(); // Saltamos a la clase constructora destino
            } else {
                return undefined;
            }
        }
        return undefined;
    }

    /**
     * Genera dinámicamente el mapa de índices posicionales { propertyName: columnIndex }
     * basándose en la lista ordenada real generada por el decorador @Column.
     */
    getColumnMap(entityClass: any): Record<string, number> {
        const targetClass = typeof entityClass === 'function' ? entityClass : entityClass.constructor;
        const orderedColumns: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, targetClass) || [];

        const map: Record<string, number> = {};
        orderedColumns.forEach((colName, index) => {
            map[colName] = index;
        });

        return map;
    }

}