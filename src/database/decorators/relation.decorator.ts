import 'reflect-metadata';
import {
    SHEETS_TABLE_NAME,
    SHEETS_ALL_RELATIONS,
    SHEETS_RELATIONS_LIST
} from '../constants/metadata.constants';

export interface RelationOptions {
    targetEntity: () => new () => any;
    targetSheet?: string;
    targetRepository?: string; // 👈 Ahora es OPCIONAL
    joinColumn?: string;       // 👈 Ahora es OPCIONAL (Inferencia tipo FK)
    localField?: string;       // 👈 Ahora es OPCIONAL (Por defecto 'id' o la PK de la entidad)
    isMany?: boolean;
    onDelete?: 'CASCADE' | 'SET_NULL' | 'RESTRICT';
}

export const GLOBAL_RELATION_REGISTRY = new Map<string, any[]>();

export function Relation(options: RelationOptions): PropertyDecorator {
    return (target: object, propertyKey: string | symbol) => {
        const targetEntity = options.targetEntity();
        const propertyName = propertyKey.toString();

        // 1. INFERENCIA AGRESIVA DE LA HOJA DESTINO
        // Si no tiene @Table definido, usamos el nombre de la clase eliminando el sufijo "Entity"
        const inferredSheet = options.targetSheet ||
            Reflect.getMetadata(SHEETS_TABLE_NAME, targetEntity) ||
            targetEntity.name.replace(/Entity$/i, '');

        // 2. INFERENCIA DEL REPOSITORIO HIJO
        // Convención: Si la entidad es AsistenciaSemanal, su repositorio en NestJS se llamará AsistenciaSemanalRepository
        const inferredRepository = options.targetRepository || `${targetEntity.name.replace(/Entity$/i, '')}Repository`;

        // 3. INFERENCIA DE COLUMNAS DE UNIÓN (Foreign Keys)
        // Padre: ObreroEntity -> LocalField por defecto es su clave primaria o propiedad 'dni' (o 'id')
        const parentClassName = target.constructor.name.replace(/Entity$/i, ''); // Ej: 'Obrero'
        const inferredLocalField = options.localField || 'dni'; // O tu PK genérica

        // Columna hija por defecto: 'obreroId' o en este caso combinando el contexto 'obreroDni' o 'DNI'
        // Para máxima flexibilidad con lo que ya tienes, si el localField es 'dni', la FK hija será 'obreroDni'
        const inferredJoinColumn = options.joinColumn || `${parentClassName.toLowerCase()}${inferredLocalField.charAt(0).toUpperCase() + inferredLocalField.slice(1)}`;

        const config: RelationOptions = {
            isMany: true,
            ...options,
            targetSheet: inferredSheet,
            targetRepository: inferredRepository,
            localField: inferredLocalField,
            joinColumn: inferredJoinColumn
        };

        // Guardar metadata para el Mapper
        Reflect.defineMetadata(SHEETS_ALL_RELATIONS, config, target, propertyName);

        // Registrar en la lista de campos relacionales del Padre
        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target) || [];
        if (!relationsList.includes(propertyName)) {
            relationsList.push(propertyName);
            Reflect.defineMetadata(SHEETS_RELATIONS_LIST, relationsList, target);
        }

        // 4. REGISTRO AUTOMÁTICO EN EL MOTOR DE CASCADA
        const parentEntityName = target.constructor.name;
        const existingDeps = GLOBAL_RELATION_REGISTRY.get(parentEntityName) || [];

        const alreadyRegistered = existingDeps.some(d =>
            d.childSheet === config.targetSheet && d.joinColumn === config.joinColumn
        );

        if (!alreadyRegistered) {
            existingDeps.push({
                parentEntity: parentEntityName,
                childSheet: config.targetSheet,
                childRepository: config.targetRepository,
                joinColumn: config.joinColumn,
                localField: config.localField,
                onDelete: options.onDelete || 'RESTRICT'
            });
            GLOBAL_RELATION_REGISTRY.set(parentEntityName, existingDeps);
        }
    };
}