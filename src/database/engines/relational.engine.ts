// relation.manager.ts
import { Inject, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { GLOBAL_RELATION_REGISTRY, RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { ModuleRef } from '@nestjs/core';
import { SheetsDataGateway } from '@database/services/sheetDataGateway';
import { CompareEngine } from './compare.engine';
import { PersistenceEngine } from '@database/engine/persistence.engine';
import { GettersEngine } from '@database/engine/getters.engine';
export class RelationalEngine<T extends object> {
    private readonly logger = new Logger(RelationalEngine.name);
    @Inject(CACHE_MANAGER) private cacheManager: Cache
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    public sheetName: string;
    protected headers: string[] = [];
    private isSynced = false;
    private _targetEntityName: string;
    constructor(
        private readonly gateway: SheetsDataGateway<T>,
        private readonly compareEngine: CompareEngine,
        private readonly persistenceEngine: PersistenceEngine<T>,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef,
        private readonly relationalEngine: RelationalEngine<T>,

    ) {
    }

    /**
     * Resuelve y carga datos relacionados para una entidad.
     * Cero lógica de hidratación propia: delega al Repository del destino.
     */
    async populate(entity: any, path: string): Promise<any> {
        const target = entity.constructor.prototype;
        const relation: RelationOptions = Reflect.getMetadata(RELATION_METADATA_KEY, target, path);

        if (!relation) {
            this.logger.warn(`No se encontró configuración de relación para el path: ${path}`);
            return entity;
        }

        // 1. Obtener el servicio hermano (Repository) desde ModuleRef
        // Usamos relation.targetRepository que definiste en tu decorador
        const childService = this.moduleRef.get(relation.targetRepository, { strict: false });

        // 2. Obtener el valor de la llave local
        const localValue = entity[relation.localField];
        if (!localValue) return entity;

        // 3. Navegación: Ejecutamos la búsqueda en el servicio hijo
        // Aprovechamos que el servicio hijo ya tiene sus propios motores de Getters y Manipulate
        let relatedData;
        if (relation.isMany) {
            // Buscamos todos los que tengan la FK igual a nuestro localField
            relatedData = await childService.findAll({ [relation.joinColumn]: localValue });
        } else {
            // Buscamos el primero (One-to-One / Many-to-One)
            relatedData = await childService.findOne({ [relation.joinColumn]: localValue });
        }

        // 4. Inyección del resultado en la propiedad original
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
        const dependencies = GLOBAL_RELATION_REGISTRY.get(entityName) || [];

        for (const dep of dependencies) {
            const childService = this.moduleRef.get(dep.childRepository, { strict: false });
            const related = await childService.findAll({ [dep.joinColumn]: id });

            if (related.length === 0) continue;

            // Aquí aplicamos la filosofía del decorador onDelete
            // Nota: Habría que añadir 'onDelete' al GLOBAL_RELATION_REGISTRY para que esto sea dinámico
            const strategy = 'CASCADE'; // Valor por defecto o recuperado del registro

            if (strategy === 'CASCADE') {
                for (const item of related) await childService.remove(item.id);
            } else if (strategy === 'RESTRICT') {
                throw new Error(`No se puede eliminar: Existen dependencias en ${dep.childSheet}`);
            }
        }
    }


}
