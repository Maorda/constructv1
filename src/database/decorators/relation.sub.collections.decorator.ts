import 'reflect-metadata';

import {
    SHEETS_ALL_RELATIONS,
    SHEETS_RELATIONS_LIST,
    SHEETS_TABLE_NAME
} from '../constants/metadata.constants';
export const GLOBAL_RELATION_REGISTRY = new Map<string, any[]>();
export interface RelationOptions {
    targetEntity: () => new () => any;
    // El token de inyección o la clase del repositorio en NestJS
    childRepository?: any | string;
    targetSheet?: string;
    targetRepository?: string; // 👈 Ahora es OPCIONAL
    joinColumn?: string;       // 👈 Ahora es OPCIONAL (Inferencia tipo FK)
    localField?: string;       // 👈 Ahora es OPCIONAL (Por defecto 'id' o la PK de la entidad)
    isMany?: boolean;
    onDelete?: 'CASCADE' | 'SET_NULL' | 'RESTRICT';
}
type EntityClass = new () => any;

// Nuevas opciones específicas para SubColecciones
export interface SubCollectionOptions {
    /** Estrategia de integridad referencial al eliminar el registro Padre */
    onDelete?: 'CASCADE' | 'SET_NULL' | 'RESTRICT';
    /** En caso de requerir mapear un campo destino específico manualmente */
    joinColumn?: string;
    localField?: string;
}
export function SubCollection(
    arg: EntityClass | (() => EntityClass),
    options?: SubCollectionOptions
): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const propertyName = propertyKey.toString();

        // 1. Aseguramos que targetEntity SIEMPRE sea una función diferida (() => Clase)
        const targetEntityFn = typeof arg === 'function' && !arg.prototype
            ? (arg as () => EntityClass)
            : () => arg as EntityClass;

        // 2. Guardamos la configuración cruda. La inferencia la hará el SchemaFactory.
        const relationConfig: any = {
            targetEntity: targetEntityFn,
            options,
            isMany: true,
            propertyName
        };

        Reflect.defineMetadata(SHEETS_ALL_RELATIONS, relationConfig, target, propertyName);

        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target) || [];
        if (!relationsList.includes(propertyName)) {
            relationsList.push(propertyName);
            Reflect.defineMetadata(SHEETS_RELATIONS_LIST, relationsList, target);
        }
    };
}