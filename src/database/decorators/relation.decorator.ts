import 'reflect-metadata';

export const RELATION_METADATA_KEY = Symbol('sheets:relation');
// Registro global para que el motor sepa qué hojas dependen de qué entidad
export const GLOBAL_RELATION_REGISTRY = new Map<string, any[]>();

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
        const config: RelationOptions = {
            isMany: true,
            ...options,
        };

        // 1. Guardar metadatos en la propiedad (lo que ya hacías)
        Reflect.defineMetadata(RELATION_METADATA_KEY, config, target, propertyKey);

        // 2. Registrar en la lista de relaciones de esta clase (para el populate)
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', target) || [];
        if (!relations.includes(propertyKey.toString())) {
            relations.push(propertyKey.toString());
            Reflect.defineMetadata('sheets:all_relations', relations, target);
        }

        // 3. REGISTRO PARA CASCADA (Lo nuevo)
        // Obtenemos el nombre de la entidad "padre" (la clase donde estamos parados)
        const parentEntityName = target.constructor.name;

        // Resolvemos la entidad destino para saber a quién "vigila" esta relación
        const targetEntityName = options.targetEntity().name;

        const existingDeps = GLOBAL_RELATION_REGISTRY.get(targetEntityName) || [];

        // Evitamos duplicados en el registro global
        const alreadyRegistered = existingDeps.some(d =>
            d.childSheet === parentEntityName && d.joinColumn === options.joinColumn
        );

        if (!alreadyRegistered) {
            existingDeps.push({
                parentEntity: targetEntityName, // Ejemplo: 'Obrero'
                childSheet: options.targetSheet, // Ejemplo: 'Asistencias'
                childRepository: options.targetRepository, // Ejemplo: 'AsistenciasService'
                joinColumn: options.joinColumn, // Ejemplo: 'obreroId'
            });
            GLOBAL_RELATION_REGISTRY.set(targetEntityName, existingDeps);
        }
    };
}