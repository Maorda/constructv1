import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { GoogleSpreedsheetService } from './google.spreedsheet.service';
import { RelationOptions, RELATION_METADATA_KEY } from '@database/decorators/relation.decorator';
import { EntityFilterQuery, UpdateQuery } from '@database/types/query.types';
import { IdGenerator } from '@database/utils/id.generator';
import { getPrimaryKeyColumnName } from '@database/decorators/primarykey.decorator';
import { SheetsQuery } from '@database/engines/query.builder';
import { SheetMapper } from '@database/mappers/sheet.mapper';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { TABLE_COLUMN_KEY } from '@database/decorators/column.decorator';
import { RelationalEngine } from '@database/engines/relational.engine';
import { ManipulateEngine } from '@database/engines/manipulateEngine';
import { GettersEngine } from '@database/engines/getters.engine';
import { PersistenceEngine } from '@database/engines/persistence.engine';
import { CompareEngine } from '@database/engines/compare.engine';

@Injectable()
export abstract class BaseSheetsCrudService<T extends object> {
    private readonly logger = new Logger(BaseSheetsCrudService.name);
    private isSynced = false;
    public sheetName: string;
    private queryEngine = new CompareEngine<T>();
    protected abstract readonly EntityClass: new () => T;

    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    constructor(
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private readonly spreadsheetService: GoogleSpreedsheetService,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine, // Tu motor de mutación
        private readonly gettersEngine: GettersEngine,      // Tu motor de consulta
        private readonly relationalEngine: RelationalEngine<T>,
        private readonly persistenceEngine: PersistenceEngine,
    ) { }

    async findAll<T>(EntityClass: new () => T): Promise<T[]> {
        const sheetName = EntityClass.name;

        // 1. Obtenemos datos crudos del Driver (GoogleSpreedsheetService)
        const rawValues = await this.spreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!A:Z`);
        if (!rawValues || rawValues.length <= 1) return [];

        const headers = rawValues[0]; // La primera fila son los encabezados
        const rows = rawValues.slice(1);

        // 2. Usamos el Mapper para convertir cada fila en una instancia de la Clase
        return rows.map(row => SheetMapper.mapToEntity(headers, row, EntityClass));
    }

    /**
     * FIND ONE: Con Cache y Populate de @Relation
     */
    async findOne(entityClass: any, id: string, idFieldName: string = 'id') {
        const sheetName = entityClass.name; // O el metadato @Table
        const cacheKey = `row:${sheetName}:${id}`;

        let data = await this.cacheManager.get(cacheKey);

        if (!data) {
            const allRows = await this.spreadsheetService.findAll(this.optionsDatabase.defaultSpreadsheetId, sheetName);
            data = allRows.find(row => String(row[idFieldName]) === String(id));

            if (data) {
                // Aplicamos GettersEngine para formatear salida
                data = this.gettersEngine.execute(data, data);
                // Auto-populate basado en tu decorador @Relation
                data = await this.resolveRelations(entityClass, data);
                await this.cacheManager.set(cacheKey, data, 300000); // 5 min
            }
        }
        return data;
    }

    /**
     * CREATE: Procesa con ManipulateEngine y guarda un registro
     */
    async create<T>(entity: T): Promise<void> {
        const EntityClass = entity.constructor as new () => T;
        const sheetName = EntityClass.name;

        // 1. Obtenemos headers actuales de la hoja
        const headers = await this.persistenceEngine.getHeaders(sheetName);

        // 2. Convertimos la entidad a una fila plana usando el Mapper
        const row = SheetMapper.mapToRow(headers, entity);

        // 3. Guardamos mediante el Driver
        await this.spreadsheetService.appendRows(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!A1`, row);
    }

    async findOneAndUpdate(
        filter: EntityFilterQuery<T>,
        update: UpdateQuery<T>,
        options: { new?: boolean; upsert?: boolean; arrayFilters?: any[] } = { new: true, upsert: false },
    ): Promise<T | null> {
        await this.ensureSchema();

        // 1. DESCOMPOSICIÓN DE OPERADORES
        const updateObj = update as any;
        let dataToSet = updateObj.$set || (updateObj.$push ? {} : update);
        const dataToPush = updateObj.$push || null;

        // 2. BÚSQUEDA DEL REGISTRO Y SU POSICIÓN
        // Importante: Necesitamos el índice de la fila para el Batch Update
        const rawRows = await this.spreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, `${this.sheetName}!A:Z`);
        const headers = rawRows[0];

        // Buscamos el registro y guardamos su índice (rowIndex = index + 2 porque las filas en Sheets son base 1 y hay cabecera)
        let rowIndex = -1;
        const record = rawRows.slice(1).find((row, index) => {
            const entity = SheetMapper.mapToEntity(headers, row, this.EntityClass);
            if (this.queryEngine.applyFilter(entity, filter)) {
                rowIndex = index + 2;
                return true;
            }
            return false;
        }) as T | undefined;

        const pkColumnName = getPrimaryKeyColumnName(this.EntityClass);
        if (!pkColumnName) throw new Error(`La entidad ${this.EntityClass.name} no tiene @PrimaryKey.`);

        // 3. TRANSFORMACIÓN CON MOTORES
        // El motor usa el 'record' actual para resolver cálculos como $dateDiff
        const mutatedData = this.manipulateEngine.execute(dataToSet, record || {});

        let finalEntity: T;
        let currentEntity: T | null = null; // Inicializamos aquí

        if (!record) {
            if (!options.upsert) return null;

            // LÓGICA DE UPSERT: Crear nuevo
            finalEntity = {
                [pkColumnName]: IdGenerator.generate(),
                ...this.extractValuesFromFilter(filter),
                ...mutatedData,
            } as T;

            // Save usa appendRow (nueva fila al final)
            await this.save(finalEntity);
        } else {
            // LÓGICA DE UPDATE OPTIMIZADO (Batch + Delta)
            currentEntity = SheetMapper.mapToEntity(headers, (record as any), this.EntityClass);

            // Unimos los datos actuales con las mutaciones
            finalEntity = Object.assign(new this.EntityClass(), currentEntity, mutatedData);

            // Obtenemos solo lo que cambió
            const delta = SheetMapper.getDeltaUpdate(headers, currentEntity, finalEntity);

            if (delta.length > 0) {
                // Preparamos el Batch para Google Sheets
                const batchUpdates = delta.map(change => ({
                    range: `${this.sheetName}!${this.getColumnLetter(change.colIndex)}${rowIndex}`,
                    value: change.value
                }));

                // Enviamos todos los cambios en una sola petición
                await this.spreadsheetService.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, batchUpdates);
            }
        }

        // 4. PROCESAMIENTO DE $PUSH (Relaciones)
        if (dataToPush) {
            await this.relationalEngine.handlePushOperation(finalEntity, dataToPush, options.arrayFilters);
        }

        // 5. INVALIDACIÓN DE CACHÉ QUIRÚRGICA
        // En lugar de borrar toda la pestaña, borramos solo este registro
        const pkValue = (finalEntity as any)[pkColumnName];
        await this.cacheManager.del(`row:${this.sheetName}:${pkValue}`);
        await this.cacheManager.del(`list:${this.sheetName}`); // Invalida la lista general

        return options.new ? finalEntity : (currentEntity || finalEntity);
    }

    async deleteRow(spreadsheetId: string, sheetId: number, rowIndex: number) {
        try {
            return await this.googleAuthService.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId,
                                dimension: 'ROWS',
                                startIndex: rowIndex,
                                endIndex: rowIndex + 1,
                            },
                        },
                    }],
                },
            });
        } catch (error) {
            throw new InternalServerErrorException('No se pudo eliminar la fila.');
        }
    }

    /**
     * Lógica interna para "podar" los campos del objeto según la Projection.
     * Se define como protected para que DocumentQuery (que tiene acceso al service)
     * pueda invocarlo durante la resolución de la consulta.
     */
    protected applyProjection(record: T, projection: Projection<T>): Partial<T> {
        const projectionKeys = Object.keys(projection);

        // Si no hay llaves en la proyección, devolvemos el registro completo
        if (projectionKeys.length === 0) return record;

        const projectedRecord: any = {};

        // Determinamos si es modo INCLUSIÓN (buscamos al menos un 1 o true)
        const isInclusion = projectionKeys.some(
            key => projection[key as keyof T] === 1 || projection[key as keyof T] === true
        );

        if (isInclusion) {
            // MODO INCLUSIÓN: Solo lo que el usuario pidió
            projectionKeys.forEach((key) => {
                if (projection[key as keyof T]) {
                    projectedRecord[key] = (record as any)[key];
                }
            });

            // REGLA DE SEGURIDAD: Siempre incluir el ID para no romper SheetDocument.save()
            // a menos que se excluya explícitamente con 0 o false.
            if (projection['id' as keyof T] !== 0 && projection['id' as keyof T] !== false && (record as any).id) {
                projectedRecord.id = (record as any).id;
            }
        } else {
            // MODO EXCLUSIÓN: Todo excepto lo marcado con 0 o false
            Object.keys(record as object).forEach((key) => {
                if (projection[key as keyof T] !== 0 && projection[key as keyof T] !== false) {
                    projectedRecord[key] = (record as any)[key];
                }
            });
        }

        return projectedRecord as Partial<T>;
    }
    // Dentro de tu lógica de actualización en el CRUD Service
    async updateRowOptimized<T>(
        EntityClass: new () => T,
        originalRecord: T,
        updatedData: Partial<T>,
        rowIndex: number
    ) {
        const sheetName = EntityClass.name;
        const headers = await this.persistenceEngine.getHeaders(EntityClass);

        // 1. Unimos los cambios con el registro original
        const finalEntity = Object.assign(new EntityClass(), originalRecord, updatedData);

        // 2. Obtenemos el Delta usando el Mapper
        const delta = SheetMapper.getDeltaUpdate(headers, originalRecord, finalEntity);

        if (delta.length === 0) return originalRecord;

        // 3. Preparamos el array de actualizaciones para el Batch
        const batchUpdates = delta.map(change => {
            const columnLetter = this.getColumnLetter(change.colIndex);
            return {
                range: `${sheetName}!${columnLetter}${rowIndex}`,
                value: change.value
            };
        });

        // 4. Una sola llamada a la API de Google
        await this.spreadsheetService.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, batchUpdates);

        // 5. Invalidamos el caché de esta fila específica
        const pkColumn = getPrimaryKeyColumnName(EntityClass);
        const pkValue = (finalEntity as any)[pkColumn];
        await this.cacheManager.del(`row:${sheetName}:${pkValue}`);

        return finalEntity;
    }

    /**
     * Conversor de índice a letras de columna (Soporta A hasta ZZ)
     */
    private getColumnLetter(index: number): string {
        let temp, letter = '';
        while (index > -1) {
            temp = (index) % 26;
            letter = String.fromCharCode(temp + 65) + letter;
            index = (index - temp - 1) / 26;
        }
        return letter;
    }


    /**
      * Actualiza un registro por un identificador (ej: DNI)
      * Parametros: 
      *   identifierColumn: Columna identificadora
      *   value: Valor de la columna identificadora
      *   partialEntity: Entidad parcial con los datos a actualizar
      * Retorna: Entidad actualizada
      * Ejemplo: 
      *   await this.repository.updateRow('dni', '12345678', { nombre: 'Juan', apellido: 'Perez' });
      */
    async updateRow(identifierColumn: string, value: any, partialEntity: Partial<T>): Promise<T> {
        await this.ensureSchema();
        const range = `${this.sheetName}!A:Z`;
        const rows = await this.spreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, range);
        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(identifierColumn);
        if (colIndex === -1) throw new Error(`Columna ${identifierColumn} no encontrada`);
        const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[colIndex]) === String(value));
        if (rowIndex === -1) throw new NotFoundException('Registro no encontrado');
        // Mapear, fusionar y actualizar
        const currentData = SheetMapper.mapToEntity(headers, rows[rowIndex], this.EntityClass);
        const updatedData = Object.assign(currentData, partialEntity);
        const updatedRow = SheetMapper.mapToRow(headers, updatedData);
        // El rango es 1-based, por eso rowIndex + 1
        await this.spreadsheetService.updateRow(this.optionsDatabase.defaultSpreadsheetId, `${this.sheetName}!A${rowIndex + 1}`, [updatedRow]);
        return updatedData;
    }

    async softDelete<T>(EntityClass: new () => T, rowIndex: number): Promise<void> {
        const sheetName = EntityClass.name;
        const headers = await this.persistenceEngine.getHeaders(EntityClass);

        // Buscamos el índice de la columna que maneja el estado
        // Asumiendo que en tu DTO tienes una columna @Column({ name: 'activo' })
        const statusColIndex = headers.indexOf('activo');

        if (statusColIndex === -1) {
            throw new Error(`No se encontró la columna "activo" para borrado lógico en ${sheetName}`);
        }

        const columnLetter = this.getColumnLetter(statusColIndex);
        const range = `${sheetName}!${columnLetter}${rowIndex}`;

        // Marcamos como 'false' o 'INACTIVO'
        await this.spreadsheetService.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, [
            { range, value: false }
        ]);

        this.logger.log(`Registro en fila ${rowIndex} marcado como inactivo.`);
    }



    /**
    * Buscador con soporte para Query Chaining (estilo Mongoose).
    * Nota: Ya no es 'async' porque la ejecución real ocurre en el .then() de SheetsQuery
    */
    find(filter: EntityFilterQuery<T> = {}): SheetsQuery<T> {
        // 1. Validamos que el esquema esté cargado (opcional, pero recomendado)
        this.ensureSchema();

        // 2. Retornamos la clase encargada de construir la consulta.
        // Le pasamos 'this' para que SheetsQuery tenga acceso a findAll()
        // y le pasamos el queryEngine para que use tus métodos de filtrado y proyección.
        return new SheetsQuery<T>(this, filter, this.queryEngine);
    }

    /**
         * Retorna todos los registros de la hoja (usando caché)
         * Parametros: 
         *   none
         * Retorna: Entidad encontrada
         * Ejemplo: 
         *   await this.repository.findAll();
    */








    /**
     * WEBHOOK: Método para invalidar cache desde el controlador
     */
    async invalidateCache(sheetName: string, rowId?: string) {
        if (rowId) {
            await this.cacheManager.del(`row:${sheetName}:${rowId}`);
        }
        await this.cacheManager.del(`list:${sheetName}`);
        this.logger.log(`Cache limpiado para: ${sheetName}`);
    }

    private async resolveRelations(entityClass: any, record: any) {
        const instance = new entityClass();
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', instance) || [];

        for (const prop of relations) {
            const config: RelationOptions = Reflect.getMetadata(RELATION_METADATA_KEY, instance, prop);
            const localValue = record[config.localField];

            if (localValue) {
                const allRelated = await this.spreadsheetService.findAll(this.optionsDatabase.defaultSpreadsheetId, config.targetSheet);
                const matched = allRelated.filter(r => String(r[config.joinColumn]) === String(localValue));
                record[prop] = config.isMany ? matched : (matched[0] || null);
            }
        }
        return record;
    }
    /*
        *Descripcion: Sincroniza el esquema de la hoja de Google Sheets
        * Parametros: 
        *   force: Si es true, fuerza la escritura de las cabeceras
        * Retorna: void
        */
    async syncSchema(force: boolean = false): Promise<void> {
        const expectedHeaders = SheetMapper.getColumnHeaders(this.EntityClass);
        // Definimos cleanExpected: Limpiamos y convertimos a Mayúsculas
        const cleanExpected = expectedHeaders.map(h => String(h || '').trim().toUpperCase());
        // DIAGNÓSTICO 1: ¿Qué estamos intentando escribir?
        this.logger.debug(`[${this.sheetName}] Cabeceras esperadas: ${JSON.stringify(cleanExpected)}`);
        if (cleanExpected.length === 0) {
            this.logger.error(`❌ Error: No se encontraron decoradores @Column en ${this.EntityClass.name}`);
            return;
        }
        try {
            let currentHeaders: any[] = [];
            // Solo leemos si no estamos forzando la creación
            if (!force) {
                const range = `${this.sheetName}!A1:Z1`;
                const response = await this.spreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }
            // Comparamos normalizando
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) => String(currentHeaders[i] || '').trim().toUpperCase() !== h);
            if (isDesync) {
                this.logger.warn(`✍️ Escribiendo cabeceras en "${this.sheetName}"...`);
                // DIAGNÓSTICO 2: Verificamos antes de disparar la API
                console.log(`Enviando a Google -> SpreadsheetId: ${this.options.defaultSpreadsheetId}, Range: ${this.sheetName}!A1`);
                await this.spreadsheetService.updateRow(
                    this.options.defaultSpreadsheetId,
                    `${this.sheetName}!A1`,
                    [cleanExpected] // Debe ser una matriz: [ ["COL1", "COL2"] ]
                );
                this.logger.log(`✅ ¡Cabeceras enviadas a "${this.sheetName}" con éxito!`);
            } else {
                this.logger.log(`✅ Esquema de "${this.sheetName}" está al día.`);
            }
        } catch (error) {
            // DIAGNÓSTICO 3: Captura de error específico de la API
            this.logger.error(`❌ Error en syncSchema para ${this.sheetName}: ${error.message}`);
            if (error.response?.data) {
                console.error('Detalle de Google:', JSON.stringify(error.response.data, null, 2));
            }
        }
    }
    /*
    *Descripcion: Asegura que el esquema de la hoja de Google Sheets esté sincronizado
    * Parametros: 
    *   none
    * Retorna: void
    */
    private async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.syncSchema();
        this.isSynced = true;
    }
    extractValuesFromFilter(filter: any): any {
        const cleaned: any = {};
        for (const key in filter) {
            const value = filter[key];
            // Si el valor es directo (string/number), lo usamos. 
            // Si es un operador ($eq, $in), intentamos extraer el valor real.
            if (value !== null && typeof value === 'object') {
                if (value['$eq'] !== undefined) cleaned[key] = value['$eq'];
                // Otros operadores se ignoran para la creación de filas nuevas
            } else {
                cleaned[key] = value;
            }
        }
        return cleaned;
    }
    /**
     * Busca el valor en el registro comparando nombres de columnas
     */
    private findValueInInstance(record: T, columnName: string): any {
        const target = this.EntityClass.prototype;
        for (const key of Object.keys(record as object)) {
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);
            if (options?.name === columnName || key === columnName) {
                return (record as any)[key];
            }
        }
        return null;
    }
    async save(entity: T): Promise<T> {
        await this.ensureSchema();

        // Si la entidad no tiene ID, lo generamos automáticamente
        if (!(entity as any).id) {
            (entity as any).id = IdGenerator.generate();
        }

        // 1. Convertimos la entidad a un array de valores (fila) usando el Mapper
        const rowValues = SheetMapper.entityToRow(entity, this.persistenceEngine.headers);

        // 2. Insertamos en Google Sheets
        await this.spreadsheetService.appendRow(
            this.optionsDatabase.defaultSpreadsheetId,
            `${this.sheetName}!A:A`, // Rango de inserción
            rowValues
        );

        // 3. INVALIDACIÓN DEL CACHÉ: 
        // Borramos el caché de esta pestaña para que la próxima lectura sea fresca
        const cacheKey = `sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${this.sheetName}`;
        await this.cacheManager.del(cacheKey);

        return entity;
    }

}