import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ColumnOptions } from '@database/decorators/column.decorator';
import { TABLE_COLUMN_KEY } from '@database/constants/metadata.constants';
import { withRetry } from '@database/utils/tools';
import { GoogleAutenticarService } from '../auth.google.service';
import { ISheetsApiContract, SheetsApiClient } from './SheetsApiClient';
import { ISheetMetadataContract, ISheetProvisionerContract } from './interfaces/sheets.contracts';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';

export interface ProvisionResult {
    finalSheetName: string;
    sheetId: number;
}
export interface ISheetProvisioner<T extends object> {
    ensureSheetExists(spreadsheetId: string, sheetName: string, EntityClass: new () => any): Promise<ProvisionResult>;
    initialize(entityClass: new () => T): void;
    createSheet(): void;
}


@Injectable()
export class SheetProvisioner implements ISheetProvisionerContract {
    private readonly logger = new Logger(SheetProvisioner.name);

    constructor(
        private readonly apiClient: SheetsApiClient,

        private readonly metadata: ISheetMetadataContract
    ) { }

    /**
     * Verifica la existencia de una pestaña. Si no existe, la crea y escribe sus cabeceras.
     */
    async executeProvision(
        api: ISheetsApiContract,
        spreadsheetId: string,
        sheetName: string,
        EntityClass: new () => any
    ): Promise<ProvisionResult> {
        this.logger.log(`[Sync] Verificando existencia de la pestaña: "${sheetName}"...`);

        try {
            const spreadsheet = await withRetry(async () => {
                const res = await api.execute((sheets) => sheets.spreadsheets.get({
                    spreadsheetId: spreadsheetId,
                }));
                return res.data;
            });

            // Buscar si la pestaña existe por su título exacto
            const existingSheet = spreadsheet.sheets?.find(
                (s) => s.properties?.title?.toLowerCase() === sheetName.toLowerCase()
            );

            if (existingSheet) {
                const finalSheetName = existingSheet.properties!.title!;
                const sheetId = existingSheet.properties!.sheetId!;
                this.logger.log(`[Sync] Pestaña "${finalSheetName}" localizada con éxito.`);
                return { finalSheetName, sheetId };
            }

            // LA HOJA NO EXISTE: Procedemos al Auto-Aprovisionamiento en caliente
            this.logger.warn(`[Sync] ⚠️ La pestaña "${sheetName}" no existe en el libro. Creándola de forma automática...`);

            const addSheetResponse = await api.execute((sheets) => sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                requestBody: {
                    requests: [{
                        addSheet: {
                            properties: { title: sheetName }
                        }
                    }]
                }
            }));

            const newSheetId = addSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;

            // Extraer los nombres físicos de columnas configurados en los decoradores @Column
            const targetProto = EntityClass.prototype;
            const columnsKeys = Object.getOwnPropertyNames(targetProto).filter(k => k !== 'constructor');
            const calculatedHeaders: string[] = [];

            // Reconstruir el orden de cabeceras basado en los metadatos de la Entidad
            for (const key of columnsKeys) {
                const columnMeta: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, targetProto, key);
                if (columnMeta) {
                    calculatedHeaders.push(columnMeta.name || key);
                }
            }

            // Si no hay cabeceras decoradas, colocamos un ID por defecto para inicializar la estructura
            if (calculatedHeaders.length === 0) calculatedHeaders.push('ID');

            // Escribir la Fila 1 (Cabeceras) de forma inmediata
            await api.execute.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'RAW',
                requestBody: { values: [calculatedHeaders] }
            });

            this.logger.log(`[Sync] 🎉 Pestaña "${sheetName}" creada con éxito e inicializada con cabeceras: [${calculatedHeaders.join(', ')}]`);

            return {
                finalSheetName: sheetName,
                sheetId: newSheetId ?? 0
            };

        } catch (error: any) {
            this.logger.error(`[Sync Error] Fallo crítico al sincronizar la metadata de la pestaña "${sheetName}": ${error.message}`);
            throw new InternalServerErrorException(`Error de enlace operacional con Google Sheets para la entidad: ${sheetName}`);
        }
    }
}