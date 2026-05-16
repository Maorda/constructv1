// persistence.manager.ts
import { Logger, Inject, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetsDataGateway } from '../services/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { FilterQuery, UpdateQuery } from '@database/types/query.types';
import { GLOBAL_RELATION_REGISTRY, RelationOptions } from '@database/decorators/relation.decorator';
import { GettersEngine } from './getters.engine';
import { ColumnOptions } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { ModuleRef } from '@nestjs/core';
import { AggregationEngine } from '@database/engines/aggregation.engine';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { CompareEngine } from '@database/engines/compare.engine';
import { IdGenerator } from '@database/utils/id.generator';
import { SHEETS_ALL_RELATIONS, SHEETS_DELETE_CONTROL, SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';
import { withRetry } from '@database/utils/tools';
import { RelationalEngine } from '@database/engines/relational.engine';


export class PersistenceEngine<T extends object> implements IPersistenceEngine<T> {

    private readonly logger = new Logger(PersistenceEngine.name);
    private readonly resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private readonly deleteControlProp: string | null;
    private readonly persistableKeys: string[];
    constructor(
        @Inject('ENTITY_CLASS') private readonly entityClass: new () => T,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef, // <--- Para localizar repositorios hijos
        private readonly aggregationEngine: AggregationEngine<T>,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly compareEngine: CompareEngine,
        private readonly relationalEngine: RelationalEngine, // <-- Inyectado para delegar cascadas
    ) {
        // 1. Nombre de la hoja mapeada
        this.resolvedSheetName = Reflect.getMetadata(SHEETS_TABLE_NAME, this.entityClass)
            || this.entityClass.name.replace(/(Entity|Model|Repository)$/, '').toUpperCase();

        // 2. Datos de estructura centralizados
        this.primaryKeyProp = this.metadataRegistry.getPrimaryKeyField(this.entityClass);
        this.columnDetails = this.metadataRegistry.getColumnDetails(this.entityClass);

        // 3. CORRECCIÓN CRÍTICA: El control de borrado es metadata de CLASE (Constructor)
        this.deleteControlProp = Reflect.getMetadata(SHEETS_DELETE_CONTROL, this.entityClass) || null;

        this.persistableKeys = Object.keys(this.columnDetails);
        this.logger.debug(`🔥 Motor de Persistencia unificado y listo para: ${this.resolvedSheetName}`);
    }

    /**
         * Envía actualizaciones parciales mapeando propiedades a coordenadas de celdas A1.
         */
    async updatePartialBatch(physicalRow: number, entity: Partial<T>): Promise<void> {
        const sheetResponse = await this.gettersEngine.getOrFetchSheet();
        const headers = sheetResponse.data?.[0] || [];

        if (headers.length === 0) throw new Error('Estructura de columnas inaccesible.');

        const updates = this.persistableKeys.map(propKey => {
            const value = (entity as any)[propKey];
            if (value === undefined) return null;

            const config = this.columnDetails[propKey];
            const headerName = config?.name || propKey;

            const colIndex = headers.findIndex(h => h?.toString().trim().toLowerCase() === headerName.toLowerCase());
            if (colIndex === -1) return null;

            return {
                range: `${this.resolvedSheetName}!${this.indexToColumnLetter(colIndex)}${physicalRow}`,
                value,
                type: config?.type
            };
        }).filter(Boolean);

        if (updates.length > 0) {
            await this.updateCellsBatch(updates as any);
        }
    }
    /**
      * SAVE: Determina automáticamente si debe     Crear o Actualizar.
      */
    /**
     * SAVE: El punto de entrada único para Active Record.
     * Determina automáticamente la acción física.
     */
    /**
     * SAVE: Punto de entrada Active Record. Determina automáticamente si es una inserción o actualización.
     */
    async save(entity: T): Promise<T> {
        console.log('[PersistenceEngine] Datos recibidos para guardar:', entity);
        const id = (entity as any)[this.primaryKeyProp];
        let physicalRow = (entity as any).__row;

        // Localización de fila por si el objeto viene de la red sin __row
        if (!physicalRow && id) {
            const existing = await this.gettersEngine.findOneInternal(
                { [this.primaryKeyProp]: id } as any,
                this.compareEngine
            );
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
            throw new InternalServerErrorException('No se pudo completar la persistencia del documento.');
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
    /**
     * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
     */
    /**
 * CREATE: Procesa y guarda un nuevo registro en Google Sheets de forma atómica.
 */
    /**
     * CREATE: Inserta un nuevo registro de manera atómica con control de resiliencia.
     */
    async create(entity: T): Promise<T> {
        const sheetInfo = await this.gettersEngine.getOrFetchSheet();
        if (sheetInfo.isEmergency) {
            throw new ServiceUnavailableException('Sistema en modo de emergencia (Lectura). Escritura denegada.');
        }

        // Generar IDs automáticos (UUID/ShortID)
        this.applyAutogeneratedFields(entity);

        try {
            const response = await this.gateway.appendRow(entity);

            // Asignación de fila atómica basada en la respuesta de Google API
            if (response?.updates?.updatedRange) {
                const match = response.updates.updatedRange.match(/\d+$/);
                if (match) {
                    (entity as any).__row = parseInt(match[0], 10);
                }
            }

            await this.gettersEngine.clearCache();
            this.logger.log(`[Create Success] Nuevo registro en ${this.resolvedSheetName}, fila: ${(entity as any).__row}`);
            return entity;
        } catch (error) {
            this.logger.error(`Fallo crítico en creación: ${error.message}`);
            throw new InternalServerErrorException('Error al escribir la nueva fila en Google Sheets.');
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
    async updateEntity(entity: T, changes: Partial<T>): Promise<void> {
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
     * Genera automáticamente identificadores únicos (UUID o Short-ID) para los campos decorados.
     * Protege contra valores vacíos o strings de solo espacios provenientes del cliente.
     */
    private applyAutogeneratedFields(entity: T): void {
        for (const propertyKey of this.persistableKeys) {
            const config = this.columnDetails[propertyKey];
            if (!config?.generated) continue;

            const currentValue = (entity as any)[propertyKey];

            // Validamos que el campo esté realmente vacío (null, undefined o string vacío)
            if (currentValue === undefined || currentValue === null || String(currentValue).trim() === '') {
                const newId = config.generated === 'uuid'
                    ? IdGenerator.generate()
                    : IdGenerator.generateShort();

                (entity as any)[propertyKey] = newId;
                this.logger.debug(`✨ Campo autogenerado de forma segura [${String(propertyKey)}]: ${newId}`);
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

        const index = await this.gettersEngine.getRowIndexById(id);
        // Las cabeceras ocupan la fila 1, por lo que los registros válidos de datos inician en fila >= 2
        return index > 1;
    }

}

