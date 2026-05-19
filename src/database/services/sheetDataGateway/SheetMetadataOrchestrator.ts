import { Injectable, Logger } from "@nestjs/common";
import { ISheetMetadataContract, ISheetsApiContract } from "./interfaces/sheets.contracts";
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';
import { MetadataRegistry } from "../metadata.registry";

@Injectable()
export class SheetMetadataOrchestrator implements ISheetMetadataContract {
    private readonly logger = new Logger(SheetMetadataOrchestrator.name);

    constructor(private readonly metadataRegistry: MetadataRegistry) { }
    async getHeaders(entityClass: any): Promise<string[]> {
        const headers = SheetMapper.getColumnHeaders(entityClass);
        if (!headers || headers.length === 0) {
            throw new Error(`La entidad ${entityClass.name} no tiene columnas decoradas con @Column.`);
        }
        return headers;
    }
    async syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void> {
        const expectedHeaders = await this.getHeaders(entityClass);

        try {
            // Intentar leer la primera fila para auditar las cabeceras existentes
            const response = await api.execute(async (sheets) => {
                return await sheets.spreadsheets.values.get({
                    spreadsheetId: (api as any).optionsDatabase?.SPREADSHEET_ID, // Se asume resuelto o inyectado
                    range: `${sheetName}!A1:Z1`,
                });
            });

            const currentHeaders = response.data.values?.[0] || [];
            const isDesynced = this.checkDesync(expectedHeaders, currentHeaders);

            if (currentHeaders.length === 0 || isDesynced) {
                this.logger.warn(`[Metadata] Desincronización detectada en "${sheetName}". Actualizando cabeceras físicas...`);

                await api.execute(async (sheets) => {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: (api as any).optionsDatabase?.SPREADSHEET_ID,
                        range: `${sheetName}!A1`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [expectedHeaders] },
                    });
                });
                this.logger.log(`[Metadata] Esquema sincronizado inmaculadamente para la pestaña: ${sheetName}`);
            }
        } catch (error: any) {
            this.logger.error(`Error crítico al sincronizar esquema en ${sheetName}: ${error.message}`);
            throw error;
        }
    }
    mapObjectToRowArray<T>(entity: T, headers: string[]): any[] {
        // Obtenemos de manera automática el constructor de la entidad para leer su MetadataRegistry
        const entityClass = (entity as any).constructor;
        const columnMap = this.metadataRegistry.getColumnMap(entityClass);
        const columnDetails = this.metadataRegistry.getColumnDetails(entityClass);

        const row: any[] = [];

        // Iteramos basándonos en el mapeo lógico indexado del registro del ODM
        Object.keys(columnMap).forEach((logicalKey) => {
            const index = columnMap[logicalKey];
            const physicalKey = columnDetails[logicalKey]?.name || logicalKey;

            // Extracción elástica multiformato tolerante a variaciones de nomenclatura
            let value = (entity as any)[logicalKey] ??
                (entity as any)[physicalKey] ??
                (entity as any)[physicalKey.replace(/_/g, '')] ??
                (entity as any)[logicalKey.toUpperCase()];

            // Normalización estricta para persistencia en celdas de Sheets
            if (value instanceof Date) value = value.toISOString();
            if (typeof value === 'object' && value !== null) value = JSON.stringify(value);
            if (value === undefined) value = null;

            row[index] = value;
        });

        return row;
    }
    resolveSheetName(entityClass: any): string {
        const decoratedName = Reflect.getMetadata(SHEETS_TABLE_NAME, entityClass);
        return decoratedName || this.normalizeFallback(entityClass.name);
    }
    checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
        if (expectedHeaders.length !== currentHeaders.length) return true;
        return expectedHeaders.some((expected, index) => {
            const current = currentHeaders[index];
            return String(expected || '').trim().toUpperCase() !== String(current || '').trim().toUpperCase();
        });
    }
    private normalizeFallback(className: string): string {
        // Remover sufijos comunes de la arquitectura
        let name = className.replace(/(Entity|Model|Schema|Repository)$/i, '');

        // Regla de pluralización básica en español
        const lastChar = name.slice(-1).toLowerCase();
        if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
            name = `${name}s`;
        } else {
            name = `${name}es`;
        }

        return name.toUpperCase();
    }
}