import { Injectable, Inject, Logger, } from '@nestjs/common';
import { RelationOptions, RELATION_METADATA_KEY } from '@database/decorators/relation.decorator';
import { ClassType, EntityFilterQuery, Projection, UpdateQuery } from '@database/types/query.types';
import { IdGenerator } from '@database/utils/id.generator';
import { getPrimaryKeyColumnName } from '@database/decorators/primarykey.decorator';
import { SheetsQuery } from '@database/engines/sheet.query';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { TABLE_COLUMN_KEY } from '@database/decorators/column.decorator';
import { CompareEngine } from '@database/engines/compare.engine';
import { DocumentQuery } from '@database/engines/document.query';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { RepositoryContext } from '@database/repositories/repository.context';
import { BaseServiceInterface } from '@database/interfaces/base.service.interface';

@Injectable()
export abstract class BaseSheetsCrudService<T extends object> implements BaseServiceInterface<T> {
    private readonly logger = new Logger(BaseSheetsCrudService.name);
    private isSynced = false;
    public sheetName: string;
    private queryEngine = new CompareEngine();
    @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions
    // Definimos la propiedad que TypeScript reclama

    // Declaramos las propiedades que antes estaban en el constructor
    constructor(
        protected readonly ctx: RepositoryContext, // <--- El "maletín" con todo
        protected readonly EntityClass: ClassType, // <--- La clase de la entidad
    ) { // Ahora sí puedes usar NamingStrategy porque EntityClass ya tiene valor
        this.sheetName = NamingStrategy.formatSheetName(this.EntityClass.name);
    }









    async findOneAndUpdate<T extends object>(
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
        const rawRows = await this.googleSpreadsheetService.getValues(this.optionsDatabase.defaultSpreadsheetId, `${this.sheetName}!A:Z`);
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
                    range: `${this.sheetName}!${this.relationalEngine.getColumnLetter(change.colIndex)}${rowIndex}`,
                    value: change.value
                }));

                // Enviamos todos los cambios en una sola petición
                await this.relationalEngine.updateCellsBatch(this.optionsDatabase.defaultSpreadsheetId, batchUpdates);
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













    /**
    * Buscador con soporte para Query Chaining (estilo Mongoose).
    * Nota: Ya no es 'async' porque la ejecución real ocurre en el .then() de SheetsQuery
    */
    find<T extends object>(filter: EntityFilterQuery<T> = {}): SheetsQuery<T> {
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


    private async resolveRelations(entityClass: any, record: any) {
        const instance = new entityClass();
        const relations: string[] = Reflect.getMetadata('sheets:all_relations', instance) || [];

        for (const prop of relations) {
            const config: RelationOptions = Reflect.getMetadata(RELATION_METADATA_KEY, instance, prop);
            const localValue = record[config.localField];

            if (localValue) {
                /**
                 * CORRECCIÓN: 
                 * Ahora debemos pasarle config.target() a findAll.
                 * config.target suele ser una función que devuelve la clase (ej: () => Obrero)
                 * para evitar problemas de dependencia circular.
                 */
                const targetEntity = config.targetEntity();

                // Pasamos la clase destino al findAll para que el mapeador funcione
                const allRelated = await this.googleSpreadsheetService.findAll(targetEntity);

                const matched = allRelated.filter(r =>
                    String((r as any)[config.joinColumn]) === String(localValue)
                );

                record[prop] = config.isMany ? matched : (matched[0] || null);
            }
        }
        return record;
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
     * Este es el método que REALMENTE va a Google Sheets.
     * Es llamado internamente por el DocumentQuery.then()
     */
    async executeQuery<T extends object>(filter: EntityFilterQuery<T>, projection?: Projection<T>): Promise<Partial<T> | null> {
        // 1. Obtenemos todos los datos (crudos)
        const allRows = await this.findAll(); // Método que lee la hoja

        // 2. Usamos el CompareEngine para encontrar la fila que calza
        const record = allRows.find(row => this.queryEngine.applyFilter(row, filter));

        if (!record) return null;

        // 3. APLICAMOS LA PROYECCIÓN
        // Usamos el método que revisamos anteriormente
        return this.applyProjection(record as T, projection || {});
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

    // En BaseSheetsCrudService.ts
    // En BaseSheetsCrudService.ts
    async save<T extends object>(entity: T): Promise<T> {
        // 1. Asegurar que exista la hoja/cabeceras
        // syncSchema ya se llama en initialize, pero ensureSchema lo valida si es necesario
        await this.ensureSchema();

        // 2. Garantizar ID
        const pk = getPrimaryKeyColumnName(this.EntityClass) || 'id';
        if (!(entity as any)[pk]) {
            (entity as any)[pk] = IdGenerator.generate();
        }

        // 3. Mapeo a Fila (Con tu lógica de casting inteligente y formato Perú)
        const headers = SheetMapper.getColumnHeaders(this.EntityClass);
        const rowValues = SheetMapper.mapToRow(headers, entity);

        // 4. Inserción física
        // IMPORTANTE: Usamos this.sheetName (ej: OBREROS_ACTIVOS)
        await this.persistenceEngine.appendRow(
            this.sheetName, // Tu método appendRow ya conoce el SpreadsheetID internamente
            rowValues
        );

        // 5. Limpieza de caché quirúrgica
        const pkValue = (entity as any)[pk];
        await this.cacheManager.del(`row:${this.sheetName}:${pkValue}`);
        await this.cacheManager.del(`list:${this.sheetName}`);

        return entity;
    }
    // Dentro de tu BaseSheetsCrudService.ts
    async ensureSheetExists(): Promise<void> {
        const sheetName = this.EntityClass.name;
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // 1. Llamamos al método que acabamos de crear
        const metadata = await this.googleSpreadsheetService.getSpreadsheetMetadata();

        // 2. Buscamos si el nombre de nuestra clase existe como pestaña
        const exists = metadata.sheets.some(s => s.properties.title === sheetName);

        if (!exists) {
            this.logger.warn(`Pestaña "${sheetName}" no encontrada. Creándola...`);
            await this.googleSpreadsheetService.createSheet(spreadsheetId, sheetName);
        }
    }

    async initialize(sheetName: string) {
        this.sheetName = sheetName;
        let isNewSheet = false;

        try {
            // Optimización: getSpreadsheetMetadata es más completo que solo traer nombres
            const metadata = await this.googleSpreadsheetService.getSpreadsheetMetadata();
            const existingSheets = metadata.sheets.map(s => s.properties.title);

            if (!existingSheets.includes(this.sheetName)) {
                this.logger.warn(`🚀 Pestaña "${this.sheetName}" no encontrada. Creándola...`);
                await this.googleSpreadsheetService.createSheet(
                    this.optionsDatabase.defaultSpreadsheetId,
                    this.sheetName
                );
                isNewSheet = true;

                // El "respiro" es vital para evitar errores de propagación en Google
                await new Promise(res => setTimeout(res, 1500));
            }

            // Importante: syncSchema debe usar this.sheetName internamente ahora
            await this.persistenceEngine.syncSchema(isNewSheet);

        } catch (error) {
            this.logger.error(`❌ Error en inicialización de ${this.sheetName}: ${error.message}`);
            throw error; // Re-lanzar para que el orquestador sepa que falló
        }
    }

    /**
     * El método estrella: Permite ejecutar pipelines de agregación
     * sobre la colección actual de la hoja de cálculo.
     */
    async aggregate(pipeline: any[]): Promise<any[]> {
        // 1. Obtenemos todos los datos hidratados (pasados por GettersEngine)
        const data = await this.googleSpreadsheetService.findAllRaw();

        // 2. Si no hay datos, devolvemos un arreglo vacío antes de procesar
        if (!data || data.length === 0) return [];

        // 3. Ejecutamos el pipeline a través del motor
        return await this.aggregationEngine.run(data, pipeline);
    }

    // ... Otros métodos (find, create, update, delete)

}