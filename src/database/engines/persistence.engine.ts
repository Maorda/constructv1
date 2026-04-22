// persistence.manager.ts
import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { GoogleSpreedsheetService } from '../services/google.spreedsheet.service';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/mappers/sheet.mapper';

@Injectable()
export class PersistenceEngine<T> {
    private readonly logger = new Logger(PersistenceEngine.name);

    constructor(
        private readonly googleSheets: GoogleSpreedsheetService<T>,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions

    ) { }
    /**
     * getHeaders Estricto: 
     * Obtiene los encabezados UNICAMENTE de lo definido en los decoradores de la Entidad.
     */
    async getHeaders<T>(EntityClass: new () => T): Promise<string[]> {
        const sheetName = EntityClass.name;
        const cacheKey = `headers_strict:${sheetName}`;

        // 1. Intentar obtener de caché
        const cached = await this.cacheManager.get<string[]>(cacheKey);
        if (cached) return cached;

        // 2. Obtener encabezados mediante SheetMapper (vía metadatos de Reflection)
        // Esto asegura que el orden y los nombres sean los que TÚ definiste en el código
        const headers = SheetMapper.getColumnHeaders(EntityClass);

        if (!headers || headers.length === 0) {
            throw new Error(`La entidad ${sheetName} no tiene columnas decoradas con @Column.`);
        }

        // 3. Guardar en caché
        await this.cacheManager.set(cacheKey, headers, 3600000); // 1 hora
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
        await this.googleSheets.updateSheet(this.options.defaultSpreadsheetId, `${sheetName}!${range}`, [values]);
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
        await this.googleSheets.appendObject(this.options.defaultSpreadsheetId, `${sheetName}!A:A`, [values]);
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