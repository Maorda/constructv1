import 'reflect-metadata';

// Registro global para que el motor sepa qué hojas dependen de qué entidad
export const GLOBAL_RELATION_REGISTRY = new Map<string, any[]>();

import {
    SHEETS_TABLE_NAME,
    SHEETS_ALL_RELATIONS,
    SHEETS_RELATIONS_LIST
} from '../constants/metadata.constants';

export interface RelationOptions {
    targetEntity: () => new () => any;
    targetSheet: string;
    targetRepository: string; // <--- Necesario para que ModuleRef encuentre el servicio hijo
    joinColumn: string;
    localField: string;
    isMany?: boolean;
    onDelete?: 'CASCADE' | 'SET_NULL' | 'RESTRICT'; // <--- Control de daños
}

export function Relation(options: RelationOptions): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const targetEntity = options.targetEntity();

        // --- 1. INFERENCIA DE TABLA DESTINO ---
        // Buscamos el nombre de la hoja en la entidad relacionada
        const inferredSheet = options.targetSheet || Reflect.getMetadata(SHEETS_TABLE_NAME, targetEntity);

        const config: RelationOptions = {
            isMany: true, // Valor por defecto
            ...options,
            targetSheet: inferredSheet
        };

        // --- 2. REGISTRO DE CONFIGURACIÓN (Por Propiedad) ---
        // Se guarda en el prototipo para que el Mapper sepa cómo cargar esta relación
        Reflect.defineMetadata(SHEETS_ALL_RELATIONS, config, target, propertyKey);

        // --- 3. REGISTRO EN LA LISTA DE RELACIONES (Para Populate) ---
        // Importante: Usamos SHEETS_RELATIONS_LIST en lugar de strings sueltos
        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target) || [];
        if (!relationsList.includes(propertyKey.toString())) {
            relationsList.push(propertyKey.toString());
            Reflect.defineMetadata(SHEETS_RELATIONS_LIST, relationsList, target);
        }

        // --- 4. REGISTRO PARA LÓGICA DE CASCADA ---
        const parentEntityName = target.constructor.name;
        const targetEntityName = targetEntity.name;

        const existingDeps = GLOBAL_RELATION_REGISTRY.get(targetEntityName) || [];

        // Verificamos si la relación ya está registrada para evitar bucles
        const alreadyRegistered = existingDeps.some(d =>
            d.childSheet === parentEntityName && d.joinColumn === options.joinColumn
        );

        if (!alreadyRegistered) {
            existingDeps.push({
                parentEntity: targetEntityName,   // Ejemplo: 'ObreroEntity'
                childSheet: config.targetSheet,   // Nombre de la hoja resuelto
                childRepository: options.targetRepository,
                joinColumn: options.joinColumn,    // La columna que une ambas tablas
            });
            GLOBAL_RELATION_REGISTRY.set(targetEntityName, existingDeps);
        }
    };
}