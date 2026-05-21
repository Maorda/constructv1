// @database/engines/orchestrators/mutation.orchestrator.ts
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { deepClone, SheetDocument } from "@database/wrapper/sheet.document";
import { ModuleRef } from "@nestjs/core";
import { GLOBAL_RELATION_REGISTRY } from "@database/decorators/relation.sub.collections.decorator";
import { QueryNormalizer } from "@database/utils/query.normalizer";
import { UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";
import { FilterQuery, UpdateQuery, UpdateAggregationPipeline } from "@database/types/query.types";

@Injectable()
export class MutationOrchestrator {
    private readonly logger = new Logger(MutationOrchestrator.name);

    constructor(
        // Inyectamos ModuleRef para resolver los repositorios hijos en tiempo real durante la cascada
        private readonly moduleRef: ModuleRef,
        private readonly queryNormalizer: QueryNormalizer
    ) { }
    /**
     * 🚀 ABSORBE: CreateOrchestrator
     * Flujo directo de fábrica de entidad -> persistencia -> hidratación
     */
    async create<T extends object>(
        repository: SheetsRepository<T>,
        docData: Partial<T>
    ): Promise<SheetDocument<T>> {
        this.logger.debug(`[Mutation] Creando nuevo registro en ${repository.sheetName}`);

        // 1. Instanciar la entidad
        const entityInstance = new repository.entityClass();
        Object.assign(entityInstance, docData);

        // 2. Persistencia física
        const savedData = await repository.ctx.persistenceEngine.save(entityInstance);

        // 3. Hidratación y Blindaje con el Hydrator
        const hydratedDoc = repository.ctx.hydrator.hydrateAndShield(
            repository.entityClass,
            repository,
            savedData
        );

        if (!hydratedDoc) {
            this.logger.warn(`[Mutation] Documento vacío tras hidratación para ${repository.entityClass.name}`);
            return savedData as any;
        }

        return hydratedDoc;
    }

    /**
     * Reemplaza a UpdatePartialOrchestrator (Lógica exacta de tu archivo original)
     */
    async updatePartial<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number,
        changes: Partial<T>
    ): Promise<SheetDocument<T>> {
        const ctx = repository.ctx;

        // 1. Obtener índice físico
        const rowIndex = await ctx.gettersEngine.getRowIndexById(id);

        if (rowIndex === -1) {
            throw new NotFoundException(
                `[Mutation] No se pudo realizar la actualización parcial. El registro con ID "${id}" no existe en ${repository.sheetName}.`
            );
        }

        // 2. Persistencia por lotes si hay cambios
        if (Object.keys(changes).length > 0) {
            await ctx.persistenceEngine.updatePartialBatch(rowIndex, changes);
            this.logger.debug(`[Mutation] ID ${id} persistido en fila física ${rowIndex + 2}`);
        }

        // 3. Re-hidratación mediante el repositorio
        const freshData = await repository.findById(id);

        if (!freshData) {
            throw new NotFoundException(`[Mutation] Error de concurrencia: El registro "${id}" desapareció después de actualizar.`);
        }

        return freshData;
    }

    async delete<T extends object>(
        repository: SheetsRepository<T>,
        idOrEntity: string | number | T
    ): Promise<void> {
        try {
            this.logger.log(`\n--- 🗑️ INICIO ELIMINACIÓN EN [${repository.sheetName}] ---`);

            // 1. Obtener la entidad completa si solo se pasó el ID (necesario para leer su Primary Key y borrar a los hijos)
            let entity: any = idOrEntity;
            if (typeof idOrEntity === 'string' || typeof idOrEntity === 'number') {
                entity = await repository.findById(idOrEntity);
                if (!entity) {
                    this.logger.warn(`[Mutation] El registro ${idOrEntity} no existe. Omitiendo borrado.`);
                    return; // Idempotencia: Si ya no está, consideramos la operación exitosa
                }
            }

            // 2. Procesar las cascadas de borrado antes de tocar al padre
            await this.processCascades(repository, entity);

            // 3. Borrado físico del padre
            this.logger.log(`[Mutation] Procediendo a la baja definitiva del registro padre en: [${repository.sheetName}]`);
            await repository.ctx.persistenceEngine.delete(idOrEntity);

            this.logger.log(`--- 🗑️ FIN ELIMINACIÓN EN [${repository.sheetName}] ---\n`);
        } catch (error: any) {
            this.logger.error(`[Mutation] ❌ Error ejecutando eliminación: ${error.message}`);
            throw error;
        }
    }
    /**
     * 🧠 Lógica central de Cascade Delete (Manejador Interno Privado)
     */
    private async processCascades<T extends object>(
        repository: SheetsRepository<T>,
        entity: any
    ): Promise<void> {
        const parentName = repository.entityClass.name;

        // Consultamos el plano estructural inyectado por SchemaFactory
        const relations = GLOBAL_RELATION_REGISTRY.get(parentName) || [];

        if (relations.length === 0) return; // No hay dependencias, salimos rápido

        this.logger.log(`[CascadeDelete] Analizando ${relations.length} dependencias estructurales para ${parentName}`);

        for (const config of relations) {
            // Solo procesamos si la estrategia es CASCADE
            if (config.onDelete !== 'CASCADE') continue;

            // Obtenemos el valor de la clave local (ej. el DNI de un Obrero para buscar sus Asistencias)
            const localValue = entity[config.localField || 'id'] || entity._id || entity.__row;
            if (!localValue) continue;

            // Resolvemos el repositorio hijo dinámicamente usando el contenedor de NestJS
            const childRepository = this.moduleRef.get(config.childRepository, { strict: false }) as SheetsRepository<any>;

            if (childRepository) {
                this.logger.log(`[CascadeDelete] Limpiando registros hijos dependientes en columna: "${config.joinColumn}" con valor: "${localValue}"`);

                // Buscamos todos los hijos huérfanos
                const children = await childRepository.find({ [config.joinColumn]: localValue });

                // 🔄 Llamada Recursiva: Borramos a los hijos enviándolos de vuelta a su propio flujo de delete()
                // Esto asegura que si el hijo tiene otros hijos (Cascada multinivel), también se borren.
                for (const child of children) {
                    const childId = child.id || child._id || child.__row;
                    if (childId) {
                        await childRepository.delete(childId);
                    } else {
                        await childRepository.delete(child);
                    }
                }
            }
        }
    }
    /**
     * 🚀 ABSORBE: RelationalUpsertOrchestrator
     * Ejecuta operaciones avanzadas como $push en subcolecciones físicas.
     */
    async upsertRelational<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {

        const isPushOperation = !!updateData.$push;
        const operation = isPushOperation ? 'PUSH' : 'UNKNOWN';

        if (!isPushOperation) {
            throw new Error("[Mutation] upsertRelational actualmente está optimizado para operaciones $push.");
        }

        // 1. Buscar el documento padre
        const padreDocumento = await repository.findOne(filter);
        if (!padreDocumento) {
            throw new NotFoundException(`[Mutation] Documento padre no encontrado para operación relacional.`);
        }

        const payload = updateData.$push;
        const relationsList = Object.keys(payload);
        const parentName = repository.entityClass.name;
        const relationsRegistry = GLOBAL_RELATION_REGISTRY.get(parentName) || [];

        // 2. Procesar cada campo relacional enviado en el $push
        for (const relField of relationsList) {
            const config = relationsRegistry.find(r => r.property === relField || r.childSheet === relField);
            if (!config) continue;

            let data = payload[relField];
            if (!Array.isArray(data)) data = [data]; // Normalizar a array si mandaron un solo objeto

            // Extraer la clave local (ej: DNI del obrero)
            const localValue = (padreDocumento as any)[config.localField || 'id'] || (padreDocumento as any)._id;
            if (!localValue) continue;

            // Instanciar el repositorio del hijo al vuelo
            const childRepository = this.moduleRef.get(config.childRepository, { strict: false }) as SheetsRepository<any>;
            if (!childRepository) continue;

            // 3. Crear/Actualizar hijos dinámicamente
            for (const rawHijo of data) {
                const hijo = deepClone(rawHijo) as any;
                hijo[config.joinColumn] = localValue; // Forzar la relación inyectando la llave foránea
                delete hijo.__row; // Limpieza por seguridad

                const childPrimaryKey = (childRepository as any).metadata?.primaryKey || 'id';

                // Resolución del filtro dinámico
                let filtroHijo = this.resolveChildFilter(hijo, operation, childPrimaryKey, config, localValue);

                // 🚀 Aplicamos el QueryNormalizer inyectado
                const childEntityClass = (childRepository as any).entityClass;
                filtroHijo = this.queryNormalizer.normalize(childEntityClass, filtroHijo);

                // Usamos el repositorio hijo para guardar, lo que desencadena su propio ciclo de hidratación
                await childRepository.findOneAndUpdate(filtroHijo, hijo, { upsert: true, new: true });
            }
        }

        // 4. Re-hidratación final: Poblamos la relación para devolver el padre actualizado con los nuevos hijos
        for (const relField of relationsList) {
            await repository.ctx.relationEngine.populate(padreDocumento as any, relField);
        }

        return padreDocumento;
    }
    /**
     * Helper Privado: Resuelve el filtro para saber si un hijo debe insertarse o actualizarse
     */
    private resolveChildFilter(hijo: any, operation: string, pk: string, config: any, localValue: any) {
        if (operation === 'PUSH' && !hijo[pk]) {
            // Lógica para deducir identidad si no hay primary key (ej: registros de asistencia por hora/tipo)
            return {
                [config.joinColumn]: localValue,
                ...(hijo.tipoMarca ? { tipoMarca: hijo.tipoMarca } : {}),
                ...(hijo.hora ? { hora: hijo.hora } : {})
            };
        }
        // Si tiene PK, actualiza ese registro específico
        return hijo[pk] ? { [pk]: hijo[pk] } : { [config.joinColumn]: localValue };
    }

    /**
     * 🚀 ABSORBE: FindOrCreateOrchestrator
     * Busca un documento o lo crea si no existe.
     */
    async findOrCreate<T extends object>(
        repository: SheetsRepository<T>,
        filter: Partial<T>,
        defaults: Partial<T>
    ): Promise<SheetDocument<T>> {
        this.logger.debug(`[Mutation] Ejecutando findOrCreate en ${repository.sheetName}`);

        // 1. Usamos el propio repositorio para buscar (que delega al QueryOrchestrator internamente)
        const existing = await repository.findOne(filter as FilterQuery<T>);
        if (existing) return existing;

        // 2. Si no existe, unimos el filtro con los valores por defecto
        const combinedData = { ...defaults, ...filter };

        // 3. Reutilizamos el método 'create' que ya construimos en este mismo Orquestador
        return await this.create(repository, combinedData as Partial<T>);
    }

    async update<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | UpdateAggregationPipeline,
        options: UpdateOptions = { upsert: false, new: true }
    ): Promise<SheetDocument<T> | null> {

        this.logger.debug(`[Mutation] Ejecutando update complejo en ${repository.sheetName}`);

        let savedData: any = null;
        let oldDataFlat: any = null;
        const ctx = repository.ctx;

        // --------------------------------------------------------
        // 🔱 Bifurcación A: Pipeline de Agregación (Array)
        // --------------------------------------------------------
        if (Array.isArray(updateData)) {
            const currentDoc = await repository.findOne(filter);
            if (!currentDoc && !options.upsert) return null;

            oldDataFlat = currentDoc ? currentDoc.toObject() : null;
            const rawRecord = currentDoc ? currentDoc.toObject() : { ...filter };

            // Ejecutamos el pipeline en memoria usando el motor de consultas
            const pipelineResult = await ctx.queryEngine.aggregate([rawRecord], updateData);
            if (!pipelineResult || pipelineResult.length === 0) return null;

            const mutatedData = pipelineResult[0];
            delete mutatedData.__row; // Limpieza de seguridad

            const entityInstance = new repository.entityClass();
            Object.assign(entityInstance, mutatedData);

            // Guardamos físicamente la fila modificada
            savedData = await ctx.persistenceEngine.save(entityInstance);
        }
        // --------------------------------------------------------
        // 🔱 Bifurcación B: Lógica Clásica (Objeto)
        // --------------------------------------------------------
        else {
            if (options.new === false) {
                const preDoc = await repository.findOne(filter);
                oldDataFlat = preDoc ? preDoc.toObject() : null;
            }
            // Delegamos a la persistencia de bajo nivel
            savedData = await ctx.persistenceEngine.findOneAndUpdate(filter, updateData, options);
        }

        if (!savedData) return null;

        // 3. Hidratación y Blindaje
        const dataToHydrate = (options.new === false && oldDataFlat) ? oldDataFlat : savedData;

        return ctx.hydrator.hydrateAndShield(repository.entityClass, repository, dataToHydrate, {
            new: options.new,
            oldDataFlat
        });
    }
}