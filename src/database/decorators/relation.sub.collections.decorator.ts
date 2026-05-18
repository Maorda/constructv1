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

/**
 * Firma 1: Solo la Entidad (Mantiene comportamiento seguro por defecto)
 * @example @SubCollection(AsistenciaDiariaEntity)
 */
export function SubCollection(targetEntity: EntityClass, options?: SubCollectionOptions): PropertyDecorator;

/**
 * Firma 2: Función flecha para diferir inicialización y evitar dependencias circulares
 * @example @SubCollection(() => AsistenciaDiariaEntity, { onDelete: 'RESTRICT' })
 */
export function SubCollection(targetFn: () => EntityClass, options?: SubCollectionOptions): PropertyDecorator;

/**
 * Implementación unificada del decorador @SubCollection con control de borrado
 */
export function SubCollection(
    arg: EntityClass | (() => EntityClass),
    options?: SubCollectionOptions
): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const propertyName = propertyKey.toString();
        const parentEntityName = target.constructor.name;

        // 1. RESOLUCIÓN DINÁMICA DE LA CLASE EN TIEMPO DE EJECUCIÓN
        let targetEntityClass: EntityClass;
        if (typeof arg === 'function' && !arg.prototype) {
            targetEntityClass = (arg as () => EntityClass)();
        } else {
            targetEntityClass = arg as EntityClass;
        }

        // 2. INFERENCIA AUTOMÁTICA DE NOMBRE DE HOJA Y LLAVES
        const targetSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetEntityClass) ||
            targetEntityClass.name.replace(/(Entity|Model)$/i, '').toUpperCase();

        const inferredJoinColumn = options?.joinColumn || `${parentEntityName.replace(/(Entity|Model)$/i, '').toLowerCase()}Id`;
        const inferredLocalField = options?.localField || 'id';

        // Estrategia elegida (Por seguridad del negocio, si no se envía, se asume RESTRICT)
        const selectedOnDelete = options?.onDelete || 'RESTRICT';

        // 3. CONFIGURACIÓN DEL REGISTRO DE RELACIONES
        const relationConfig: RelationOptions = {
            targetEntity: () => targetEntityClass,
            targetSheet: targetSheetName,
            localField: inferredLocalField,
            joinColumn: inferredJoinColumn,
            isMany: true,
            onDelete: selectedOnDelete
        };

        // Guardar en metadatos del objeto para hidratación/populates
        Reflect.defineMetadata(SHEETS_ALL_RELATIONS, relationConfig, target, propertyName);

        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target) || [];
        if (!relationsList.includes(propertyName)) {
            relationsList.push(propertyName);
            Reflect.defineMetadata(SHEETS_RELATIONS_LIST, relationsList, target);
        }

        // 4. INYECCIÓN EN EL MOTOR DE CASCADAS DEL PERSISTENCE_ENGINE
        const existingDeps = GLOBAL_RELATION_REGISTRY.get(parentEntityName) || [];
        const alreadyRegistered = existingDeps.some(d =>
            d.childSheet === relationConfig.targetSheet && d.joinColumn === relationConfig.joinColumn
        );

        if (!alreadyRegistered) {
            existingDeps.push({
                parentEntity: parentEntityName,
                childSheet: relationConfig.targetSheet,
                childRepository: relationConfig.childRepository,
                joinColumn: relationConfig.joinColumn,
                localField: relationConfig.localField,
                onDelete: selectedOnDelete // 🚀 AQUÍ ESTÁ LA MAGIA: Ya no está harcodeado a 'CASCADE'
            });
            GLOBAL_RELATION_REGISTRY.set(parentEntityName, existingDeps);
        }
    }
}