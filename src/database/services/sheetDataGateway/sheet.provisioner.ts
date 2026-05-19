import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { SheetsApiClient } from './SheetsApiClient';
import { ISheetProvisionerContract } from './interfaces/sheets.contracts';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';


@Injectable()
export class SheetProvisioner implements ISheetProvisionerContract {
    private readonly logger = new Logger(SheetProvisioner.name);

    constructor(
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions,
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
                    requests: [{
                        addSheet: { properties: { title } },
                    }],
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
}