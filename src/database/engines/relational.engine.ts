// relation.manager.ts
import { Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '../decorators/relation.decorator';

import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { ModuleRef } from '@nestjs/core';
import { SHEETS_ALL_RELATIONS } from '@database/constants/metadata.constants';

export class RelationalEngine<T extends object> {
    private readonly logger = new Logger(RelationalEngine.name);
    @Inject(CACHE_MANAGER) private cacheManager: Cache
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    public sheetName: string;
    protected headers: string[] = [];
    private isSynced = false;
    private _targetEntityName: string;
    constructor(
        private readonly moduleRef: ModuleRef,
    ) {
    }

    /**
     * Resuelve y carga datos relacionados para una entidad.
     * Cero lógica de hidratación propia: delega al Repository del destino.
     */
    async populate(entity: any, path: string): Promise<any> {
        if (!entity) return entity;

        // 1. Obtener metadatos de la relación desde el prototipo
        const targetPrototype = Object.getPrototypeOf(entity);
        const relation: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetPrototype, path);

        if (!relation) {
            this.logger.warn(`No se encontró @Relation para el path: ${path} en ${entity.constructor.name}`);
            return entity;
        }

        // 2. Obtener el repositorio hijo dinámicamente
        const childService = this.moduleRef.get(relation.targetRepository, { strict: false });
        if (!childService) {
            this.logger.error(`Repositorio ${relation.targetRepository} no disponible.`);
            return entity;
        }

        // 3. Obtener el valor de la llave local (ej: id_obra)
        const localValue = entity[relation.localField];
        if (localValue === undefined || localValue === null) return entity;

        // 4. Delegar la búsqueda al hijo
        let relatedData;
        const query = { [relation.joinColumn]: localValue };

        if (relation.isMany) {
            // Caso 1:N - Buscamos todos los hijos
            relatedData = await childService.findAll(query);
        } else {
            // Caso 1:1 o N:1 - Buscamos el primero
            relatedData = await childService.findOne(query);
        }

        // 5. Inyectar datos en la propiedad (Hidratación)
        entity[path] = relatedData;
        return entity;
    }

    /**
     * Gestiona las actualizaciones en cascada (Cascading Updates)
     * Se activa cuando una PrimaryKey cambia.
     */
    async handleCascadeUpdate(entityName: string, oldId: any, newId: any): Promise<void> {
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];

        for (const dep of dependencies) {
            try {
                const childService = this.moduleRef.get(dep.childRepository, { strict: false });

                // Buscamos registros dependientes
                const relatedRecords = await childService.findAll({ [dep.joinColumn]: oldId });

                if (relatedRecords.length > 0) {
                    this.logger.log(`Cascada: Actualizando ${relatedRecords.length} registros en ${dep.childSheet}`);
                    for (const record of relatedRecords) {
                        // El childService se encarga de su propia persistencia
                        await childService.update(record.id, { [dep.joinColumn]: newId });
                    }
                }
            } catch (e) {
                this.logger.error(`Error en cascada hacia ${dep.childSheet}: ${e.message}`);
            }
        }
    }

    /**
     * Orquestador de borrado (Cascade Delete / Restrict)
     */
    async handleOnDelete(entityName: string, id: any): Promise<void> {
        // Usamos el registro global para saber quién depende de esta entidad
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];

        for (const dep of dependencies) {
            const childService = this.moduleRef.get(dep.childRepository, { strict: false });
            if (!childService) continue;

            const related = await childService.findAll({ [dep.joinColumn]: id });
            if (related.length === 0) continue;

            // Por ahora implementamos CASCADE por defecto
            this.logger.log(`[Cascade Delete] Limpiando ${related.length} registros en ${dep.childSheet}`);

            for (const item of related) {
                // Obtenemos el ID del hijo para borrarlo
                const childId = item[childService.primaryKeyProp || 'id'];
                await childService.delete(childId);
            }
        }
    }

}
