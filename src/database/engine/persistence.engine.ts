// persistence.manager.ts
import { Logger, Inject, InternalServerErrorException, ServiceUnavailableException, ConflictException, BadRequestException } from '@nestjs/common';
import { SheetsDataGateway } from '../services/sheetDataGateway/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ClassType, FilterQuery, UpdateQuery } from '@database/types/query.types';

import { GettersEngine } from './getters.engine';
import { ColumnOptions } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { ModuleRef } from '@nestjs/core';
import { AggregationEngine } from '@database/engines/aggregation.engine';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { CompareEngine } from '@database/engines/compare.engine';
import { IdGenerator } from '@database/utils/id.generator';
import { withRetry } from '@database/utils/tools';
import { RelationalEngine } from '@database/engines/relational.engine';

import {
    SHEETS_ALL_RELATIONS,
    SHEETS_COLUMN_DETAILS,
    SHEETS_DELETE_CONTROL,
    SHEETS_PRIMARY_KEY,
    SHEETS_RELATIONS_LIST,
    SHEETS_TABLE_NAME
} from '@database/constants/metadata.constants';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '@database/decorators/relation.sub.collections.decorator';

export class PersistenceEngine<T extends object> implements IPersistenceEngine<T> {

    private readonly logger = new Logger(PersistenceEngine.name);
    private resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private readonly deleteControlProp: string | null;

    constructor(
        private readonly entityClass: ClassType<T> | (new () => T),
        private readonly gateway: SheetsDataGateway<T>,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef,
        private readonly aggregationEngine: AggregationEngine<T>,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly compareEngine: CompareEngine,
        private readonly relationalEngine: RelationalEngine,) {
        // 🟢 Inicialización sana de propiedades usando metadatos y acoplamiento al gateway
        const constructor = this.entityClass;
        const prototype = this.entityClass.prototype;

        this.resolvedSheetName = this.gateway.sheetName;
        this.primaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, constructor) || 'id';
        this.columnDetails = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, prototype) || {};
        this.deleteControlProp = Reflect.getMetadata(SHEETS_DELETE_CONTROL, constructor) || null;
    }
    /**
     * Resuelve y ejecuta las políticas de integridad referencial (RESTRICT, SET_NULL, CASCADE)
     * antes de confirmar la eliminación o alteración física de un registro padre.
     * * @param parentEntityClass La clase de la entidad que se intenta eliminar (ej: ObreroEntity)
     * @param parentId El valor de la clave primaria (ID, DNI, etc.) del registro afectado
     */
    /**
     * Resuelve y ejecuta las políticas de integridad referencial (RESTRICT, SET_NULL, CASCADE)
     * utilizando exclusivamente búsquedas y mutaciones unitarias compatibles con el motor actual.
     */
    private async resolveReferentialIntegrity(parentEntityClass: any, parentId: any): Promise<void> {
        const parentEntityName = parentEntityClass.name;

        // 1. Extraer las dependencias indexadas dinámicamente por los decoradores relacionales
        const dependencies = GLOBAL_RELATION_REGISTRY.get(parentEntityName) || [];
        if (dependencies.length === 0) return;

        this.logger.debug(
            `[Integridad] Evaluando ${dependencies.length} dependencias para la entidad [${parentEntityName}] con ID: ${parentId}`
        );

        for (const dep of dependencies) {
            let repositoryToken = dep.childRepository;

            if (!repositoryToken) {
                // Convertimos el nombre de la hoja (ej: "ASISTENCIAS_DIARIAS") a PascalCase ("AsistenciasDiarias")
                const camelCase = dep.childSheet.toLowerCase().replace(/_([a-z])/g, (_, g) => g.toUpperCase());
                const pascalCase = camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
                repositoryToken = `${pascalCase}Repository`;
            }

            let childRepository: any;
            try {
                childRepository = this.moduleRef.get(repositoryToken, { strict: false });
            } catch (error) {
                this.logger.error(`[Integridad] No se pudo resolver el token "${String(repositoryToken)}" en NestJS.`);
                throw new InternalServerErrorException(
                    `Error de infraestructura: El repositorio '${String(repositoryToken)}' requerido por [${parentEntityName}] no está disponible.`
                );
            }

            const strategy = dep.onDelete || 'RESTRICT';

            // 🔍 ESTRATEGIA SEGURA: En lugar de usar .count(), usamos .find() que está 100% operativo en tu ODM.
            // Esto nos da los registros en memoria para inspeccionar o mutar individualmente.
            let childRecords: any[] = [];
            if (typeof childRepository.find === 'function') {
                childRecords = await childRepository.find({ [dep.joinColumn]: parentId }) || [];
            }

            const dependentCount = childRecords.length;

            switch (strategy) {

                case 'RESTRICT': {
                    if (dependentCount > 0) {
                        this.logger.warn(
                            `[RESTRICT DENIED] Eliminación abortada en [${parentEntityName}]. ` +
                            `Existen ${dependentCount} filas asociadas en la pestaña "${dep.childSheet}".`
                        );

                        throw new BadRequestException(
                            `Restricción de Integridad: No se puede eliminar el registro con ID '${parentId}' en [${parentEntityName.toUpperCase()}] ` +
                            `porque tiene ${dependentCount} registros vinculados en la hoja [${dep.childSheet}]. ` +
                            `Por favor, remueva o reasigne primero esas filas.`
                        );
                    }
                    break;
                }

                case 'SET_NULL': {
                    if (dependentCount === 0) break;

                    this.logger.log(
                        `[SET_NULL] Rompiendo enlaces en la pestaña "${dep.childSheet}" (Columna: "${dep.joinColumn}") para ${dependentCount} registros.`
                    );

                    for (const childRecord of childRecords) {
                        const childTargetClass = childRecord.constructor;
                        const childPkField = Reflect.getMetadata(SHEETS_PRIMARY_KEY, childTargetClass) || 'id';
                        const childId = childRecord[childPkField];

                        // Mapeamos al formato UpdateQuery soportado por tu ManipulateEngine ($set)
                        const filter = { [childPkField]: childId };
                        const updatePayload = { $set: { [dep.joinColumn]: null } };

                        if (typeof childRepository.updateOne === 'function') {
                            await childRepository.updateOne(filter, updatePayload);
                        } else if (typeof childRepository.update === 'function') {
                            await childRepository.update(filter, updatePayload);
                        }
                    }
                    break;
                }

                case 'CASCADE': {
                    if (dependentCount === 0) break;

                    this.logger.warn(
                        `[CASCADE] Eliminando en ráfaga secuencial ${dependentCount} registros de la hoja "${dep.childSheet}" asociados al padre ID: ${parentId}`
                    );

                    for (const childRecord of childRecords) {
                        const childTargetClass = childRecord.constructor;
                        const childPkField = Reflect.getMetadata(SHEETS_PRIMARY_KEY, childTargetClass) || 'id';
                        const childId = childRecord[childPkField];

                        // 🔥 VENTAJA ARQUITECTÓNICA CRÍTICA:
                        // Al ejecutar secuencialmente el método .deleteOne() que ya programaste,
                        // la eliminación de este hijo disparará automáticamente su PROPIO 'resolveReferentialIntegrity'.
                        // Esto significa que si tienes dependencias multinivel (Abuelo -> Padre -> Hijo), 
                        // la cascada se ejecutará de forma recursiva y profunda en todo tu ecosistema de Google Sheets sin romper nada.
                        if (typeof childRepository.deleteOne === 'function') {
                            await childRepository.deleteOne({ [childPkField]: childId });
                        } else if (typeof childRepository.delete === 'function') {
                            await childRepository.delete({ [childPkField]: childId });
                        }
                    }
                    break;
                }

                default:
                    throw new InternalServerErrorException(
                        `La estrategia onDelete: '${strategy}' no está soportada por el PersistenceEngine.`
                    );
            }
        }
    }

    public async deleteOne(filter: FilterQuery<T>): Promise<boolean> {
        // 1. Buscamos primero el registro en caliente para saber qué ID tiene antes de borrarlo
        const currentRecord = await this.gettersEngine.findOne(filter);
        if (!currentRecord) return false;

        // 2. Extraer la propiedad PrimaryKey configurada mediante metadata
        // Nota: Si no usas "this.entityClass", puedes obtenerla de "currentRecord.constructor"
        const targetClass = this.entityClass || currentRecord.constructor;
        const pkField = Reflect.getMetadata(SHEETS_PRIMARY_KEY, targetClass) || 'id';
        const parentId = currentRecord[pkField];

        // 🚀 EL ESCUDO: Si se viola un 'RESTRICT', saltará la excepción aquí y frenará el flujo de inmediato
        await this.resolveReferentialIntegrity(targetClass, parentId);

        // 3. Tu lógica de borrado físico/lógico existente continúa aquí de forma segura...
        // return await withRetry(() => this.sheetDataGateway.deleteRow(...));
    }


    /**
     * 🌟 CORE DEL REFATOR: Transforma un payload de red en el formato físico exacto que espera Google Sheets,
     * autocompletando columnas faltantes (como estadoEliminado: false) de manera inteligente.
     */
    private buildPhysicalPayload(data: any, entityClass: any): Record<string, any> {
        const targetProto = entityClass.prototype || entityClass;
        const currentColumnDetails = Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) || this.columnDetails || {};
        const physicalPayload: Record<string, any> = {};

        Object.keys(currentColumnDetails).forEach(logicalKey => {
            const config = currentColumnDetails[logicalKey];
            const physicalName = config?.name || logicalKey;

            // Busca el valor en todas las variantes posibles (camelCase, MAYÚSCULAS)
            let value = data[logicalKey] ?? data[physicalName] ?? data[logicalKey.toLowerCase()] ?? data[physicalName.toLowerCase()];

            // 💡 REGLA MAGICA: Si no nos enviaron el dato en el JSON, aplicamos valores por defecto
            if (value === undefined || value === null) {
                if (config.default !== undefined && config.default !== null) {
                    value = config.default;
                } else if (config.isDeleteControl) {
                    value = false; // Inyección nativa de 'estadoEliminado = false'
                }
            }

            // Consolidamos bajo el nombre físico esperado por Google (ej: ESTADO_ELIMINADO)
            if (value !== undefined && value !== null) {
                physicalPayload[physicalName] = value;
            }
        });

        // Fallback de emergencia si la metadata está vacía
        if (Object.keys(physicalPayload).length === 0 && data) {
            Object.keys(data).forEach(key => {
                if (typeof data[key] !== 'object' && typeof data[key] !== 'function') {
                    physicalPayload[key.toUpperCase()] = data[key];
                }
            });
        }

        return physicalPayload;
    }

    // =========================================================================
    // 1. FLUJO RELACIONAL EN CASCADA
    // =========================================================================
    /**
     * Guarda una entidad y todas sus estructuras relacionales anidadas de forma recursiva.
     * Garantiza la auto-creación del control de borrado lógico (estadoEliminado) en todos los niveles.
     */
    async saveWithRelations<E extends object>(
        EntityClass: ClassType<E>,
        payload: any
    ): Promise<E> {
        this.logger.log(`[ODM Cascading] Iniciando ciclo de persistencia compuesta para: ${EntityClass.name}`);

        if (!payload || typeof payload !== 'object') {
            throw new ConflictException('El payload de la entidad compuesta no es válido.');
        }

        try {
            const targetPrototype = EntityClass.prototype;

            // -----------------------------------------------------------------------------------
            // RESOLUCIÓN DEL OBJETIVO 1: Segregación estricta de Estructuras Anidadas
            // -----------------------------------------------------------------------------------
            const plainParentData = { ...payload };
            const relationsData: Record<string, { options: RelationOptions; data: any }> = {};

            // 🔍 LOG CASCADA 1: Inspeccionar el Payload de entrada unificado
            this.logger.debug(`[CASCADA 1. ENTRADA] Payload original recibido en el Motor: ${JSON.stringify(payload)}`);

            // Analizamos las propiedades del payload para aislar las declaradas como relaciones
            for (const key of Object.keys(payload)) {
                const relationOptions: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetPrototype, key);

                if (relationOptions) {
                    // 🔍 LOG CASCADA 2: Relación detectada mediante Metadatos
                    this.logger.debug(
                        `[CASCADA 2. METADATO] Propiedad relacional detectada: '${key}'. ` +
                        `TargetEntity: ${relationOptions.targetEntity ? relationOptions.targetEntity()?.name : 'Indefinido'}. ` +
                        `joinColumn (FK): '${relationOptions.joinColumn}'`
                    );

                    // Extraemos los datos relacionales para procesarlos de forma aislada
                    relationsData[key] = {
                        options: relationOptions,
                        data: payload[key]
                    };
                    // Eliminamos la propiedad compleja del padre para no corromper al SheetMapper
                    delete plainParentData[key];
                }
            }

            // -----------------------------------------------------------------------------------
            // PROCESAMIENTO NATIVO DEL PADRE: Garantizar Identidad Única
            // -----------------------------------------------------------------------------------
            const primaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, EntityClass) || 'id';
            let parentId = plainParentData[primaryKeyProp];

            // Si la entidad padre carece de identificador (ej: Nuevo Registro), se autogenera de inmediato
            if (parentId === undefined || parentId === null || String(parentId).trim() === '') {
                parentId = IdGenerator.generate();
                plainParentData[primaryKeyProp] = parentId;
                this.logger.debug(`[ODM Identidad] Clave primaria autogenerada para el Padre [${primaryKeyProp}]: ${parentId}`);
            }

            // Instanciamos el objeto plano limpio y saneamos su control de borrado lógico
            const parentInstance = new EntityClass();
            Object.assign(parentInstance, plainParentData);

            // Saneamos el padre de forma directa
            this.sanitizeDeleteControl(parentInstance, targetPrototype);

            // Persistencia física de la fila limpia mediante el core estándar del ODM
            this.logger.debug(`[ODM Persistencia] Escribiendo fila del registro padre en la pestaña correspondiente...`);
            const savedParentResult = await this.save(parentInstance as any);

            // Extraemos el ID final confirmado por el motor tras la escritura
            const finalParentId = (savedParentResult as any)[primaryKeyProp];

            // 🔍 LOG CASCADA 3: Confirmación de guardado del Padre exitosa
            this.logger.debug(
                `[CASCADA 3. PADRE GUARDADO] Registro Padre persistido. ` +
                `Clave Primaria (${primaryKeyProp}) = '${finalParentId}'. ` +
                `Objeto devuelto por base.save: ${JSON.stringify(savedParentResult)}`
            );

            // -----------------------------------------------------------------------------------
            // RESOLUCIÓN DEL OBJETIVO 2: Propagación Dinámica y Guardado en Cascada (Hijos)
            // -----------------------------------------------------------------------------------
            for (const [propertyKey, relationContainer] of Object.entries(relationsData)) {
                const { options, data: childrenData } = relationContainer;

                if (!childrenData) {
                    this.logger.warn(`[CASCADA WARNING] No se encontraron datos para la propiedad relacional: "${propertyKey}"`);
                    continue;
                }

                const TargetEntityClass = options.targetEntity();

                // Construimos los tokens probables basados en el comportamiento real de tu DatabaseModule
                const exactFeatureToken = `${TargetEntityClass.name}Repository`;
                const inferredDecoratorToken = options.targetRepository || options.childRepository;

                // 🔍 LOG CASCADA 4: Intentando resolver el Repositorio desde el contenedor IoC de NestJS
                this.logger.debug(
                    `[CASCADA 4. RESOLVIENDO REPOSITORIO] Buscando repositorio para '${propertyKey}'.\n` +
                    `   -> Intentando Token Oficial forFeature: "${exactFeatureToken}"\n` +
                    `   -> Intentando Token Inferido Decorador: "${inferredDecoratorToken}"\n` +
                    `   -> Intentando Token de Clase Directo: [${TargetEntityClass.name}]`
                );

                let resolvedTokenInstance: any = null;

                // 1. Intentar con el token exacto que genera tu forFeature
                try {
                    resolvedTokenInstance = this.moduleRef.get(exactFeatureToken, { strict: false });
                } catch (e) { }

                // 2. Intentar con el token string deducido por el decorador
                if (!resolvedTokenInstance && inferredDecoratorToken) {
                    try {
                        resolvedTokenInstance = this.moduleRef.get(inferredDecoratorToken, { strict: false });
                    } catch (e) { }
                }

                // 3. Intentar utilizando la Clase de la Entidad como última instancia
                if (!resolvedTokenInstance) {
                    try {
                        resolvedTokenInstance = this.moduleRef.get(TargetEntityClass, { strict: false });
                    } catch (e) { }
                }

                if (!resolvedTokenInstance) {
                    throw new InternalServerErrorException(
                        `El motor de cascada no pudo localizar el repositorio para la entidad "${TargetEntityClass.name}". ` +
                        `Verifica que [${TargetEntityClass.name}] esté declarado en el DatabaseModule.forFeature().`
                    );
                }

                const joinColumnField = options.joinColumn;
                const isMany = Array.isArray(childrenData);
                const recordsToSave = isMany ? childrenData : [childrenData];
                const savedChildrenResults: any[] = [];

                // 🔍 Identificamos la Primary Key de la Entidad Hija dinámicamente
                const childPrimaryKeyProp = Reflect.getMetadata(SHEETS_PRIMARY_KEY, TargetEntityClass) || 'id';

                this.logger.debug(
                    `[ODM Relación] Propagando cascada hacia la propiedad "${propertyKey}". Procesando ${recordsToSave.length} elemento(s).`
                );

                let index = 0;
                for (const childPayload of recordsToSave) {
                    if (!childPayload || typeof childPayload !== 'object') continue;

                    // 1. AUTOGENERACIÓN DEL ID DEL HIJO si viene vacío
                    let childId = childPayload[childPrimaryKeyProp];
                    if (childId === undefined || childId === null || String(childId).trim() === '') {
                        childId = IdGenerator.generate();
                        childPayload[childPrimaryKeyProp] = childId;
                        this.logger.debug(`[CASCADA AUTO-ID] Clave primaria autogenerada para el Hijo [${childPrimaryKeyProp}]: ${childId}`);
                    }

                    // 2. INYECCIÓN RELACIONAL AUTOMÁTICA DE LLAVE FORÁNEA (FK)
                    childPayload[joinColumnField] = finalParentId;

                    // 3. INSTANCIACIÓN GENUINA DEL HIJO (Conserva Prototipo y Decoradores)
                    const childInstance = new TargetEntityClass();
                    Object.assign(childInstance, childPayload);

                    // 4. SANEAMIENTO AUTOMÁTICO DE CONTROL DE BORRADO (Usando la lógica centralizada corregida)
                    this.sanitizeDeleteControl(childInstance, TargetEntityClass.prototype);

                    // 🔍 LOG CASCADA 5: Monitorear Inyección de Llave Foránea (FK)
                    this.logger.debug(
                        `[CASCADA 5. INYECCIÓN FK] Hijo [${index}]. ` +
                        `Asignando FK '${joinColumnField}' = '${finalParentId}'. ` +
                        `Payload listo para persistir: ${JSON.stringify(childPayload)}`
                    );

                    // 5. EXTRACCIÓN ROBUSTA DEL MOTOR DE PERSISTENCIA DESTINO
                    let processedChild: any;
                    let estrategiaUtilizada = '';
                    let targetPersistenceEngine: any = null;

                    if (resolvedTokenInstance.ctx?.persistenceEngine) {
                        targetPersistenceEngine = resolvedTokenInstance.ctx.persistenceEngine;
                        estrategiaUtilizada = 'resolvedTokenInstance.ctx.persistenceEngine [SheetsRepository]';
                    } else if (resolvedTokenInstance.persistenceEngine) {
                        targetPersistenceEngine = resolvedTokenInstance.persistenceEngine;
                        estrategiaUtilizada = 'resolvedTokenInstance.persistenceEngine [RepositoryContext]';
                    } else if (resolvedTokenInstance._repo?.ctx?.persistenceEngine) {
                        targetPersistenceEngine = resolvedTokenInstance._repo.ctx.persistenceEngine;
                        estrategiaUtilizada = 'resolvedTokenInstance._repo.ctx.persistenceEngine [Model Proxy Context]';
                    }

                    // 6. EJECUCIÓN FÍSICA DEL GUARDADO DEL HIJO
                    if (targetPersistenceEngine && typeof targetPersistenceEngine.save === 'function') {
                        processedChild = await targetPersistenceEngine.save(childInstance);
                    } else if (typeof resolvedTokenInstance.save === 'function') {
                        estrategiaUtilizada = 'resolvedTokenInstance.save() [Direct Fallback]';
                        processedChild = await resolvedTokenInstance.save(childInstance);
                    } else {
                        throw new InternalServerErrorException(
                            `El recurso encontrado para el hijo no expone un canal de persistencia física (.save)`
                        );
                    }

                    // 🔍 LOG CASCADA 6: Resultado de la persistencia del Hijo
                    this.logger.debug(
                        `[CASCADA 6. HIJO GUARDADO] Hijo [${index}] persistido exitosamente usando [${estrategiaUtilizada}]. ` +
                        `Resultado final indexado: ${JSON.stringify(processedChild)}`
                    );

                    savedChildrenResults.push(processedChild);
                    index++;
                }

                // Acoplamos las estructuras hijas salvadas en la respuesta del Padre
                (savedParentResult as any)[propertyKey] = isMany ? savedChildrenResults : savedChildrenResults[0];
            }
            return savedParentResult as unknown as E;

        } catch (error) {
            this.logger.error(`❌ Error crítico detectado en la persistencia por cascada relacional: ${error.message}`, error.stack);
            throw error;
        }
    }


    // =========================================================================
    // 2. MÉTODOS DE ESCRITURA Y MUTACIÓN ESTÁNDAR
    // =========================================================================

    /**
     * INSERCIÓN ATÓMICA REFACTORIZADA
     */
    async create(entity: T): Promise<T> {
        const sheetInfo = await this.gettersEngine.getOrFetchSheet();
        if (sheetInfo.isEmergency) throw new ServiceUnavailableException('Escritura denegada en modo emergencia.');

        // 1. Generar campos autogenerados de forma lógica (ej: UUIDs)
        await this.applyAutogeneratedFields(entity);

        // 2. 🟢 REGLA ARQUITECTÓNICA NUEVA: Saneamiento lógico de valores por defecto
        // En lugar de mutar a nombres físicos antes de tiempo, completamos la entidad en su capa de abstracción de TypeScript.
        const currentColumnDetails = this.columnDetails;
        Object.keys(currentColumnDetails).forEach(logicalKey => {
            const config = currentColumnDetails[logicalKey];
            if (entity[logicalKey as keyof T] === undefined || entity[logicalKey as keyof T] === null) {
                if (config.default !== undefined && config.default !== null) {
                    (entity as any)[logicalKey] = config.default;
                } else if (config.isDeleteControl) {
                    (entity as any)[logicalKey] = false; // Forzar estadoEliminado: false de forma lógica
                }
            }
        });

        try {
            this.logger.debug(`[Create] Enviando entidad lógica al Gateway: ${JSON.stringify(entity)}`);

            // 3. Pasamos la entidad lógica. 'appendRow' y su 'SheetMapper' se encargarán del orden posicional exacto.
            const response = await this.gateway.appendRow(entity as any);
            const physicalRow = response ? (response as any).__row : null;

            if (physicalRow) {
                (entity as any).__row = physicalRow;
            }

            await this.gettersEngine.clearCache();
            return entity;
        } catch (error: any) {
            this.logger.error(`Fallo crítico en Create: ${error.message}`);
            throw new InternalServerErrorException(`Fallo al insertar registro.`);
        }
    }
    async save(entity: T): Promise<T> {
        const targetProto = Object.getPrototypeOf(entity);
        const className = entity?.constructor?.name || 'UnknownEntity';

        // 🔍 LOG SAVE 1: Entrada nativa al motor físico de Sheets
        this.logger.debug(
            `[SAVE 1. ENTRADA] Clase: ${className} | ` +
            `Payload recibido pre-saneamiento: ${JSON.stringify(entity)}`
        );

        // 1. Sanitizar el control de borrado (asigna false a la propiedad lógica si viene vacía)
        this.sanitizeDeleteControl(entity, targetProto);

        // 🔍 LOG SAVE 2: Inspección post-saneamiento
        this.logger.debug(
            `[SAVE 2. POST-SANEAMIENTO] Clase: ${className} | ` +
            `Payload listo para transferir: ${JSON.stringify(entity)}`
        );

        // 2. Enviamos la entidad cruda. El Gateway se encargará de extraer solo las propiedades 
        // oficiales de @Column y alinearlas en el array posicional correcto.
        this.logger.debug(`[SAVE 3. TRANSMISIÓN] Despachando fila hacia this.gateway.appendRow()...`);
        const response = await this.gateway.appendRow(entity);

        // 🔍 LOG SAVE 4: Respuesta cruda del Gateway de Google Sheets
        this.logger.debug(
            `[SAVE 4. RESPUESTA GATEWAY] Clase: ${className} | ` +
            `Respuesta del appendRow: ${JSON.stringify(response)}`
        );

        // 3. Recuperamos el identificador de fila asignado por Google Sheets (si aplica)
        const physicalRow = response ? (response as any).__row : null;
        if (physicalRow) {
            (entity as any).__row = physicalRow;
            this.logger.debug(`[SAVE 5. METADATO ROW] Vinculada fila física de Google Sheets (__row): ${physicalRow}`);
        }

        // 🔍 LOG SAVE 6: Objeto final retornado
        this.logger.debug(`[SAVE 6. RETORNO FINAL] Instancia devuelta por .save(): ${JSON.stringify(entity)}`);

        return entity;
    }
    async updatePartialBatch(physicalRow: number, entity: any): Promise<void> {
        const sheetResponse = await this.gettersEngine.getOrFetchSheet();
        if (sheetResponse.isEmergency) throw new ServiceUnavailableException('Modificación denegada.');

        const currentColumnDetails = this.columnDetails || {};
        const updatePayload: Record<string, any> = {};

        Object.keys(entity).forEach(key => {
            const config = currentColumnDetails[key];
            const physicalColumnName = config?.name || key;
            updatePayload[physicalColumnName] = entity[key];
        });

        if (Object.keys(updatePayload).length === 0) return;

        try {
            await this.gateway.updateRow(physicalRow, updatePayload);
            await this.gettersEngine.clearCache();
        } catch (error) {
            throw new InternalServerErrorException(`No se pudo actualizar el registro.`);
        }
    }

    async update(id: string | number, updateQuery: UpdateQuery<T>): Promise<T> {
        const currentData = await this.gettersEngine.findOneInternal({ [this.primaryKeyProp]: id } as any, this.compareEngine);
        if (!currentData || !(currentData as any).__row) {
            throw new Error(`No se encontró registro para el ID: ${id}`);
        }

        const rowIndex = (currentData as any).__row;
        const finalData = this.applyUpdateQuery(currentData, updateQuery);

        const physicalPayload = this.buildPhysicalPayload(finalData, this.entityClass);

        const result = await this.gateway.updateRow(rowIndex, physicalPayload as any);
        await this.gettersEngine.clearCache();
        return result;
    }

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
            } else return null;
        }

        let finalPayload: T;

        if (Array.isArray(updateData)) {
            const result = await this.aggregationEngine.run([entity], updateData);
            finalPayload = result[0] as T;
        } else {
            const update = updateData as UpdateQuery<T>;
            if (update.$push) {
                await this.processRelationalPushes(entity, update.$push);
            }
            finalPayload = this.applyUpdateQuery(entity, update);
        }

        const physicalRow = (entity as any).__row;
        if (physicalRow) {
            const physicalPayload = this.buildPhysicalPayload(finalPayload, this.entityClass);
            await this.gateway.updateRow(physicalRow, physicalPayload as any);
        } else {
            const created = await this.create(finalPayload);
            (entity as any).__row = (created as any).__row;
        }

        await this.gettersEngine.clearCache();
        const resultState = options.new ? finalPayload : entity;
        return options.projection ? this.gettersEngine.applyProjection(resultState, options.projection) : resultState as Partial<T>;
    }

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

        if (!physicalRow || physicalRow === -1) return;

        if (this.deleteControlProp) {
            await this.relationalEngine.handleOnDelete(this.entityClass.name, id);
            await this.updateLogicalStatus(physicalRow, 'INACTIVO');
        } else {
            await this.relationalEngine.handleOnDelete(this.entityClass.name, id);
            await this.gateway.clearRow(physicalRow);
        }
        await this.gettersEngine.clearCache();
    }

    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;
        const data = updates.map(u => ({
            range: u.range,
            values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
        }));
        try {
            await withRetry(async () => await this.gateway.updateCellsBatch(data), 3, 1500);
            await this.gettersEngine.clearCache();
        } catch (error) {
            throw new InternalServerErrorException('Error de red persistente con Google API.');
        }
    }

    async updateEntity(entity: T, changes: T): Promise<void> {
        const rowIndex = (entity as any).__row;
        if (rowIndex === undefined) throw new Error("Entidad sin índice físico.");
        await this.updatePartialBatch(rowIndex, changes);
        Object.assign(entity, changes);
    }

    // =========================================================================
    // 3. MÉTODOS DE APOYO Y HERRAMIENTAS
    // =========================================================================

    private async applyAutogeneratedFields(entity: any): Promise<void> {
        if (!entity) return;
        const targetProto = entity.constructor.name === 'Object' ? this.entityClass.prototype : entity.constructor.prototype;
        const currentColumnDetails = this.columnDetails || Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto) || {};

        for (const key of Object.keys(currentColumnDetails)) {
            const config = currentColumnDetails[key];
            if (!config || (!config.generated && !config.isAutoIncrement)) continue;

            if (entity[key] === undefined || entity[key] === null || entity[key] === '') {
                let generatedValue: string | number;

                if (config.generated === 'uuid') {
                    generatedValue = IdGenerator.generate();
                } else if (config.generated === 'short-id') {
                    generatedValue = IdGenerator.generateShort();
                } else if (config.isAutoIncrement || config.generated === 'increment') {
                    try {
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
                        generatedValue = 1;
                    }
                } else {
                    generatedValue = IdGenerator.generate();
                }

                entity[key] = generatedValue;
            }
        }
    }

    private applyUpdateQuery(current: T, query: UpdateQuery<T>): T {
        let updated = { ...current } as any;
        const { $set, $inc, $push, ...plainData } = query as any;
        Object.assign(updated, plainData);
        if ($set) Object.assign(updated, $set);
        if ($inc) {
            for (const key in $inc) {
                if (typeof $inc[key] === 'number') updated[key] = (Number(updated[key]) || 0) + $inc[key];
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

    private async processRelationalPushes(entity: T, $push: Record<string, any>): Promise<void> {
        const parentId = (entity as any)[this.primaryKeyProp];
        for (const propertyKey in $push) {
            const relationMeta: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, this.entityClass.prototype, propertyKey);
            if (relationMeta && relationMeta.isMany) {
                const childRepo = this.moduleRef.get(relationMeta.targetRepository, { strict: false });
                if (!childRepo) continue;
                const children = Array.isArray($push[propertyKey]) ? $push[propertyKey] : [$push[propertyKey]];
                await Promise.all(children.map(async (childData) => {
                    childData[relationMeta.joinColumn] = parentId;
                    return await childRepo.save(childData);
                }));
                delete $push[propertyKey];
            }
        }
    }

    async exists(id: string | number): Promise<boolean> {
        if (!id) return false;
        const record = await this.gettersEngine.findOneInternal({ [this.primaryKeyProp]: id } as any, this.compareEngine);
        return !!record;
    }

    private async updateLogicalStatus(physicalRow: number, status: string): Promise<void> {
        const rawData = await this.gateway.getAllRows(this.resolvedSheetName);
        const headers = rawData[0] || [];
        const colIndex = headers.findIndex(h => h.toString().trim().toLowerCase() === this.deleteControlProp.toLowerCase());

        if (colIndex !== -1) {
            const range = `${this.resolvedSheetName}!${this.indexToColumnLetter(colIndex)}${physicalRow}`;
            await this.updateCellsBatch([{ range, value: status, type: 'string' }]);
        }
    }

    private extractLiteralFields(filter: FilterQuery<T>): Partial<T> {
        const literals: Partial<T> = {};
        if (!filter || typeof filter !== 'object') return literals;
        for (const [key, value] of Object.entries(filter)) {
            if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof RegExp) {
                (literals as any)[key] = value;
            }
        }
        return literals;
    }

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

    private sanitizeEntityBeforeStorage(entity: any): void {
        const physicalPayload = this.buildPhysicalPayload(entity, this.entityClass);
        Object.assign(entity, physicalPayload);
    }


    private extractStorageLiterals(entity: T): Record<string, any> {
        const literals: Record<string, any> = {};
        const targetProto = Object.getPrototypeOf(entity);

        // Recuperamos los metadatos de las columnas que guardó el decorador @Column
        const currentColumnDetails = this.columnDetails ||
            Reflect.getMetadata(SHEETS_COLUMN_DETAILS, targetProto.constructor) || {};

        // Iteramos basándonos en las columnas configuradas oficialmente en la Entidad
        for (const logicalKey of Object.keys(currentColumnDetails)) {
            const config: ColumnOptions = currentColumnDetails[logicalKey];
            const physicalName = config.name || logicalKey; // Usar el name real de @Column

            const value = entity[logicalKey as keyof T];

            // Validamos que el valor sea almacenable en una celda plana (evitando objetos complejos no serializados)
            if (value !== undefined) {
                if (value === null || typeof value !== 'object' || value instanceof Date) {
                    literals[physicalName] = value;
                } else if (config.type === 'json' || config.type === 'array') {
                    // Si soporta serialización automática de datos complejos
                    literals[physicalName] = JSON.stringify(value);
                } else {
                    literals[physicalName] = value;
                }
            }
        }

        return literals;
    }
    /**
     * Sanea la propiedad de control de borrado lógico (ej: estadoEliminado o deletedAt).
     * Si el valor es nulo o indefinido, lo inicializa de forma segura en `false` tanto
     * en la propiedad de TypeScript como en la clave de la columna física de Google Sheets.
     * * @param entity Instancia de la entidad a procesar
     */
    public sanitizeDeleteControl(entity: any, targetProto?: any): void {
        const classConstructor = entity.constructor;
        const protoTarget = targetProto || Object.getPrototypeOf(entity);

        // 1. Buscamos el metadato donde realmente lo guarda tu decorador @Column (classConstructor)
        // y por si acaso en el prototipo.
        let currentDeleteControlProp = this.deleteControlProp ||
            Reflect.getMetadata(SHEETS_DELETE_CONTROL, classConstructor) ||
            Reflect.getMetadata(SHEETS_DELETE_CONTROL, protoTarget);

        // 2. Fallback Heurístico: Si los metadatos fallan, forzamos la lectura del estándar
        if (!currentDeleteControlProp) {
            currentDeleteControlProp = 'estadoEliminado';
        }

        // 3. Saneamiento
        if (currentDeleteControlProp) {
            const currentValue = entity[currentDeleteControlProp];

            if (currentValue === undefined || currentValue === null) {
                // Saneamos ÚNICAMENTE la propiedad lógica de TypeScript (ej: estadoEliminado)
                entity[currentDeleteControlProp] = false;

                this.logger.debug(
                    `[ODM Saneamiento] Control de borrado inyectado en propiedad lógica: { ${String(currentDeleteControlProp)}: false } para la clase ${classConstructor.name}`
                );
            }
        }
    }
}