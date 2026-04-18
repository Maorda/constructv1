// persistence.manager.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { GoogleSpreedsheetService } from '../services/google.spreedsheet.service';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';

@Injectable()
export class PersistenceEngine {
    private readonly logger = new Logger(PersistenceEngine.name);

    constructor(
        private readonly googleSheets: GoogleSpreedsheetService,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions
    ) { }
    /**
      * Obtiene los datos de la hoja optimizando las llamadas mediante caché.
      * TTL sugerido: 10 segundos para procesos rápidos, o más según tu necesidad.
      */
    async getOrFetchSheet(sheetName: string): Promise<any[][] | null> {
        const cacheKey = `sheet_data:${this.options.defaultSpreadsheetId}:${sheetName}`;
        // 1. Intentar obtener del caché
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) return cachedData;
        // 2. Si no hay caché, pedir a Google Sheets
        const freshData = await this.googleSheets.getValues(
            this.options.defaultSpreadsheetId,
            `${sheetName}!A:Z`
        );
        if (freshData && freshData.length > 0) {
            // 3. Guardar en caché (ejemplo: 10 segundos)
            await this.cacheManager.set(cacheKey, freshData, 10000);
        }
        return freshData;
    }
    /**
     * Obtiene solo las cabeceras de forma eficiente.
     */
    async getHeaders(sheetName: string): Promise<string[]> {
        const cacheKey = `headers:${this.options.defaultSpreadsheetId}:${sheetName}`;
        const cached = await this.cacheManager.get<string[]>(cacheKey);
        if (cached) return cached;
        const rows = await this.googleSheets.getValues(this.options.defaultSpreadsheetId, `${sheetName}!1:1`);
        const headers = (rows && rows[0]) ? rows[0] as string[] : [];
        if (headers.length === 0) {
            throw new Error(`No se encontraron encabezados en la pestaña: ${sheetName}`);
        }
        await this.cacheManager.set(cacheKey, headers, 3600); // 1 hora
        return headers;
    }


    /**
     * Obtiene los datos, priorizando el caché.
     */
    async fetchRows(sheetName: string): Promise<any[][]> {
        const cacheKey = `sheet_data:${this.options.defaultSpreadsheetId}:${sheetName}`;
        const cached = await this.cacheManager.get<any[][]>(cacheKey);

        if (cached) return cached;

        const rows = await this.googleSheets.getValues(this.options.defaultSpreadsheetId, `${sheetName}!A:Z`);
        if (rows && rows.length > 0) {
            await this.cacheManager.set(cacheKey, rows, 300); // 5 min de TTL
        }
        return rows || [];
    }

    /**
     * Escribe o actualiza datos y limpia el caché correspondiente.
     */
    async writeRow(sheetName: string, range: string, values: any[]): Promise<void> {
        await this.googleSheets.updateRow(this.options.defaultSpreadsheetId, `${sheetName}!${range}`, [values]);
        await this.clearCache(sheetName);
    }
    /*
    * Descripcion: Agrega una nueva fila a la hoja
    * Parametros: 
    *   sheetName: Nombre de la hoja
    *   values: Valores a agregar
    * Retorna: void
    */
    async appendRow(sheetName: string, values: any[]): Promise<void> {
        await this.googleSheets.appendRow(this.options.defaultSpreadsheetId, `${sheetName}!A:A`, [values]);
        await this.clearCache(sheetName);
    }
    /*
    * Descripcion: Limpia el caché de la hoja
    * Parametros: 
    *   sheetName: Nombre de la hoja
    * Retorna: void
    */
    async clearCache(sheetName: string): Promise<void> {
        const dataKey = `sheet_data:${this.options.defaultSpreadsheetId}:${sheetName}`;
        await this.cacheManager.del(dataKey);
        this.logger.debug(`Caché invalidado para: ${sheetName}`);
    }

}