// relation.manager.ts
import { Logger } from '@nestjs/common';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '../decorators/relation.sub.collections.decorator';

import { ModuleRef } from '@nestjs/core';
import { SHEETS_ALL_RELATIONS } from '@database/constants/metadata.constants';

export class RelationalEngine {
    private readonly logger = new Logger(RelationalEngine.name);
    constructor(
        private readonly moduleRef: ModuleRef,
    ) {
    }

    /**
     * Resuelve y carga datos relacionados para una entidad.
     * Cero lógica de hidratación propia: delega al Repository del destino.
     */
    /**
     * Resuelve y carga datos relacionados para una entidad de manera dinámica (Lazy/Eager Populate).
     * Delega la lógica de hidratación al Repository del destino.
     */
    async populate<T extends object>(entity: T, path: string): Promise<T> {
        if (!entity) return entity;

        // 1. Obtener metadatos desde el prototipo usando la constante unificada
        const targetPrototype = Object.getPrototypeOf(entity);
        const relation: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetPrototype, path);

        if (!relation) {
            this.logger.warn(`⚠️ No se encontró @Relation para el path: "${path}" en la entidad ${entity.constructor.name}`);
            return entity;
        }

        // 2. Obtener el repositorio hijo dinámicamente desde el árbol de NestJS
        const childService = this.moduleRef.get(relation.targetRepository, { strict: false });
        if (!childService) {
            this.logger.error(`❌ El repositorio destino "${relation.targetRepository}" no está disponible en el contexto actual.`);
            return entity;
        }

        // 3. Obtener el valor de la llave local (ej: id_obra, id_obrero)
        const localValue = (entity as any)[relation.localField];
        if (localValue === undefined || localValue === null) return entity;

        // 4. Delegar la búsqueda al hijo con un query estructurado
        let relatedData;
        const query = { [relation.joinColumn]: localValue };

        if (relation.isMany) {
            // Relación 1:N (Ej: Una Obra tiene muchas Asistencias)
            relatedData = await childService.findAll(query);
        } else {
            // Relación 1:1 o N:1 (Ej: Una Asistencia pertenece a un Obrero)
            relatedData = await childService.findOne(query);
        }

        // 5. Inyectar datos en la propiedad de la instancia (Hidratación)
        (entity as any)[path] = relatedData;
        return entity;
    }

    /**
     * Gestiona las actualizaciones en cascada (Cascading Updates)
     * Se activa cuando una PrimaryKey cambia.
     */
    /**
     * Gestiona las actualizaciones en cascada (Cascading Updates).
     * Se dispara automáticamente cuando una clave primaria cambia su valor físico.
     */
    async handleCascadeUpdate(entityName: string, oldId: any, newId: any): Promise<void> {
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];
        if (dependencies.length === 0) return;

        for (const dep of dependencies) {
            try {
                const childService = this.moduleRef.get(dep.childRepository, { strict: false });
                if (!childService) continue;

                // Buscamos todos los registros dependientes que apuntan al ID antiguo
                const relatedRecords = await childService.findAll({ [dep.joinColumn]: oldId });

                if (relatedRecords.length > 0) {
                    this.logger.log(`🔄 [Cascade Update] Actualizando ${relatedRecords.length} registros en la hoja "${dep.childSheet}" debido a cambio de ID en "${entityName}"`);

                    for (const record of relatedRecords) {
                        const childPrimaryKey = childService.primaryKeyProp || 'id';
                        const childId = record[childPrimaryKey];

                        // Cada repositorio hijo maneja de forma autónoma su persistencia y sus propios ganchos
                        await childService.update(childId, { [dep.joinColumn]: newId });
                    }
                }
            } catch (e) {
                this.logger.error(`❌ Error en actualización por cascada hacia la hoja "${dep.childSheet}": ${e.message}`);
            }
        }
    }

    /**
     * Orquestador de borrado (Cascade Delete / Restrict)
     */
    /**
     * Orquestador de eliminación controlada (Cascade Delete / Restrict)
     */
    async handleOnDelete(entityName: string, id: any): Promise<void> {
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];
        if (dependencies.length === 0) return;

        for (const dep of dependencies) {
            try {
                const childService = this.moduleRef.get(dep.childRepository, { strict: false });
                if (!childService) continue;

                const related = await childService.findAll({ [dep.joinColumn]: id });
                if (related.length === 0) continue;

                this.logger.warn(`🗑️ [Cascade Delete] Eliminando de forma recursiva ${related.length} registros en la hoja "${dep.childSheet}" asociados al ID principal: [${id}]`);

                for (const item of related) {
                    const childPrimaryKey = childService.primaryKeyProp || 'id';
                    const childId = item[childPrimaryKey];

                    // Al ejecutar .delete() del hijo, si el hijo tiene sub-relaciones, se disparará su propia cascada
                    await childService.delete(childId);
                }
            } catch (e) {
                this.logger.error(`❌ Error en eliminación por cascada en la hoja "${dep.childSheet}": ${e.message}`);
            }
        }
    }
}
