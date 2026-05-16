// persistence.manager.ts
import { Logger, Inject, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { SheetsDataGateway } from '../services/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ClassType, FilterQuery, UpdateQuery } from '@database/types/query.types';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '@database/decorators/relation.decorator';
import { GettersEngine } from './getters.engine';
import { ColumnOptions } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { ModuleRef } from '@nestjs/core';
import { AggregationEngine } from '@database/engines/aggregation.engine';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { CompareEngine } from '@database/engines/compare.engine';
import { IdGenerator } from '@database/utils/id.generator';
import { SHEETS_ALL_RELATIONS, SHEETS_COLUMN_DETAILS, SHEETS_DELETE_CONTROL, SHEETS_PRIMARY_KEY, SHEETS_RELATIONS_LIST, SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';
import { withRetry } from '@database/utils/tools';
import { RelationalEngine } from '@database/engines/relational.engine';


export class PersistenceEngine<T extends object> implements IPersistenceEngine<T> {

    private readonly logger = new Logger(PersistenceEngine.name);
    private resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private readonly deleteControlProp: string | null;
    private persistableKeys: string[];
    constructor(
        private readonly entityClass: ClassType<T> | (new () => T),
        private readonly gateway: SheetsDataGateway<T>,
        protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef,
        private readonly aggregationEngine: AggregationEngine<T>,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly compareEngine: CompareEngine,
        private readonly relationalEngine: RelationalEngine,
    ) {
        // 🔥 ESTABILIZACIÓN DE METADATOS EN EL ACTO (CORREGIDO):
        const targetClass = this.entityClass as any;

        this.primaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) || 'dni';
        this.resolvedSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetClass) || `${targetClass.name}S`;

        // Aquí eliminamos 'targetProto' que no existía en este ámbito y usamos el prototipo real
        this.columnDetails = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetClass.prototype) || {};

        this.deleteControlProp = Reflect.getMetadata(SHEETS_DELETE_CONTROL, targetClass.prototype) || null;
    }

    /**
     * Guarda una entidad manejando relaciones complejas en cascada (Flujo Relacional)
     */
    async saveWithRelations(entityClass: ClassType<any>, payload: any): Promise<any> {
        this.logger.log(`[saveWithRelations] Iniciando flujo relacional para ${entityClass.name}`);

        // 1. Aislamos y clonamos la data correspondiente al padre
        const parentData = { ...payload };

        // 🛡️ SANEAMIENTO MÁXIMO (Flujo Relacional):
        // Forzamos el autocompletado de borrado lógico antes de separar las relaciones
        this.sanitizeEntityBeforeStorage(parentData);

        // 2. Extraemos y removemos las propiedades que representan colecciones relacionales
        const relationsMetadata = Reflect.getMetadata(SHEETS_RELATIONS_LIST, entityClass.prototype) || [];
        const relationFieldsData: { [key: string]: any[] } = {};

        relationsMetadata.forEach((field: string) => {
            if (parentData[field] && Array.isArray(parentData[field])) {
                relationFieldsData[field] = parentData[field];
                delete parentData[field]; // Limpieza para persistencia pura del padre
            }
        });

        // 3. Persistencia del Registro Padre mediante append directo o actualización parcial

        const currentPrimaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, entityClass) || 'dni';
        const parentId = parentData[currentPrimaryKeyProp];

        if (!parentId) {
            throw new InternalServerErrorException(`No se pudo determinar la clave primaria [${currentPrimaryKeyProp}] en el payload.`);
        }

        // Buscar si el padre ya existe físicamente en la hoja
        const filter = { [currentPrimaryKeyProp]: parentId };
        const existingParent = await this.gettersEngine.findOneInternal(filter, this.compareEngine);
        let parentResponse: any;

        // 🌟 REFACTOR DE ALINEACIÓN: Traducir propiedades lógicas a Columnas Físicas de Google Sheets
        const currentColumnDetails = this.columnDetails || Reflect.getMetadata(SHEETS_COLUMN_DETAILS, entityClass) || {};
        const physicalPayload: Record<string, any> = {};

        // Recorremos las columnas registradas por el decorador @Column para armar el objeto real que Google Sheets entiende
        Object.keys(currentColumnDetails).forEach(logicalKey => {
            const config = currentColumnDetails[logicalKey];
            const physicalName = config?.name || logicalKey;

            // Jalamos el valor que vino de Insomnia o que inyectó el sanitizador
            const value = parentData[logicalKey] !== undefined ? parentData[logicalKey] : parentData[physicalName];

            if (value !== undefined) {
                physicalPayload[physicalName] = value;
            } else if (config.default !== undefined && config.default !== null) {
                physicalPayload[physicalName] = config.default;
            }
        });

        if (existingParent) {
            const physicalRow = (existingParent as any).__row;
            this.logger.log(`[saveWithRelations] Registro padre existente en fila ${physicalRow}. Ejecutando actualización parcial...`);

            // Enviamos el payload mapeado con nombres físicos
            await this.updatePartialBatch(physicalRow, physicalPayload);
            parentResponse = { ...existingParent, ...parentData };
        } else {
            this.logger.log(`[saveWithRelations] Registro padre no existe. Ejecutando inserción limpia...`);

            // 🚀 ENVIAMOS EL PAYLOAD ALINEADO CON LAS CABECERAS EN MAYÚSCULAS DE GOOGLE SHEETS
            parentResponse = await this.gateway.appendRow(physicalPayload as any);
        }

        // 4. Procesamiento en Cascada de los Registros Hijos (Relaciones)
        const allRelationsMap: Map<string, RelationOptions> = Reflect.getMetadata(SHEETS_ALL_RELATIONS, entityClass.prototype) || new Map();

        for (const field of relationsMetadata) {
            const relationConfig = allRelationsMap.get(field);
            if (!relationConfig) continue;

            const childrenDataArray = relationFieldsData[field] || [];
            const childEntityClass = relationConfig.targetEntity();

            // Resolvemos el Repositorio del hijo de forma dinámica mediante el Contexto Global
            const childRepositoryToken = relationConfig.targetRepository
                ? relationConfig.targetRepository
                : `${childEntityClass.name}Repository`;

            const childRepository = this.moduleRef.get(childRepositoryToken, { strict: false });
            if (!childRepository) {
                throw new InternalServerErrorException(`No se pudo resolver el repositorio dinámico: [${childRepositoryToken}]`);
            }

            const childPersistenceEngine = childRepository.getPersistenceEngine();
            const childForeignKeyField = relationConfig.joinColumn;

            this.logger.log(`[Cascada] Procesando ${childrenDataArray.length} hijos para la relación [${field}]`);

            // Sincronizamos la clave foránea en cada hijo con el ID real del padre
            childrenDataArray.forEach((childData: any) => {
                childData[childForeignKeyField] = parentId;
            });

            // Persistencia masiva de la colección hija
            for (const childData of childrenDataArray) {
                await childPersistenceEngine.saveWithRelations(childEntityClass, childData);
            }
        }

        await this.gettersEngine.clearCache();
        return parentResponse;
    }

    /**
         * Envía actualizaciones parciales mapeando propiedades a coordenadas de celdas A1.
         */
    async updatePartialBatch(physicalRow: number, entity: any): Promise<void> {
        // 🛡️ SANEAMIENTO (Flujo Update): Inyecta controles como Soft Delete si hicieran falta
        this.sanitizeEntityBeforeStorage(entity);

        const sheetResponse = await this.gettersEngine.getOrFetchSheet();
        if (sheetResponse.isEmergency) {
            throw new ServiceUnavailableException('Sistema en modo de emergencia (Lectura). Modificación denegada.');
        }

        const currentColumnDetails = this.columnDetails || {};
        const updatePayload: Record<string, any> = {};

        // El mapeo se ejecuta de forma dinámica ignorando restricciones rígidas del genérico en compilación
        Object.keys(entity).forEach(key => {
            if (currentColumnDetails[key]) {
                const config = currentColumnDetails[key];
                const physicalColumnName = config.name || key;
                updatePayload[physicalColumnName] = entity[key];
            }
        });

        if (Object.keys(updatePayload).length === 0) return;

        try {
            await this.gateway.updateRow(physicalRow, updatePayload);
            await this.gettersEngine.clearCache();
        } catch (error) {
            this.logger.error(`Fallo en updatePartialBatch para fila ${physicalRow}: ${error.message}`);
            throw new InternalServerErrorException(`No se pudo actualizar el registro físico.`);
        }
    }

    /**
     * SAVE: Punto de entrada Active Record. Determina automáticamente si es una inserción o actualización.
     */
    async save(entity: T): Promise<T> {
        console.log('[PersistenceEngine] Datos recibidos para guardar:', entity);

        const targetClass = entity.constructor;
        const currentPrimaryKeyProp = this.primaryKeyProp ||
            Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) ||
            'dni';

        if (!this.resolvedSheetName) {
            (this as any).resolvedSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, targetClass) || `${targetClass.name}S`;
        }

        const id = (entity as any)[currentPrimaryKeyProp];
        let physicalRow = (entity as any).__row;

        if (!physicalRow && id) {
            const filter = { [currentPrimaryKeyProp]: id } as any;
            const existing = await this.gettersEngine.findOneInternal(filter, this.compareEngine);
            if (existing) {
                physicalRow = (existing as any).__row;
                (entity as any).__row = physicalRow;
            }
        }

        try {
            if (physicalRow) {
                await this.updatePartialBatch(physicalRow, entity);
                this.logger.log(`[Update] Registro [${id}] sincronizado en fila física ${physicalRow}`);
            } else {
                await this.create(entity);
            }

            await this.gettersEngine.clearCache();
            return entity;
        } catch (error) {
            this.logger.error(`Error en operación Save en ${this.resolvedSheetName}: ${error.message}`);
            throw new InternalServerErrorException(`No se pudo completar la persistencia del documento.`);
        }
    }
    /**
      * DELETE: Orquesta el borrado físico o lógico de la entidad y delega las cascadas de datos.
      */
    async delete(idOrEntity: string | number | T): Promise<void> {
        let physicalRow: number;
        let id: string | number;

        if (typeof idOrEntity === 'object') {
            physicalRow = (idOrEntity as any).__row;
            id = (idOrEntity as any)[this.primaryKeyProp];
        } else {
            id = idOrEntity;
            physicalRow = await this.gettersEngine.getRowIndexById(id);
        }

        if (!physicalRow || physicalRow === -1) {
            this.logger.warn(`Registro con ID [${id}] no localizado para eliminación.`);
            return;
        }

        // DELEGACIÓN ESTRATÉGICA: El RelationalEngine se encarga de limpiar/desactivar hijos
        if (this.deleteControlProp) {
            // Caso Soft Delete: propagate desactivación a dependientes e inactivar padre
            await this.relationalEngine.handleOnDelete(this.entityClass.name, id);
            await this.updateLogicalStatus(physicalRow, 'INACTIVO');
            this.logger.log(`[SoftDelete] ${this.resolvedSheetName} fila ${physicalRow} marcada como INACTIVO.`);
        } else {
            // Caso Hard Delete: Borrado físico
            await this.relationalEngine.handleOnDelete(this.entityClass.name, id);
            await this.gateway.clearRow(physicalRow);
            this.logger.log(`[HardDelete] Fila ${physicalRow} vaciada físicamente en ${this.resolvedSheetName}.`);
        }

        await this.gettersEngine.clearCache();
    }



    private async updateLogicalStatus(physicalRow: number, status: string): Promise<void> {
        const rawData = await this.gateway.getAllRows(this.resolvedSheetName);
        const headers = rawData[0] || [];

        // Buscamos la columna del @DeleteControl
        const colIndex = headers.findIndex(h =>
            h.toString().trim().toLowerCase() === this.deleteControlProp.toLowerCase()
        );

        if (colIndex !== -1) {
            const range = `${this.resolvedSheetName}!${this.indexToColumnLetter(colIndex)}${physicalRow}`;
            await this.updateCellsBatch([{
                range,
                value: status,
                type: 'string'
            }]);
        }
    }
    async create(entity: T): Promise<T> {
        const sheetInfo = await this.gettersEngine.getOrFetchSheet();
        if (sheetInfo.isEmergency) {
            throw new ServiceUnavailableException('Sistema en modo de emergencia (Lectura). Escritura denegada.');
        }

        // 💥 CAMBIO AQUÍ: Agrega el await porque el generador ahora es asíncrono e inteligente
        await this.applyAutogeneratedFields(entity);

        // Saneamiento del borrado lógico
        this.sanitizeEntityBeforeStorage(entity);

        try {
            const response = await this.gateway.appendRow(entity);
            const physicalRow = response ? (response as any).__row : null;

            if (physicalRow) {
                (entity as any).__row = physicalRow;
                this.logger.log(`[PersistenceEngine] [Create Success] Nuevo registro en ${this.resolvedSheetName}, fila: ${physicalRow}`);
            }

            await this.gettersEngine.clearCache();
            return entity;
        } catch (error) {
            this.logger.error(`Error crítico ejecutando Create en ${this.resolvedSheetName}: ${error.message}`);
            throw new InternalServerErrorException(`Fallo de infraestructura al insertar registro.`);
        }
    }

    /**
     * UPDATE: Modifica una fila basándose en un ID y operadores complejos ($set, $inc, $push).
     */
    async update(id: string | number, updateQuery: UpdateQuery<T>): Promise<T> {
        const currentData = await this.gettersEngine.findOneInternal(
            { [this.primaryKeyProp]: id } as any,
            this.compareEngine
        );

        if (!currentData || !(currentData as any).__row) {
            throw new Error(`No se encontró el registro físico para el ID: ${id}`);
        }

        const rowIndex = (currentData as any).__row;
        const finalData = this.applyUpdateQuery(currentData, updateQuery);

        const result = await this.gateway.updateRow(rowIndex, finalData);
        await this.gettersEngine.clearCache();
        return result;
    }

    /**
     * EL MOTOR DE TRANSFORMACIÓN:
     * Procesa $set, $inc, $push y data plana.
     */
    // --- MÉTODOS PRIVADOS AUXILIARES ---

    private applyUpdateQuery(current: T, query: UpdateQuery<T>): T {
        let updated = { ...current } as any;
        const { $set, $inc, $push, ...plainData } = query as any;

        Object.assign(updated, plainData);
        if ($set) Object.assign(updated, $set);

        if ($inc) {
            for (const key in $inc) {
                if (typeof $inc[key] === 'number') {
                    updated[key] = (Number(updated[key]) || 0) + $inc[key];
                }
            }
        }

        if ($push) {
            for (const key in $push) {
                let arr = Array.isArray(updated[key]) ? updated[key] : [];
                arr.push($push[key]);
                updated[key] = arr;
            }
        }
        return updated as T;
    }




    /**
 * Actualiza parcialmente una entidad usando su índice de fila interno.
 */
    async updateEntity(entity: T, changes: T): Promise<void> {
        const rowIndex = (entity as any).__row;
        if (rowIndex === undefined) {
            throw new Error("No se puede actualizar una entidad sin índice de fila (__row).");
        }
        await this.updatePartialBatch(rowIndex, changes);
        Object.assign(entity, changes);
    }


    /**
     * BATCH UPDATE: Modifica celdas dispersas de forma masiva reduciendo el consumo de cuota de Google API.
     */
    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;

        const data = updates.map(u => ({
            range: u.range,
            values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
        }));

        try {
            await withRetry(async () => {
                return await this.gateway.updateCellsBatch(data);
            }, 3, 1500);

            await this.gettersEngine.clearCache();
        } catch (error) {
            throw new InternalServerErrorException('Error de red persistente al sincronizar celdas con Google API.');
        }
    }



    /**
     * FIND ONE AND UPDATE: Busca, aplica lógica/agregaciones y actualiza en un solo ciclo atómico.
     */
    async findOneAndUpdate(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any[],
        options: { projection?: any, upsert?: boolean, new?: boolean } = { new: true, upsert: false }
    ): Promise<Partial<T> | null> {
        let entity: T | null = await this.gettersEngine.findOneInternal(filter, this.compareEngine);

        if (!entity) {
            if (options.upsert) {
                const newInstance = new (this.entityClass as any)();
                Object.assign(newInstance, this.extractLiteralFields(filter));
                entity = newInstance as T;
            } else {
                return null;
            }
        }

        let finalPayload: T;

        if (Array.isArray(updateData)) {
            const result = await this.aggregationEngine.run([entity], updateData);
            finalPayload = result[0] as T;
        } else {
            const update = updateData as UpdateQuery<T>;

            // Interceptamos operadores relacionales si intentan hacer $push directo en relaciones 1:N
            if (update.$push) {
                await this.processRelationalPushes(entity, update.$push);
            }
            finalPayload = this.applyUpdateQuery(entity, update);
        }

        const physicalRow = (entity as any).__row;
        if (physicalRow) {
            await this.gateway.updateRow(physicalRow, finalPayload);
        } else {
            const created = await this.create(finalPayload);
            (entity as any).__row = (created as any).__row;
        }

        await this.gettersEngine.clearCache();
        const resultState = options.new ? finalPayload : entity;

        return options.projection
            ? this.gettersEngine.applyProjection(resultState, options.projection)
            : resultState as Partial<T>;
    }



    private async processRelationalPushes(entity: T, $push: Record<string, any>): Promise<void> {
        const parentId = (entity as any)[this.primaryKeyProp];
        const targetProto = this.entityClass.prototype;

        for (const propertyKey in $push) {
            const relationMeta: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetProto, propertyKey);

            if (relationMeta && relationMeta.isMany) {
                const childRepo = this.moduleRef.get(relationMeta.targetRepository, { strict: false });
                if (!childRepo) continue;

                const children = Array.isArray($push[propertyKey]) ? $push[propertyKey] : [$push[propertyKey]];

                await Promise.all(children.map(async (childData) => {
                    childData[relationMeta.joinColumn] = parentId;
                    return await childRepo.save(childData);
                }));

                delete $push[propertyKey]; // Evitamos que caiga a la celda física de la hoja padre
            }
        }
    }


    /**
     * Procesa la entidad analizando el mapa maestro de columnas para aplicar
     * estrategias de autogeneración de IDs basándose en las utilidades reales del ODM.
     */
    private async applyAutogeneratedFields(entity: any): Promise<void> {
        if (!entity) return;

        const targetClass = entity.constructor;
        const isPlainObject = entity.constructor && entity.constructor.name === 'Object';
        const targetProto = isPlainObject ? this.entityClass : targetClass;

        // 1. Recuperamos el mapa maestro de configuración de columnas configuradas por el decorador
        const currentColumnDetails: Record<string, ColumnOptions> = this.columnDetails ||
            Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) ||
            {};

        // 2. Barremos las columnas buscando aquellas marcadas con generación automática
        for (const key of Object.keys(currentColumnDetails)) {
            const config = currentColumnDetails[key];
            if (!config) continue;

            const hasGenerationActive = config.generated || config.isAutoIncrement;
            if (!hasGenerationActive) continue;

            // Leemos el valor actual en el payload
            const currentValue = entity[key];

            // Solo actuamos si el campo está vacío, nulo o indefinido
            if (currentValue === undefined || currentValue === null || currentValue === '') {
                let generatedValue: string | number;

                // 3. Selección y ejecución de la estrategia acoplada a tus clases reales
                if (config.generated === 'uuid') {
                    generatedValue = IdGenerator.generate(); // ✅ Corregido: Sin argumentos según tu id.generator.ts
                } else if (config.generated === 'short-id') {
                    generatedValue = IdGenerator.generateShort(); // ✅ Corregido: Llama a tu método real generateShort()
                } else if (config.isAutoIncrement || config.generated === 'increment') {
                    // Estrategia incremental leyendo la hoja de cálculo de Google Sheets
                    try {
                        // Pasamos el contexto asíncrono seguro usando el método de lectura de tu Gateway
                        const currentRows = await this.gettersEngine.getOrFetchSheet() as any;
                        const rowsArray = Array.isArray(currentRows?.data) ? currentRows.data : [];

                        let maxId = 0;
                        const physicalColName = config.name || key;

                        rowsArray.forEach((row: any) => {
                            const val = parseInt(row[physicalColName] || row[key], 10);
                            if (!isNaN(val) && val > maxId) maxId = val;
                        });

                        generatedValue = maxId + 1;
                    } catch (e) {
                        // Fallback de seguridad si la hoja está recién creada o vacía
                        generatedValue = 1;
                    }
                } else {
                    // Fallback general por defecto
                    generatedValue = IdGenerator.generate();
                }

                // 4. Sincronización bidireccional (TypeScript + Google Sheets)
                entity[key] = generatedValue;

                const physicalColumnName = config.name || key;
                entity[physicalColumnName] = generatedValue;

                this.logger.debug(
                    `[ODM Autogen] Campo [${key}] inicializado con éxito -> Clave Física [${physicalColumnName}]: ${generatedValue}`
                );
            }
        }
    }

    /**
     * Extrae campos literales/planos de un FilterQuery para inicializar instancias en operaciones de Upsert.
     * Ignora operadores NoSQL ($in, $gte, etc.) para evitar mutaciones corruptas en el mapeo de celdas.
     */
    /**
     * Extrae campos literales/planos de un FilterQuery para inicializar instancias en operaciones de Upsert.
     * Ignora operadores NoSQL ($in, $gte, etc.) para evitar mutaciones corruptas en el mapeo de celdas.
     */
    private extractLiteralFields(filter: FilterQuery<T>): Partial<T> {
        // 1. Declaramos el objeto directamente como Partial<T>
        const literals: Partial<T> = {};

        if (!filter || typeof filter !== 'object') return literals;

        for (const [key, value] of Object.entries(filter)) {
            // Un valor es almacenable directamente si no es un objeto relacional/NoSQL,
            // o si es una instancia nativa controlada como Date o RegExp.
            if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof RegExp) {
                // 2. Usamos una aserción de propiedad segura para evitar que TS bloquee la asignación dinámica
                (literals as any)[key] = value;
            }
        }

        return literals;
    }

    /**
     * Transforma un índice numérico de matriz (base 0) a su coordenada alfabética A1 de Google Sheets.
     * Ejemplo: 0 -> A, 25 -> Z, 26 -> AA, 702 -> AAA.
     */
    private indexToColumnLetter(index: number): string {
        if (index < 0) return '';

        let temp = index;
        let letter = '';

        while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
        }

        return letter;
    }

    /**
     * Verifica la existencia real de un registro físico en la hoja basándose en su Primary Key.
     */
    async exists(id: string | number): Promise<boolean> {
        if (id === undefined || id === null || id === '') return false;

        const filter = { [this.primaryKeyProp]: id } as any;
        const record = await this.gettersEngine.findOneInternal(filter, this.compareEngine);
        return !!record;
    }
    private sanitizeEntityBeforeStorage(entity: any): void {
        if (!entity) return;

        // Si es un objeto plano del payload, usamos la clase base registrada en la fábrica
        const isPlainObject = entity.constructor && entity.constructor.name === 'Object';
        const targetClass = isPlainObject ? this.entityClass : entity.constructor;
        const targetProto = targetClass?.prototype || Object.getPrototypeOf(entity);

        const currentDeleteControlProp = this.deleteControlProp ||
            (targetProto ? Reflect.getMetadata(SHEETS_DELETE_CONTROL, targetProto) : null) ||
            null;

        if (currentDeleteControlProp) {
            const currentValue = entity[currentDeleteControlProp];

            if (currentValue === undefined || currentValue === null) {
                // Saneamiento de la propiedad lógica de TypeScript (ej: deletedAt)
                entity[currentDeleteControlProp] = false;

                // Saneamiento de la columna física real de Google Sheets (ej: ESTADO_ELIMINADO)
                const currentColumnDetails = this.columnDetails ||
                    (targetProto ? Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) : null) || {};

                const config = currentColumnDetails[currentDeleteControlProp];
                const physicalColumnName = config?.name || String(currentDeleteControlProp);

                entity[physicalColumnName] = false;

                this.logger.debug(
                    `[ODM Saneamiento] Control de borrado inyectado: { ${String(currentDeleteControlProp)}: false, ${physicalColumnName}: false }`
                );
            }
        }
    }

    private extractStorageLiterals(entity: T): Partial<T> {
        const literals: Partial<T> = {};
        const currentColumnDetails = this.columnDetails || {};

        for (const [key, value] of Object.entries(entity)) {
            if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof RegExp) {
                (literals as any)[key] = value;
            }
        }

        return literals;
    }

}

