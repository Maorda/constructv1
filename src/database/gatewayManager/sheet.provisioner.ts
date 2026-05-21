import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SheetsApiClient } from '../services/sheetDataGateway/SheetsApiClient';
import { ISheetProvisionerContract } from '../services/sheetDataGateway/interfaces/sheets.contracts';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { ClassType } from '@database/types/query.types';
import { SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';
import { SchemaFactory } from '@database/schema/schema.factory';


@Injectable()
export class SheetProvisioner implements ISheetProvisionerContract {
    private readonly logger = new Logger(SheetProvisioner.name);

    constructor(
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions,
        private readonly apiClient: SheetsApiClient,
    ) { }

    async executeActiveWait(apiClient: SheetsApiClient, sheetName: string): Promise<void> {
        let attempts = 0;
        while (!apiClient.sheets && attempts < 10) {
            this.logger.warn(`⏳ Esperando a que el motor de Google Sheets esté listo para: ${sheetName} (Intento ${attempts + 1})...`);
            await new Promise(res => setTimeout(res, 500));
            attempts++;
        }

        if (!apiClient.sheets) {
            throw new Error(`GoogleAuthService.sheets no se inicializó a tiempo para la entidad ${sheetName}`);
        }
    }
    /**
     * Obtiene los metadatos de una hoja específica sin descargar los datos (gridData).
     * Ideal para verificaciones previas a operaciones de escritura.
     */
    async getSheetMetadata(sheetName: string): Promise<any> {
        return await this.apiClient.execute(async (sheets) => {
            const response = await sheets.spreadsheets.get({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                includeGridData: false, // Optimización crítica
            });

            const sheet = response.data.sheets?.find(
                (s) => s.properties?.title === sheetName
            );

            if (!sheet) {
                throw new Error(`[Provisioner] Hoja "${sheetName}" no encontrada.`);
            }

            return sheet.properties; // Retorna { sheetId, title, index, sheetType, ... }
        });
    }


    async getSpreadsheetMetadata(apiClient: SheetsApiClient): Promise<any> {
        return await apiClient.execute(async (sheets) => {
            const response = await sheets.spreadsheets.get({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                includeGridData: false,
            });
            return response.data;
        });
    }

    async createSheet(apiClient: SheetsApiClient, title: string): Promise<void> {
        await apiClient.execute(async (sheets) => {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                requestBody: {
                    requests: [{ addSheet: { properties: { title } } }],
                },
            });
        });
    }

    async getSheetIdByName(apiClient: SheetsApiClient, sheetName: string): Promise<number> {
        return await apiClient.execute(async (sheets) => {
            const response = await sheets.spreadsheets.get({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
            });
            const sheet = response.data.sheets?.find((s: any) => s.properties?.title?.toLowerCase() === sheetName.toLowerCase());
            if (!sheet || sheet.properties?.sheetId === undefined) {
                throw new Error(`No se encontró el sheetId para la hoja: ${sheetName}`);
            }
            return sheet.properties.sheetId;
        });
    }

    async ensureSheetExists(entityClass: ClassType<any>): Promise<void> {
        // 🔒 Delegamos la resolución del nombre exclusivamente al Factory
        const schema = SchemaFactory.createForClass(entityClass);
        const sheetName = schema.sheetName;

        this.logger.log(`[Provisioner] Verificando existencia de la hoja física: ${sheetName}`);

        await this.apiClient.execute(async (sheets) => {
            const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;

            const response = await sheets.spreadsheets.get({ spreadsheetId });
            const sheetExists = response.data.sheets?.some(s => s.properties?.title === sheetName);

            if (!sheetExists) {
                this.logger.warn(`[Provisioner] La hoja "${sheetName}" no existe. Creándola...`);

                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        requests: [{ addSheet: { properties: { title: sheetName } } }]
                    }
                });
                this.logger.log(`[Provisioner] Hoja "${sheetName}" creada con éxito.`);
            } else {
                this.logger.debug(`[Provisioner] La hoja "${sheetName}" ya existe en el libro.`);
            }
        });
    }
}