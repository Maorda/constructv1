import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ISheetDataGateway, SheetMetadata } from '@database/interfaces/ISheetDataGateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ClassType } from '@database/types/query.types';
import { SheetEntityBinder } from '@database/engines/shereUtilsEngine/SheetEntityBinder';
import { SheetMetadataOrchestrator } from './SheetMetadataOrchestrator';
import { SheetsApiClient } from '@database/services/sheetDataGateway/SheetsApiClient';
import { SheetsPersistenceService } from '@database/services/sheetDataGateway/SheetsPersistenceService';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { SheetProvisioner } from './sheet.provisioner';
import { withRetry } from '@database/utils/tools';
import { RelationOptions } from '@database/decorators/relation.sub.collections.decorator';
import { SheetSchemaManager } from './SheetSchemaManager';
import { ColumnOptions } from '@database/decorators/column.decorator';

@Injectable()
export class SheetsDataGateway<T extends object> implements ISheetDataGateway<T> {
    private isInitialized = false;
    private readonly logger = new Logger(SheetsDataGateway.name);

    public EntityClass!: ClassType<T>;
    public sheetName!: string;
    protected headers: string[] = [];

    constructor(
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions,
        private readonly apiClient: SheetsApiClient,
        private readonly persistence: SheetsPersistenceService,
        private readonly metadataOrchestrator: SheetMetadataOrchestrator,
        private readonly provisioner: SheetProvisioner,
        // 🔒 Integración del Binder ya refactorizado
        private readonly binder: SheetEntityBinder,
        private readonly schemaManager: SheetSchemaManager
    ) { }


    /**
     * Guardia de inicialización: Se asegura de que el mapper 
     * esté listo antes de ejecutar cualquier lógica de datos.
     */
    public async initialize(EntityClass: ClassType<T>): Promise<void> {
        if (this.isInitialized) return;

        this.EntityClass = EntityClass;
        this.sheetName = this.metadataOrchestrator.resolveSheetName(EntityClass);
        await this.metadataOrchestrator.syncSchema(this.apiClient, this.sheetName, EntityClass);
        this.headers = await this.metadataOrchestrator.getHeaders(EntityClass);

        this.isInitialized = true;
        this.logger.log(`[Gateway 🚀] Inicializado: ${EntityClass.name}`);
    }


    public async getRawRows(sheetName: string): Promise<any[][]> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const cacheKey = `sheet_data:${spreadsheetId}:${sheetName}`;

        // 1. Intentar obtener del caché
        const cached = await this.cacheManager.get<any[][]>(cacheKey);
        if (cached) return cached;

        // 2. Si no hay caché, pedir al PersistenceService
        // Nota: Usamos el servicio de persistencia directamente, encapsulando la lógica de I/O
        const rows = await this.persistence.readRange(`${sheetName}!A:Z`);

        // 3. Manejo de caché con TTL
        if (rows && rows.length > 0) {
            await this.cacheManager.set(cacheKey, rows, 300);
        }

        return rows || [];
    }
    /**
     * 🛡️ GARANTE DE SINCRO-EXISTENCIA (Auto-Aprovisionamiento Atómico)
     */


    public async getSheetId(sheetName: string): Promise<number> {
        this.ensureInitialized();

        const cacheKey = `sheet_id_${sheetName}`;

        // 1. Verificar consistencia en la caché centralizada
        const cachedId = await this.cacheManager.get<number>(cacheKey);
        if (cachedId !== undefined && cachedId !== null) {
            return cachedId;
        }

        try {
            // 2. Delegación limpia al especialista en infraestructura (Nivel 2)
            // NOTA: Si modificas la firma de getSheetIdByName en tu provisioner para usar
            // su propio apiClient interno, podrías remover el parámetro "this.apiClient" de aquí.
            const sheetId = await this.provisioner.getSheetIdByName(this.apiClient, sheetName);

            // 3. Guardar en caché por 24 horas (los IDs de las pestañas son inmutables en tiempo de ejecución)
            await this.cacheManager.set(cacheKey, sheetId, 86400000);

            return sheetId;
        } catch (error: any) {
            this.logger.error(`[Gateway] No se pudo resolver el ID para la hoja "${sheetName}": ${error.message}`);
            throw new Error(`Fallo de infraestructura al mapear la dimensión física de la hoja.`);
        }
    }

    async appendRange(range: string, values: any[][]): Promise<any> {
        const response = await this.persistence.appendRows(range, values);
        return response.data;
    }





    /**
     * 🔄 ACTUALIZACIÓN FÍSICA: Sobrescribe una fila existente en la hoja.
     * [REFACTORIZADO]: Alineado con el Binder de Nivel 3 y control de caché.
     */
    public async updateRow(rowIndex: number, entity: T): Promise<void> {
        this.ensureInitialized();

        // 1. Delegamos el mapeo al Binder usando las cabeceras en memoria
        const rowValues = this.binder.mapEntityToRow(entity, this.headers, this.EntityClass);

        // Validación defensiva
        if (!rowValues || rowValues.length === 0) {
            this.logger.warn(`[Gateway] Intento de actualizar con entidad vacía en ${this.sheetName}, fila ${rowIndex}. Abortando.`);
            return;
        }

        // 2. Definimos el rango exacto de inserción
        // Al usar '!A{Index}', Sheets expandirá automáticamente a la derecha según el tamaño del array
        const range = `${this.sheetName}!A${rowIndex}`;

        try {
            // 3. Ejecución de I/O
            await this.persistence.updateRange(range, [rowValues]);

            this.logger.log(`[Gateway] Actualización exitosa en ${this.sheetName}, fila física: ${rowIndex}`);

            // 4. Mantenimiento de la consistencia de datos
            await this.cacheManager.del(`sheet_data_${this.sheetName}`);

        } catch (error: any) {
            this.logger.error(`[Gateway] Error crítico al actualizar la fila ${rowIndex} en ${this.sheetName}: ${error.message}`);
            throw new Error(`Fallo de I/O al intentar actualizar la fila física en Google Sheets.`);
        }
    }

    async updateRange(range: string, values: any[][]): Promise<void> {
        await this.persistence.updateRange(range, values);
    }

    async updateCellsBatch(data: any[]): Promise<void> {
        await this.persistence.updateCellsBatch(data);
    }

    /**
      * 🗑️ ELIMINACIÓN FÍSICA: Borra una fila de Google Sheets.
      * [REFACTORIZADO]: Totalmente encapsulado. El Gateway resuelve su propio sheetId.
      */
    public async deleteRow(rowIndex: number | string): Promise<void> {
        // 0. Seguridad de contexto
        this.ensureInitialized();

        // 1. Conversión y validación defensiva estricta (solo de la fila)
        const parsedRowIndex = typeof rowIndex === 'string' ? parseInt(rowIndex, 10) : rowIndex;

        // Las filas en Sheets empiezan en 1. Prevenimos intentos de borrar cabeceras o índices nulos.
        if (isNaN(parsedRowIndex) || parsedRowIndex <= 1) {
            this.logger.error(`[Gateway] Índice de fila inválido provisto para deleteRow: ${rowIndex}`);
            throw new Error('No se puede ejecutar la eliminación física con un índice de fila inválido o protegido.');
        }

        try {
            // 2. 🚀 MAGIA DE ENCAPSULACIÓN: El Gateway obtiene su propio sheetId físico
            // Delega la lectura de caché/infraestructura al método que refactorizamos antes.
            const sheetId = await this.getSheetId(this.sheetName);

            // 3. Impacto en la persistencia agnóstica
            await this.persistence.deleteRow(sheetId, parsedRowIndex);

            // 4. Invalida inmediatamente la caché local para garantizar consistencia
            // OJO: Ajusté el nombre de la caché para que coincida con el estándar 'sheet_data_'
            await this.cacheManager.del(`sheet_data_${this.sheetName}`);

            this.logger.log(`[Gateway] Fila física ${parsedRowIndex} eliminada y caché invalidada en: ${this.sheetName}`);
        } catch (error: any) {
            this.logger.error(`[Gateway] Error crítico al borrar la fila ${parsedRowIndex} en ${this.sheetName}: ${error.message}`);
            throw new Error(`Fallo de I/O al intentar eliminar la dimensión física en Google Sheets.`);
        }
    }

    async clearRow(physicalRow: number): Promise<void> {
        await this.persistence.clearRow(this.sheetName, physicalRow);
    }

    async getHeaders(): Promise<string[]> {
        const cacheKey = `headers_strict:${this.EntityClass.name}`;
        const cached = await this.cacheManager.get<string[]>(cacheKey);
        if (Array.isArray(cached) && cached.length > 0) return cached;

        const headers = await this.metadataOrchestrator.getHeaders(this.EntityClass);
        await this.cacheManager.set(cacheKey, headers, 3600000);
        return headers;
    }



    async updateSheet(spreadsheetId: string, sheetName: string, rows: any[][]): Promise<void> {
        try {
            await this.apiClient.execute(async (sheets) => {
                await sheets.spreadsheets.values.clear({
                    spreadsheetId,
                    range: `${sheetName}!A:ZZ`,
                });
            });

            await this.persistence.updateRange(`${sheetName}!A1`, rows);
            this.logger.log(`Hoja '${sheetName}' sincronizada globalmente con éxito.`);
        } catch (error: any) {
            this.logger.error(`Error en updateSheet global: ${error.message}`);
            throw error;
        }
    }

    async updateRowRaw(range: string, values: any[][]): Promise<void> {
        if (!values || values.length === 0) return;
        await this.persistence.updateRange(range, values);
    }



    async getByQuery(): Promise<T[]> {
        // 1. Aseguramos inicialización (esquema + mapper)
        await this.ensureInitialized();

        // 2. Leemos la data cruda desde Google Sheets
        // Asumimos que quieres leer toda la hoja o un rango específico
        const rawRows = await this.persistence.readRange(`${this.sheetName}!A:Z`);

        // 3. Obtenemos headers (puedes cachearlos para no llamar a la API cada vez)
        const headers = await this.getHeaders();

        // 4. Mapeamos todas las filas a entidades
        // Accedemos al binder a través del mapper o directamente si lo prefieres
        return this.binder.mapRowsToEntities(headers, rawRows, this.EntityClass);
    }
    public async updatePartialRow(rowIndex: number, partialData: Partial<T>): Promise<void> {
        this.ensureInitialized();

        // 1. Leer fila actual
        const range = `${this.sheetName}!A${rowIndex}:Z${rowIndex}`;
        const rawRows = await this.persistence.readRange(range);

        if (!rawRows || rawRows.length === 0) {
            throw new Error(`Fila ${rowIndex} no encontrada.`);
        }

        // 2. Usar el nuevo Binder para convertir la fila a Entidad
        // Ya no necesitamos inyectar dependencias extra, el Binder las tiene internamente
        const existingEntity = this.binder.mapFromRow(this.headers, rawRows[0], this.EntityClass);

        // 3. Fusión
        const mergedEntity = { ...existingEntity, ...partialData };

        // 4. Usar el nuevo Binder para convertir la entidad modificada a fila
        const fullRowArray = this.binder.mapEntityToRow(mergedEntity, this.headers, this.EntityClass);

        // 5. Persistir
        await this.persistence.updateRange(range, [fullRowArray]);
        await this.cacheManager.del(`sheet_data_${this.sheetName}`);
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error(`Gateway no inicializado.`);
        }
    }

    /**
     * 📝 ESCRITURA FÍSICA: Inserta una nueva entidad al final de la hoja.
     * Fusión optimizada de addRow y appendRow.
     * [SE QUEDA EN GATEWAY]
     */
    public async insertEntity(entity: T): Promise<number> {
        this.ensureInitialized();

        // 1. Delegamos el mapeo al Binder (Nivel 3) usando las cabeceras en memoria
        const fullRowArray = this.binder.mapEntityToRow(entity, this.headers, this.EntityClass);

        // Validación de seguridad defensiva
        if (!fullRowArray || fullRowArray.length === 0) {
            this.logger.warn(`[Gateway] Intento de insertar una entidad vacía en ${this.sheetName}. Abortando.`);
            return -1;
        }

        try {
            // 2. Persistencia física
            // Usamos '!A1' para que la API de Sheets encuentre automáticamente la siguiente fila vacía
            const response = await this.persistence.appendRows(`${this.sheetName}!A1`, [fullRowArray]);

            // 3. Extracción Atómica de Metadatos Físicos (El ID de la Fila)
            const updatedRange = response.updates?.updatedRange;

            // Extrae el número de fila del rango (ej. "Hoja1!A15:Z15" -> extrae "15")
            // Usamos /A(\d+)/ para que funcione incluso si la hoja tiene una sola columna
            const matchedRow = updatedRange?.match(/A(\d+)/);
            const physicalRowNumber = matchedRow ? parseInt(matchedRow[1], 10) : -1;

            this.logger.log(`[Gateway] Inserción exitosa en ${this.sheetName}. Fila física asignada: ${physicalRowNumber}`);

            // 4. Invalidación de caché local estandarizada
            await this.cacheManager.del(`sheet_data_${this.sheetName}`);

            // 5. Retornamos estrictamente el metadato físico
            return physicalRowNumber;

        } catch (error: any) {
            this.logger.error(`[Gateway] Error crítico de inserción (append) en ${this.sheetName}: ${error.message}`);
            // Lanzamos un error estándar que tu manejador global pueda interpretar
            throw new Error(`Fallo de I/O al intentar añadir una fila en Google Sheets.`);
        }
    }

    public async getAllRaw(): Promise<any[][]> {
        this.ensureInitialized();

        try {
            // 1. Optimización del Payload: 
            // Calculamos la última columna física en base a la longitud de las cabeceras.
            // Si hay 5 propiedades, lee de A hasta E. Si hay 30, de A hasta AD.
            const lastColumnIndex = Math.max(0, this.headers.length - 1);
            const lastColumnLetter = this.indexToColumnLetter(lastColumnIndex);

            // 2. Construcción del rango dinámico
            const range = `${this.sheetName}!A:${lastColumnLetter}`;

            this.logger.debug(`[Gateway] Fetching raw data con rango optimizado: ${range}`);

            // 3. Ejecución de I/O
            const rawRows = await this.persistence.readRange(range);

            // 4. Validación de seguridad (Google Sheets API devuelve undefined si está vacío)
            if (!rawRows || rawRows.length === 0) {
                return [];
            }

            return rawRows;

            /* 💡 NOTA ARQUITECTÓNICA: 
               Si deseas que el Gateway devuelva SOLO los datos y omita 
               la fila 1 (que son las cabeceras físicas), puedes retornar:
               return rawRows.slice(1); 
            */

        } catch (error: any) {
            this.logger.error(`[Gateway] Error al leer los datos crudos de "${this.sheetName}": ${error.message}`);
            throw new Error(`Fallo de I/O de lectura masiva en la pestaña física: ${this.sheetName}.`);
        }
    }

    /**
     * 🛠️ Helper de Infraestructura:
     * Convierte un índice numérico (0, 1, 26) en letras de columna de Excel/Sheets (A, B, AA)
     */
    private indexToColumnLetter(index: number): string {
        let temp, letter = '';
        while (index >= 0) {
            temp = index % 26;
            letter = String.fromCharCode(temp + 65) + letter;
            index = (index - temp) / 26 - 1;
        }
        return letter;
    }

    // En SheetsDataGateway.ts

    public async getAllEntities<T extends object>(entityClass: ClassType<T>): Promise<T[]> {
        try {
            // 1. I/O: Delegamos la lectura bruta al PersistenceService
            // Usamos el rango completo de la hoja para garantizar consistencia.
            const rawData = await this.persistence.readRange(`${this.sheetName}!A:Z`);

            // 2. Validación de datos: Si no hay filas de datos, retornamos array vacío
            if (!rawData || rawData.length <= 1) {
                return [];
            }

            // 3. Separación de cabeceras y filas de datos
            // Usamos desestructuración para un código más limpio y eficiente
            const [headers, ...rows] = rawData;

            // 4. Transformación: Mapeo de filas a entidades con inyección de metadatos
            return rows.map((row, index) => {
                // Utilizamos el Binder para la transformación basada en esquemas
                const entity = this.binder.mapFromRow(headers, row, entityClass);

                /**
                 * INYECCIÓN DE METADATO CRÍTICO
                 * El Binder transforma los datos, pero el Gateway es quien conoce 
                 * la posición física en el archivo (vital para el Update parcial).
                 * index 0 -> Fila 2 de la hoja.
                 */
                (entity as any).__row = index + 2;

                return entity;
            });

        } catch (error) {
            this.logger.error(`Error en getAllEntities para ${this.sheetName}: ${error.message}`);
            throw error;
        }
    }
    // En SheetsDataGateway.ts

    public async getEntitiesWithResilience<T extends object>(entityClass: ClassType<T>): Promise<T[]> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const cacheKey = `sheet_data:${spreadsheetId}:${this.sheetName}`;
        const emergencyKey = `emergency_data:${spreadsheetId}:${this.sheetName}`;

        // 1. Intentar caché rápida
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) {
            return this.parseRowsToEntities(cachedData, entityClass);
        }

        try {
            // 2. Intentar fetch fresco
            const freshData = await withRetry(async () => {
                return await this.persistence.readRange(`${this.sheetName}!A:Z`);
            }, 3, 1000);

            if (!freshData || freshData.length <= 1) {
                return [];
            }

            // 3. Persistir caché y emergencia
            await this.cacheManager.set(cacheKey, freshData, 10000);
            await this.cacheManager.set(emergencyKey, freshData, 24 * 60 * 60 * 1000);

            return this.parseRowsToEntities(freshData, entityClass);

        } catch (error) {
            // 4. Capa de Emergencia
            this.logger.error(`Error crítico en Sheets. Intentando usar respaldo...`);
            const emergencyData = await this.cacheManager.get<any[][]>(emergencyKey);

            if (emergencyData) {
                this.logger.warn(`Operando en MODO EMERGENCIA para: ${this.sheetName}`);
                return this.parseRowsToEntities(emergencyData, entityClass);
            }
            throw new InternalServerErrorException(`Fallo total de conexión para ${this.sheetName}.`);
        }
    }

    // Método auxiliar privado para no repetir lógica
    private parseRowsToEntities<T extends object>(rawData: any[][], entityClass: ClassType<T>): T[] {
        const [headers, ...rows] = rawData;
        return rows.map((row, index) => {
            const entity = this.binder.mapFromRow(headers, row, entityClass);
            (entity as any).__row = index + 2;
            return entity;
        });
    }
    public async clearCache(): Promise<void> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const cacheKey = `sheet_data:${spreadsheetId}:${this.sheetName}`;

        await this.cacheManager.del(cacheKey);
        this.logger.log(`Caché invalidado en Gateway para la hoja: ${this.sheetName}`);
    }

    // En SheetsDataGateway.ts

    // En SheetsDataGateway.ts

    public async getRelatedEntities<R extends object>(
        options: RelationOptions,
        localValue: any,
        TargetClass: ClassType<R> // Aquí recibes la clase de la relación
    ): Promise<R[] | R | null> {

        // 1. Obtener los datos crudos
        const rawRelData = await this.persistence.readRange(`${options.targetSheet}!A:Z`);

        if (!rawRelData || rawRelData.length <= 1) {
            return options.isMany ? [] : null;
        }

        const [headers, ...dataRows] = rawRelData;
        const normalize = (val: any) => String(val ?? '').trim();

        // 2. Localizar columna de unión
        const joinColIndex = headers.findIndex(h =>
            h?.toString().trim().toLowerCase() === options.joinColumn.toLowerCase()
        );

        if (joinColIndex === -1) {
            this.logger.error(`JoinColumn "${options.joinColumn}" no existe en la hoja "${options.targetSheet}"`);
            return options.isMany ? [] : null;
        }

        // 3. Filtrar
        const filteredRows = dataRows.filter(row =>
            normalize(row[joinColIndex]) === normalize(localValue)
        );

        // 4. Mapeo Correcto (Usando TargetClass en lugar de this.EntityClass)
        if (options.isMany) {
            return filteredRows.map(row => {
                const physicalIndex = rawRelData.indexOf(row) + 1;
                // Usamos TargetClass (R) y el Binder ahora acepta R
                return this.binder.mapRowToEntityWithIndex(headers, row, TargetClass, physicalIndex);
            });
        } else {
            if (filteredRows.length === 0) return null;

            const physicalIndex = rawRelData.indexOf(filteredRows[0]) + 1;
            // Usamos TargetClass (R)
            return this.binder.mapRowToEntityWithIndex(headers, filteredRows[0], TargetClass, physicalIndex);
        }
    }

    // En SheetsDataGateway.ts

    /**
 * Localiza el índice físico de una fila (1-based) en la hoja de Google Sheets.
 * Utiliza SchemaManager para desacoplar el nombre de la propiedad en TS 
 * del nombre físico de la columna en Google Sheets (definido en ColumnOptions).
 */
    public async findRowIndex(id: string | number): Promise<number> {
        // 1. I/O: Lectura del rango físico
        const rawData = await this.persistence.readRange(`${this.sheetName}!A:Z`);
        if (!rawData || rawData.length <= 1) return -1;

        const [headers, ...dataRows] = rawData;

        // 2. Obtención de metadatos desde ColumnOptions
        const pkProp = this.schemaManager.getPrimaryKey(this.EntityClass);
        const pkOptions: ColumnOptions = this.schemaManager.getColumnDetails(this.EntityClass)[pkProp];

        // El nombre físico es o el 'name' definido en ColumnOptions, o el nombre de la prop
        const pkHeaderName = pkOptions?.name || pkProp;

        // 3. Localización de la columna en las cabeceras reales
        const colIndex = headers.findIndex(h =>
            h?.toString().trim().toLowerCase() === pkHeaderName.toLowerCase()
        );

        if (colIndex === -1) {
            this.logger.warn(`No se pudo encontrar la columna PK "${pkHeaderName}" (definida como ${pkProp}) en la hoja "${this.sheetName}"`);
            return -1;
        }

        // 4. Búsqueda normalizada
        const targetId = String(id ?? '').trim();
        const foundIndex = dataRows.findIndex(row =>
            String(row[colIndex] ?? '').trim() === targetId
        );

        // 5. Retorno del índice físico (0-based findIndex + 1 de headers + 1 de base 1)
        return foundIndex !== -1 ? foundIndex + 2 : -1;
    }
}