import { Inject, Injectable, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleSpreedsheetService } from '../services/google.spreedsheet.service';
import { SheetMapper } from '../mappers/sheet.mapper';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { TABLE_NAME_KEY } from '../decorators/table.decorator';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager'; // <--- AMBOS desde aquí

@Injectable()
export abstract class BaseSheetsRepository<T extends object> {
    private isSynced = false; // Flag para no repetir el proceso

    protected abstract readonly EntityClass: new () => T;
    protected readonly logger = new Logger(this.constructor.name);
    @Inject(CACHE_MANAGER) private cacheManager: Cache

    @Inject(GoogleSpreedsheetService)
    protected readonly googleSheets: GoogleSpreedsheetService;

    public sheetName: string;

    constructor(

        @Inject('DATABASE_OPTIONS') protected readonly options: DatabaseModuleOptions,
    ) { }

    // src/database/repositories/base.sheets.repository.ts

    async initialize(sheetName: string) {
        this.sheetName = sheetName;
        let isNewSheet = false;

        try {
            const existingSheets = await this.googleSheets.getExistingSpreadsheetSheets(this.spreadsheetId);

            if (!existingSheets.includes(this.sheetName)) {
                this.logger.warn(`🚀 Pestaña "${this.sheetName}" no encontrada. Creándola...`);
                await this.googleSheets.createSheet(this.spreadsheetId, this.sheetName);
                isNewSheet = true;

                // Aumentamos a 1.5 segundos el respiro para Google
                await new Promise(res => setTimeout(res, 1500));
            }

            // Pasamos el flag isNewSheet para forzar la escritura
            await this.syncSchema(isNewSheet);

        } catch (error) {
            this.logger.error(`❌ Error en inicialización de ${this.sheetName}: ${error.message}`);
        }
    }

    // src/database/repositories/base.sheets.repository.ts

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
                const response = await this.googleSheets.getValues(this.spreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }

            // Comparamos normalizando
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) => String(currentHeaders[i] || '').trim().toUpperCase() !== h);

            if (isDesync) {
                this.logger.warn(`✍️ Escribiendo cabeceras en "${this.sheetName}"...`);

                // DIAGNÓSTICO 2: Verificamos antes de disparar la API
                console.log(`Enviando a Google -> SpreadsheetId: ${this.spreadsheetId}, Range: ${this.sheetName}!A1`);

                await this.googleSheets.updateRow(
                    this.spreadsheetId,
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

    // src/database/repositories/base.sheets.repository.ts

    private async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.syncSchema();
        this.isSynced = true;
    }


    /**
     * Compara dos arrays de cabeceras de forma tolerante (sin espacios y en mayúsculas)
     */
    private checkDesync(expected: string[], current: any[]): boolean {
        // Si tienen diferente longitud, definitivamente están desincronizados
        if (expected.length !== current.length) return true;

        // Comparamos elemento por elemento normalizando el texto
        return expected.some((header, index) => {
            const normalize = (val: any) => String(val || '').trim().toUpperCase();
            return normalize(header) !== normalize(current[index]);
        });
    }

    /**
   * Actualiza un registro por un identificador (ej: DNI)
   */
    async update(identifierColumn: string, value: any, partialEntity: Partial<T>): Promise<T> {
        await this.ensureSchema();

        const range = `${this.sheetName}!A:Z`;
        const rows = await this.googleSheets.getValues(this.spreadsheetId, range);
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
        await this.googleSheets.updateRow(this.spreadsheetId, `${this.sheetName}!A${rowIndex + 1}`, [updatedRow]);
        return updatedData;
    }


    /**
     * Obtiene el ID del spreadsheet (usa el por defecto o el de env)
     */
    protected get spreadsheetId(): string {
        const id = this.options.defaultSpreadsheetId || process.env.SPREADSHEET_ID;
        if (!id) throw new Error(`No se encontró SPREADSHEET_ID para ${this.sheetName}`);
        return id;
    }

    /**
     * Busca un registro por una columna y valor específico
     */
    async findOneByColumn(columnName: string, value: any): Promise<T | null> {
        await this.ensureSchema();
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return null;

        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(columnName);

        if (colIndex === -1) {
            this.logger.error(`La columna "${columnName}" no existe en la pestaña "${this.sheetName}"`);
            return null;
        }

        const foundRow = rows.slice(1).find(row => String(row[colIndex]) === String(value));
        return foundRow ? SheetMapper.mapToEntity(headers, foundRow, this.EntityClass) : null;
    }

    /**
   * Carga relaciones de forma inteligente (Uno a Uno o Uno a Muchos)
   */
    async populate(entity: T, relationName: keyof T): Promise<T> {
        await this.ensureSchema();
        const options: RelationOptions = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            this.EntityClass.prototype,
            relationName as string
        );

        if (!options) {
            this.logger.warn(`Propiedad "${String(relationName)}" no es una relación válida.`);
            return entity;
        }

        // 1. Obtener los datos de la pestaña destino
        const relRows = await this.googleSheets.getValues(this.spreadsheetId, `${options.targetSheet}!A:Z`);
        if (!relRows || relRows.length <= 1) {
            entity[relationName] = (options.isMany ? [] : null) as any;
            return entity;
        }

        const headers = relRows[0] as string[];
        const joinColIndex = headers.indexOf(options.joinColumn);
        const localValue = entity[options.localField];
        const TargetClass = options.targetEntity();

        if (joinColIndex === -1) {
            this.logger.error(`Columna de unión "${options.joinColumn}" no existe en "${options.targetSheet}"`);
            return entity;
        }

        // 2. Filtrar o buscar según el tipo de relación (isMany)
        const dataRows = relRows.slice(1);

        if (options.isMany) {
            // Caso: Uno a Muchos (ej: Empleado -> Adelantos[])
            const relatedEntities = dataRows
                .filter(row => String(row[joinColIndex]) === String(localValue))
                .map(row => SheetMapper.mapToEntity(headers, row, TargetClass));

            entity[relationName] = relatedEntities as any;
        } else {
            // Caso: Uno a Uno (ej: Adelanto -> Empleado)
            const foundRow = dataRows.find(row => String(row[joinColIndex]) === String(localValue));

            entity[relationName] = foundRow
                ? SheetMapper.mapToEntity(headers, foundRow, TargetClass) as any
                : null;
        }

        return entity;
    }

    /**
     * Inserta un nuevo registro mapeando la entidad a una fila de Excel
     */
    /*async create(entity: T): Promise<void> {
        try {
            await this.ensureSchema();
            // Generamos una llave única para esta pestaña (ej: "headers:OBREROS")
            const cacheKey = `headers:${this.sheetName}`;
            // 1. Intentar obtener de la caché
            let headers = await this.cacheManager.get<string[]>(cacheKey);
            if (!headers) {
                this.logger.debug(`[Cache Miss] Solicitando cabeceras para ${this.sheetName} a Google...`);
                const response = await this.googleSheets.getValues(
                    this.spreadsheetId,
                    `${this.sheetName}!A1:Z1`
                );
                if (!response || response.length === 0) {
                    throw new Error(`La hoja ${this.sheetName} no tiene cabeceras.`);
                }
                headers = response[0] as string[];
                // 2. Guardar en la caché
                await this.cacheManager.set(cacheKey, headers);
            } else {
                this.logger.debug(`[Cache Hit] Cabeceras recuperadas de memoria para ${this.sheetName}`);
            }
            // 3. Mapear e Insertar
            const newRow = SheetMapper.mapToRow(headers, entity);
            await this.googleSheets.appendRow(this.spreadsheetId, this.sheetName, newRow);
        } catch (error) {
            this.logger.error(`Error al crear registro: ${error.message}`);
            throw error;
        }
    }*/
    // src/database/repositories/base.sheets.repository.ts

    async create(entity: T): Promise<void> {
        try {
            // 1. Verificamos que la tabla exista (asegura el plural y las cabeceras)
            await this.ensureSchema();

            // --- SECCIÓN DE CACHÉ DE CABECERAS ---
            const headersKey = `headers:${this.sheetName}`;
            let headers = await this.cacheManager.get<string[]>(headersKey);

            if (!headers) {
                this.logger.debug(`[Cache Miss] Recuperando cabeceras para ${this.sheetName} desde Google`);

                const response = await this.googleSheets.getValues(
                    this.spreadsheetId,
                    `${this.sheetName}!A1:Z1`,
                );

                if (!response || response.length === 0) {
                    throw new Error(`La hoja ${this.sheetName} no tiene cabeceras definidas.`);
                }

                headers = response[0] as string[];
                // Guardamos las cabeceras en caché (puedes omitir el TTL para que sea indefinido)
                await this.cacheManager.set(headersKey, headers);
            }

            // --- SECCIÓN DE INSERCIÓN ---
            // Mapeamos la entidad (objeto JS) a una fila (Array) usando las cabeceras
            const newRow = SheetMapper.mapToRow(headers, entity);

            await this.googleSheets.appendRow(
                this.spreadsheetId,
                this.sheetName,
                newRow,
            );

            // --- SECCIÓN DE INVALIDACIÓN DE CACHÉ ---
            // Borramos la caché de la lista completa (findAll) 
            // para que la próxima lectura traiga el nuevo registro insertado.
            const listKey = `list:${this.sheetName}`;
            await this.cacheManager.del(listKey);

            this.logger.log(`✅ Registro creado con éxito en "${this.sheetName}" e invalidada la caché de lectura.`);

        } catch (error) {
            this.logger.error(`❌ Fallo en create (${this.sheetName}): ${error.message}`);
            throw error;
        }
    }
    /**
   * Método para forzar la actualización si cambiaste el Excel manualmente
   */
    async refreshHeaders(): Promise<void> {
        await this.cacheManager.del(`headers:${this.sheetName}`);
        this.logger.log(`Caché de cabeceras para ${this.sheetName} eliminada.`);
    }
    /**
   * Busca registros de un DNI dentro de un rango de fechas.
   * Asume que la entidad tiene las propiedades 'dni' y 'fecha'.
   */
    async findRange(dni: string, fechaInicio: string, fechaFin: string): Promise<T[]> {
        const todos = await this.findAll();

        return todos.filter((item: any) => {
            const cumpleDni = item.dni === dni;
            const cumpleFecha = item.fecha >= fechaInicio && item.fecha <= fechaFin;
            return cumpleDni && cumpleFecha;
        });
    }
    // src/database/repositories/base.sheets.repository.ts

    async findAll(): Promise<T[]> {
        const cacheKey = `list:${this.sheetName}`;

        // 1. Intentar obtener de caché
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        // 2. Si no hay, consultar Google
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapear de filas a objetos usando la clase de la entidad
        const EntityClass = (this as any).EntityClass;
        const entities = dataRows.map(row => SheetMapper.mapFromRow(headers, row, EntityClass));

        // 4. Guardar en caché
        await this.cacheManager.set(cacheKey, entities);
        return entities;
    }

    async findById(id: string | number): Promise<T | null> {
        const cacheKey = `item:${this.sheetName}:${id}`;

        // 1. Buscar en caché individual
        const cached = await this.cacheManager.get<T>(cacheKey);
        if (cached) return cached;

        // 2. Si no está, buscar en la lista completa (que aprovecha su propia caché)
        const all = await this.findAll();

        // Buscamos el elemento. Nota: Asegúrate de que tu entidad tenga un campo 'id'
        const item = all.find(e => (e as any).id == id) || null;

        if (item) {
            await this.cacheManager.set(cacheKey, item);
        }

        return item;
    }
}