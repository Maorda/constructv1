import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ISheetDataGateway, SheetMetadata } from '@database/interfaces/ISheetDataGateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { RepositoryContext } from '@database/repositories/repository.context';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { MetadataRegistry } from '../metadata.registry';
import { SheetProvisioner } from './sheet.provisioner';
import { SheetsApiClient } from './SheetsApiClient';
import { SheetsPersistenceService } from './SheetsPersistenceService';
import { SheetMetadataOrchestrator } from './SheetMetadataOrchestrator';
import { ClassType } from '@database/types/query.types';

@Injectable()
export class SheetsDataGateway<T extends object> implements ISheetDataGateway {
    private readonly logger = new Logger(SheetsDataGateway.name);
    private isSynced = false;
    private sheetIdCache = new Map<string, number>();
    protected headers: string[] = [];
    public sheetName: string;

    constructor(
        private readonly apiClient: SheetsApiClient,
        private readonly persistence: SheetsPersistenceService,
        private readonly metadataOrchestrator: SheetMetadataOrchestrator,
        private readonly provisioner: SheetProvisioner,
        private readonly sheetMapper: SheetMapper<T>,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly EntityClass: new () => T // Mantiene el token de la clase para introspección
    ) {
        // 1. El nombre se resuelve ÚNICAMENTE mediante metadatos de la clase o su fallback gramatical
        this.sheetName = this.metadataOrchestrator.resolveSheetName(this.EntityClass);

        // 2. Configuramos el scope del servicio de persistencia física
        this.persistence.setSheetName(this.sheetName);

        this.logger.debug(`[Gateway] Inicializado en el fondo del ODM para la pestaña: "${this.sheetName}"`);
    }

    batchGet(ranges: string[]): Promise<any> {
        throw new Error('Method not implemented.');
    }
    getSheetMetadata(sheetName: string): Promise<SheetMetadata> {
        throw new Error('Method not implemented.');
    }
    /**
     * Inicializa el gateway asegurando la integridad de la hoja física
     * y precargando la configuración de la entidad.
     */
    async initialize(entityClass: ClassType<T>): Promise<void> {
        // Guard para evitar inicializaciones redundantes
        if (this.isSynced) {
            this.logger.debug(`[Gateway] El Gateway para ${entityClass.name} ya estaba inicializado.`);
            return;
        }

        try {
            this.logger.log(`[Gateway] 🚀 Iniciando configuración de entorno para: ${entityClass.name}`);

            // 1. Aprovisionamiento: Aseguramos que la pestaña existe en el archivo
            await this.provisioner.ensureSheetExists(entityClass);

            // 2. Sincronización de Esquema: Verificamos cabeceras (usando tu método existente)
            await this.ensureSchema();

            // 3. Inicialización del Mapper: Aseguramos que el mapeador tiene el contexto de la entidad
            // Si tu Mapper no tiene este método, considera añadirlo para cargar metadatos necesarios
            if (this.sheetMapper && typeof (this.sheetMapper as any).initialize === 'function') {
                await (this.sheetMapper as any).initialize(entityClass);
            }

            this.isSynced = true;
            this.logger.log(`[Gateway] ✅ Gateway para ${entityClass.name} listo para operaciones.`);

        } catch (error: any) {
            this.logger.error(`[Gateway] ❌ ERROR CRÍTICO AL INICIALIZAR: ${error.message}`);
            throw error;
        }
    }

    /**
     * 🛡️ GARANTE DE SINCRO-EXISTENCIA (Auto-Aprovisionamiento Atómico)
     */
    private async ensureSheetExists(): Promise<void> {
        if (this.isSynced) return;

        // 1. Espera activa de seguridad del motor
        await this.provisioner.executeActiveWait(this.apiClient, this.sheetName);

        let isNewSheet = false;
        const propagationWait = 5000;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const metadata = await this.provisioner.getSpreadsheetMetadata(this.apiClient);
                const existingSheets = metadata.sheets.map((s: any) => s.properties.title);

                if (!existingSheets.includes(this.sheetName)) {
                    this.logger.warn(`🚀 Intento ${attempt}: Creando pestaña "${this.sheetName}"...`);
                    await this.provisioner.createSheet(this.apiClient, this.sheetName);
                    isNewSheet = true;

                    this.logger.debug(`Esperando ${propagationWait}ms por estabilidad de red...`);
                    await new Promise(res => setTimeout(res, propagationWait));
                }

                await this.sheetMapper.syncSchema(isNewSheet);
                this.isSynced = true;
                this.logger.log(`✅ Infraestructura atómica lista para la pestaña: ${this.sheetName}`);
                return;

            } catch (error: any) {
                this.logger.error(`⚠️ Fallo en intento de provisión ${attempt}/${maxRetries} para ${this.sheetName}: ${error.message}`);
                if (attempt === maxRetries) {
                    throw new Error(`Error fatal de infraestructura tras ${maxRetries} reintentos en la hoja ${this.sheetName}.`);
                }
                await new Promise(res => setTimeout(res, propagationWait * attempt));
            }
        }
    }

    async getSheetId(sheetName: string): Promise<number> {
        if (this.sheetIdCache.has(sheetName)) {
            return this.sheetIdCache.get(sheetName)!;
        }

        const id = await this.provisioner.getSheetIdByName(this.apiClient, sheetName);
        this.sheetIdCache.set(sheetName, id);
        return id;
    }

    async appendRange(range: string, values: any[][]): Promise<any> {
        const response = await this.persistence.appendRows(range, values);
        return response.data;
    }

    async getAllRows(): Promise<any[][]> {
        await this.ensureSheetExists();

        const cacheKey = `sheets_data_${this.sheetName}`;
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) return cachedData;

        try {
            const response = await this.apiClient.execute(async (sheets) => {
                return await sheets.spreadsheets.values.get({
                    spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                    range: `${this.sheetName}!A1:Z`,
                });
            });

            const rows = response.data.values || [];
            if (rows.length > 0) {
                this.headers = rows[0];
            }

            await this.cacheManager.set(cacheKey, rows, 5000);
            return rows;
        } catch (error: any) {
            this.logger.error(`Error al obtener datos de Sheets en pestaña "${this.sheetName}": ${error.message}`);
            throw new InternalServerErrorException(`No se pudo leer la hoja: ${this.sheetName}. Verifica permisos e ID.`);
        }
    }

    async addRow<T>(sheetName: string, entity: T): Promise<void> {
        const row = SheetMapper.entityToRow(entity);
        if (!row || row.length === 0) return;

        await this.persistence.appendRows(`${sheetName}!A1`, [row]);
    }

    async appendRow(rawValues: any): Promise<any> {
        await this.ensureSheetExists();
        await this.getAllRows();

        // Conservamos la inyección inmaculada de mapeo transaccional
        const finalArray = this.sheetMapper.mapEntityToRow(this.headers, rawValues);

        this.logger.debug(`[Append] Escribiendo posicional construido en ${this.sheetName}: ${JSON.stringify(finalArray)}`);

        try {
            const response = await this.persistence.appendRows(`${this.sheetName}!A1`, [finalArray]);

            const updatedRange = response.updates?.updatedRange;
            const matchedRow = updatedRange?.match(/A(\d+):/);
            const physicalRowNumber = matchedRow ? parseInt(matchedRow[1], 10) : undefined;

            this.logger.log(`[Append] Guardado exitoso. Fila física asignada: __row = ${physicalRowNumber}`);

            await this.cacheManager.del(`sheets_data_${this.sheetName}`);

            return {
                ...rawValues,
                __row: physicalRowNumber
            };
        } catch (error: any) {
            this.logger.error(`Error crítico en appendRow para ${this.sheetName}: ${error.message}`);
            throw new InternalServerErrorException(`Fallo físico de escritura append en Google Sheets.`);
        }
    }

    async updateRow<T>(rowIndex: number, data: T): Promise<T> {
        const range = `${this.sheetName}!A${rowIndex}`;
        const rowValues = this.mapObjectToRowArray(data);

        await this.persistence.updateRange(range, [rowValues]);
        return data;
    }

    async updateRange(range: string, values: any[][]): Promise<void> {
        await this.persistence.updateRange(range, values);
    }

    async updateCellsBatch(data: any[]): Promise<void> {
        await this.persistence.updateCellsBatch(data);
    }

    async deleteRow(spreadsheetId: string, sheetId: number | string, rowId: string | number): Promise<void> {
        // 1. Conversión e interpretación segura de los parámetros dinámicos del ODM
        const parsedSheetId = typeof sheetId === 'string' ? parseInt(sheetId, 10) : sheetId;
        const parsedRowIndex = typeof rowId === 'string' ? parseInt(rowId, 10) : rowId;

        // 2. Validación defensiva estricta antes de impactar la infraestructura física
        if (isNaN(parsedSheetId) || isNaN(parsedRowIndex)) {
            this.logger.error(`[Gateway] Parámetros inválidos provistos para deleteRow. sheetId: ${sheetId}, rowId: ${rowId}`);
            throw new Error('No se puede ejecutar la eliminación física de la dimensión con índices inválidos.');
        }

        // 3. Delegación limpia a la persistencia agnóstica (el servicio maneja internamente su propio SPREADSHEET_ID)
        await this.persistence.deleteRow(parsedSheetId, parsedRowIndex);

        // 4. Invalida inmediatamente la caché local para garantizar consistencia en la próxima lectura
        await this.cacheManager.del(`sheets_data_${this.sheetName}`);

        this.logger.log(`[Gateway] Fila física ${parsedRowIndex} eliminada y caché invalidada en: ${this.sheetName}`);
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

    async ensureSchema(): Promise<void> {
        if (this.isSynced) return;
        await this.sheetMapper.syncSchema();
        this.isSynced = true;
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

    async updateRowRaw(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
        if (!values || values.length === 0) return;
        await this.persistence.updateRange(range, values);
    }

    private mapObjectToRowArray<T>(data: T): any[] {
        // Delegación directa pasando únicamente la entidad y los headers frescos en caché o cargados
        return this.metadataOrchestrator.mapObjectToRowArray(data, this.headers);

    }
}