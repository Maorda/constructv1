// persistence.manager.ts
import { Injectable, Logger, Inject, InternalServerErrorException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetsDataGateway } from '../services/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ClassType, FilterQuery, UpdateQuery } from '@database/types/query.types';

import { GLOBAL_RELATION_REGISTRY, RELATION_METADATA_KEY, RelationOptions } from '@database/decorators/relation.decorator';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { GettersEngine } from './getters.engine';
import { getColumnLetter, withRetry } from '@database/utils/tools';
import { RepositoryContext } from '@database/repositories/repository.context';
import { PRIMARY_KEY_METADATA_KEY } from '@database/decorators/primarykey.decorator';
import { ColumnOptions, TABLE_COLUMN_DETAILS_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { TABLE_NAME_KEY } from '@database/decorators/table.decorator';
import { ModuleRef } from '@nestjs/core';
import { COLUMN_METADATA_KEY, DELETE_CONTROL_METADATA_KEY } from '@database/constants/metadata.constants';
import { AggregationEngine } from '@database/engines/aggregation.engine';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { CompareEngine } from '@database/engines/compare.engine';
import { IdGenerator } from '@database/utils/id.generator';


export class PersistenceEngine<T extends object> implements IPersistenceEngine<T> {

    private readonly logger = new Logger(PersistenceEngine.name);
    private readonly resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private readonly deleteControlProp: string | null;
    private currentHeaders: string[] = [];
    private readonly persistableKeys: string[];
    @Inject(CACHE_MANAGER) private cacheManager: Cache


    constructor(
        @Inject('ENTITY_CLASS') private readonly entityClass: new () => T,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly gettersEngine: GettersEngine<T>,
        private readonly moduleRef: ModuleRef, // <--- Para localizar repositorios hijos
        private readonly aggregationEngine: AggregationEngine<T>,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly compareEngine: CompareEngine,
    ) {
        // --- BLOQUE DE INICIALIZACIÓN (Lo que tú observaste) ---
        const prototype = this.entityClass.prototype;

        this.resolvedSheetName = Reflect.getMetadata(TABLE_NAME_KEY, this.entityClass)
            || this.entityClass.name.replace(/(Entity|Model|Repository)$/, '').toUpperCase();

        this.primaryKeyProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, prototype) || 'id';

        // Usamos la misma clave que en el GettersEngine para consistencia
        this.columnDetails = Reflect.getMetadata(COLUMN_METADATA_KEY, prototype) || {};

        this.deleteControlProp = Reflect.getMetadata(DELETE_CONTROL_METADATA_KEY, prototype) || null;
        this.persistableKeys = Object.keys(this.columnDetails);

        this.logger.debug(`Motor de Persistencia listo para: ${this.resolvedSheetName}`);


    }

    private async createActiveEntity(entity: T): Promise<T> {
        try {
            const rawData = await this.gateway.getAllRows(this.resolvedSheetName) as any[][];
            const headers = (rawData && rawData.length > 0) ? rawData[0] as string[] : [];

            if (headers.length === 0) throw new Error(`No hay cabeceras en ${this.resolvedSheetName}`);

            // Usamos SheetMapper para convertir solo los campos permitidos
            const rowArray = SheetMapper.mapToRow(headers, entity, this.columnDetails);

            await this.gateway.appendRows(
                this.optionsDatabase.defaultSpreadsheetId,
                `${this.resolvedSheetName}!A1`,
                [rowArray]
            );

            // En Active Record, actualizamos la instancia actual
            const newPhysicalRow = rawData.length + 1;
            (entity as any).__row = newPhysicalRow;

            await this.gettersEngine.clearCache();

            this.logger.log(`[ActiveRecord] Creado exitosamente en fila ${newPhysicalRow}`);
            return entity;
        } catch (error) {
            this.logger.error(`Error al crear: ${error.message}`);
            throw new InternalServerErrorException('Error en persistencia.');
        }
    }

    private async updateActiveEntity(entity: T): Promise<T> {
        const physicalRow = (entity as any).__row;

        // Ejecutamos la actualización parcial usando los campos configurados
        await this.updatePartialBatch(physicalRow, entity);

        // Al terminar, limpiamos caché para que las lecturas vean el cambio
        await this.gettersEngine.clearCache();

        this.logger.log(`[ActiveRecord] Actualizada fila ${physicalRow} para ${this.resolvedSheetName}`);
        return entity;
    }





    async updatePartialBatch(physicalRow: number, entity: Partial<T>): Promise<void> {
        const rawData = await this.gateway.getAllRows(this.resolvedSheetName) as any[][];
        const headers = rawData[0] as string[];

        const updates = this.persistableKeys.map(propKey => {
            const value = (entity as any)[propKey];
            if (value === undefined) return null;

            const config = this.columnDetails[propKey];
            const headerName = config?.name || propKey;
            const colIndex = headers.findIndex(h => h.trim().toLowerCase() === headerName.toLowerCase());

            if (colIndex === -1) return null;

            return {
                range: `${this.resolvedSheetName}!${this.indexToColumnLetter(colIndex)}${physicalRow}`,
                value: value,
                type: config?.type
            };
        }).filter(u => u !== null);

        await this.updateCellsBatch(updates);
    }
    /**
      * SAVE: Determina automáticamente si debe     Crear o Actualizar.
      */
    /**
     * SAVE: El punto de entrada único para Active Record.
     * Determina automáticamente la acción física.
     */
    async save(entity: T): Promise<T> {
        // Obtenemos la propiedad que es Primary Key (ej: 'id' o 'dni')
        const pkField = this.metadataRegistry.getPrimaryKeyField(this.entityClass);
        const id = (entity as any)[pkField];
        let physicalRow = (entity as any).__row;

        // 1. LOCALIZACIÓN INTELIGENTE
        // Si no tenemos la fila pero sí el ID, lo buscamos en el motor de lectura
        if (!physicalRow && id) {
            const existing = await this.gettersEngine.findOneInternal(
                { [pkField]: id } as any,
                this.compareEngine // <--- Aquí pasamos el motor, no un boolean
            );

            if (existing) {
                physicalRow = (existing as any).__row;
                (entity as any).__row = physicalRow;
            }
        }

        // 2. DECISIÓN: UPDATE O CREATE
        try {
            if (physicalRow) {
                // UPDATE: Ya tenemos la fila física
                // Nota: Usamos el método update que ya procesa los operadores
                await this.update(id, entity as Partial<T>);
                this.logger.log(`[Update] Registro ${id} sincronizado en fila ${physicalRow}`);
            } else {
                // CREATE: Es un registro nuevo
                await this.create(entity);
                this.logger.log(`[Create] Nuevo registro generado para ID ${id}`);
            }

            // 3. LIMPIEZA DE CACHÉ
            // Importante: Lo hacemos después de la operación exitosa
            await this.gettersEngine.clearCache();

            return entity;
        } catch (error) {
            this.logger.error(`Error en operación Save: ${error.message}`);
            throw new InternalServerErrorException('No se pudo completar la persistencia del documento.');
        }
    }

    /**
     * DELETE: Orquesta la limpieza del registro y sus dependencias.
     */
    async delete(idOrEntity: string | number | T): Promise<void> {
        let physicalRow: number;
        let id: string | number;

        // 1. Identificar ID y Fila
        if (typeof idOrEntity === 'object') {
            physicalRow = (idOrEntity as any).__row;
            id = (idOrEntity as any)[this.primaryKeyProp];
        } else {
            id = idOrEntity;
            physicalRow = await this.gettersEngine.getRowIndexById(id);
        }

        if (!physicalRow || physicalRow === -1) {
            this.logger.warn(`Registro no encontrado para borrado lógico.`);
            return;
        }

        // 2. EJECUTAR SOFT DELETE EN CASCADA
        // Pasamos el ID para que los hijos sepan a quién pertenecen
        await this.executeSoftCascade(id);

        // 3. ACTUALIZAR ESTADO DEL PADRE
        // Usamos el deleteControlProp definido en el constructor (@DeleteControl)
        if (this.deleteControlProp) {
            await this.updateLogicalStatus(physicalRow, 'INACTIVO'); // O el valor que prefieras
            this.logger.log(`[SoftDelete] ${this.resolvedSheetName} marcado como INACTIVO.`);
        } else {
            // Si no hay decorador de control, avisamos o procedemos con borrado físico
            this.logger.warn(`No se definió @DeleteControl en ${this.resolvedSheetName}.`);
        }

        await this.gettersEngine.clearCache();
    }

    /**
     * Propaga el estado inactivo a los hijos definidos en la relación
     */
    private async executeSoftCascade(parentId: string | number): Promise<void> {
        const dependencies = GLOBAL_RELATION_REGISTRY.get(this.entityClass.name);
        if (!dependencies) return;

        for (const dep of dependencies) {
            try {
                const childRepo = this.moduleRef.get(dep.childRepository, { strict: false });
                if (childRepo && childRepo.engine) {
                    // Buscamos los hijos activos de este padre
                    const allChildren = await childRepo.engine.gettersEngine.findAll();
                    const targets = allChildren.filter(child =>
                        String(child[dep.joinColumn]) === String(parentId)
                    );

                    // Llamamos recursivamente al delete de cada hijo
                    // Esto permite que Obra -> Supervisores -> Cuadrilla funcione en cadena
                    for (const child of targets) {
                        await childRepo.engine.delete(child);
                    }
                }
            } catch (error) {
                this.logger.error(`Error en cascada lógica para ${dep.childSheet}: ${error.message}`);
            }
        }
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
    async create(entity: T): Promise<T> {
        const columnsDetails = this.metadataRegistry.getColumnDetails(this.entityClass);

        // 1. VALIDACIÓN DE ESTADO (Resiliencia)
        const sheetInfo = await this.gettersEngine.getOrFetchSheet();
        const pkField = this.metadataRegistry.getPrimaryKeyField(this.entityClass);
        const pkConfig = columnsDetails[pkField];

        // Si la PK está marcada para generarse y viene vacía
        if (pkConfig?.generated && !entity[pkField]) {
            entity[pkField] = pkConfig.generated === 'uuid'
                ? IdGenerator.generate()
                : IdGenerator.generateShort();
        }

        if (sheetInfo.isEmergency) {
            throw new ServiceUnavailableException(
                'El sistema está en modo de lectura (Emergencia). No se permiten escrituras hasta recuperar conexión con Google.'
            );
        }

        // --- NUEVO: GENERACIÓN DE IDENTIFICADORES BASADOS EN METADATOS ---
        // Recorremos las columnas para ver si alguna requiere generación automática
        for (const propertyKey in columnsDetails) {
            const config = columnsDetails[propertyKey];
            const currentValue = (entity as any)[propertyKey];

            // Solo generamos si la columna tiene la opción 'generated' y el valor está vacío
            if (config.generated && (currentValue === null || currentValue === undefined || currentValue === '')) {
                if (config.generated === 'uuid') {
                    (entity as any)[propertyKey] = IdGenerator.generate();
                }
                else if (config.generated === 'short-id') {
                    (entity as any)[propertyKey] = IdGenerator.generateShort();
                }
                this.logger.debug(`ID autogenerado para ${propertyKey}: ${(entity as any)[propertyKey]}`);
            }
        }
        // ----------------------------------------------------------------

        try {
            // 2. PERSISTENCIA FÍSICA
            // Ahora 'entity' ya viaja con sus IDs generados
            await this.gateway.appendRow(entity);

            // 3. INVALIDACIÓN ESTRATÉGICA DEL CACHÉ
            await this.gettersEngine.clearCache();

            // 4. SINCRONIZACIÓN DEL __row
            const freshSheet = await this.gettersEngine.getOrFetchSheet();
            const freshData = freshSheet.data || [];

            const lastIndex = freshData.length - 1;
            const physicalRow = lastIndex + 2;

            (entity as any).__row = physicalRow;

            this.logger.log(`Entidad creada exitosamente en fila ${physicalRow}`);
            return entity;

        } catch (error) {
            this.logger.error(`Fallo crítico en creación: ${error.message}`);
            throw new InternalServerErrorException('No se pudo completar la operación de escritura en la nube.');
        }
    }
    /**
     * UPDATE: Busca la fila por ID y actualiza todas sus celdas.
     */
    async update(id: string | number, updateQuery: UpdateQuery<T>): Promise<T> {
        // 1. Localizamos el registro actual para obtener data y su ubicación física (__row)
        const currentData = await this.gettersEngine.findByRowId(id);

        if (!currentData || !(currentData as any).__row) {
            throw new Error(`No se encontró el registro o la ubicación física para el ID: ${id}`);
        }

        const rowIndex = (currentData as any).__row;

        // 2. Ejecutamos la transformación de los operadores
        const finalData = this.applyUpdateQuery(currentData, updateQuery);

        // 3. Enviamos al Gateway solo el índice y la data final
        return await this.gateway.updateRow(rowIndex, finalData);
    }

    /**
     * EL MOTOR DE TRANSFORMACIÓN:
     * Procesa $set, $inc, $push y data plana.
     */
    private applyUpdateQuery(current: T, query: UpdateQuery<T>): T {
        // Creamos una copia profunda para no mutar el objeto original del caché
        let updated = { ...current } as any;

        // Desestructuramos para separar operadores de propiedades planas
        const { $set, $inc, $push, ...plainData } = query as any;

        // A. Aplicar Data Plana (Propiedades directas)
        Object.assign(updated, plainData);

        // B. Operador $set (Sobrescritura explícita)
        if ($set) {
            Object.assign(updated, $set);
        }

        // C. Operador $inc (Incrementos numéricos)
        if ($inc) {
            for (const key in $inc) {
                const increment = $inc[key];
                if (typeof increment === 'number') {
                    const baseValue = Number(updated[key]) || 0;
                    updated[key] = baseValue + increment;
                }
            }
        }

        // D. Operador $push (Arrays)
        if ($push) {
            for (const key in $push) {
                // Si la celda tiene data, intentamos parsearla como array, si no, empezamos uno vacío
                let currentArray: any[] = [];
                try {
                    currentArray = Array.isArray(updated[key])
                        ? updated[key]
                        : (updated[key] ? JSON.parse(updated[key]) : []);
                } catch (e) {
                    currentArray = [];
                }

                currentArray.push($push[key]);
                updated[key] = currentArray;
            }
        }

        return updated as T;
    }

    private isUpdateQuery(q: any): q is UpdateQuery<T> {
        return q && (q.$set || q.$inc || q.$push);
    }


    /**
      * EXISTS: Verifica si un ID ya está presente en la columna de Primary Key.
      */
    async exists(id: string | number): Promise<boolean> {
        const index = await this.gettersEngine.findRowIndexById(id);
        return index !== -1;
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

    /*
      * Descripcion: Limpia el caché de la hoja, Invalida todos 
      * los niveles de caché relacionados con una hoja específica
      * Se ubica en PersistenceEngine porque este motor conoce la estructura 
      * de almacenamiento en Google Sheets.
      * Parametros: 
      *   sheetName: Nombre de la hoja
      * Retorna: void
    */
    /**
 * 
 */
    // --- MÉTODOS PRIVADOS DE INFRAESTRUCTURA ---

    private async clearCache(sheetName: string): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const keys = [
            `sheet_data:${spreadsheetId}:${sheetName}`,
            `list:${sheetName}`,
        ];
        try {
            await Promise.all(keys.map(key => this.cacheManager.del(key)));
        } catch (error) {
            this.logger.error(`[Cache] Error al limpiar ${sheetName}: ${error.message}`);
        }
    }


    /**
     * El método core que realiza la petición física.
     */
    // persistence.manager.ts

    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;

        const data = updates.map(u => ({
            range: u.range,
            values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
        }));

        try {
            // ENVOLVEMOS LA LLAMADA CON withRetry
            await withRetry(async () => {
                return await this.gateway.updateCellsBatch(data);
            }, 3, 1500);
            await this.clearCache(this.resolvedSheetName);

        } catch (error) {
            const status = error?.status || error?.response?.status;
            if (status === 429) {
                this.logger.error("Se ha agotado la cuota de la API de Google Sheets. Espera un momento.");
            } else {
                this.logger.error(`Fallo definitivo tras reintentos: ${error.message}`);
            }
            throw new InternalServerErrorException('No se pudo sincronizar con Google Sheets tras varios intentos.');
        }
    }

    /**
     * Convierte un índice numérico a letras de columna de Excel (0 -> A, 26 -> AA).
     */
    private indexToColumnLetter(index: number): string {
        let temp = index;
        let letter = '';
        while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
        }
        return letter;
    }

    async findOneAndUpdate(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any[], // Soporta tus operadores y pipelines
        options: {
            projection?: any,
            upsert?: boolean,
            new?: boolean,
            includeInactive?: boolean
        } = { new: true, upsert: false }
    ): Promise<Partial<T> | null> {

        // 1. LOCALIZACIÓN CON MOTORES (Solución al error del boolean)
        // Usamos findOneInternal pasando el compareEngine inyectado
        let entity: T | null = await this.gettersEngine.findOneInternal(
            filter,
            this.compareEngine // <--- AQUÍ: Pasamos el motor, no un boolean
        );

        // 2. MANEJO DE UPSERT
        if (!entity) {
            if (options.upsert) {
                this.logger.log('Upsert activado: Creando instancia base desde el filtro');
                const newInstance = new (this.entityClass as any)();
                Object.assign(newInstance, this.extractLiteralFields(filter));
                entity = newInstance as T;
            } else {
                return null;
            }
        }

        // 3. PROCESAMIENTO DE DATOS (Pipeline vs Operadores)
        let finalPayload: T;

        if (Array.isArray(updateData)) {
            // Si es un array, es un pipeline para el AggregationEngine
            const result = await this.aggregationEngine.run([entity], updateData);
            finalPayload = result[0] as T;
        } else {
            // Si es un objeto, usamos el applyUpdateQuery que refactorizamos ($set, $inc, etc.)
            finalPayload = this.applyUpdateQuery(entity, updateData as UpdateQuery<T>);
        }

        // 4. PERSISTENCIA FÍSICA
        const physicalRow = (entity as any).__row;

        if (physicalRow) {
            // UPDATE: Usamos el Gateway directamente con el índice ya conocido
            await this.gateway.updateRow(physicalRow, finalPayload);
            this.logger.log(`[findOneAndUpdate] Fila ${physicalRow} actualizada.`);
        } else {
            // CREATE: Si fue un Upsert sin fila previa
            const created = await this.create(finalPayload);
            (entity as any).__row = (created as any).__row;
        }

        // 5. POST-PROCESO Y RESPUESTA
        await this.gettersEngine.clearCache();

        const resultState = options.new ? finalPayload : entity;

        // Aplicamos proyección si existe (delegando al service de proyección)
        if (options.projection) {
            return this.gettersEngine.applyProjection(resultState, options.projection);
        }

        return resultState as Partial<T>;
    }

    /**
     * Auxiliar para extraer campos simples del filtro en caso de Upsert
     * (Ej: si filtras por { dni: '123' }, el nuevo registro ya nace con ese DNI)
     */
    private extractLiteralFields(filter: FilterQuery<T>): Partial<T> {
        const literals: any = {};
        for (const [key, value] of Object.entries(filter)) {
            if (typeof value !== 'object' || value instanceof Date) {
                literals[key] = value;
            }
        }
        return literals;
    }


}

