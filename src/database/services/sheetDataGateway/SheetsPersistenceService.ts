import { Injectable, Logger, InternalServerErrorException, Inject } from '@nestjs/common';
import { SheetsApiClient } from './SheetsApiClient';
import { ISheetsPersistenceContract } from './interfaces/sheets.contracts';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';

export interface ISheetsPersistenceService1 {
    appendRows(spreadsheetId: string, range: string, values: any[][]): Promise<void>;
    updateRange(spreadsheetId: string, range: string, values: any[][]): Promise<void>;
    createSheet(spreadsheetId: string, title: string): Promise<void>;
    clearRange(spreadsheetId: string, range: string): Promise<void>;
    clearRow(spreadsheetId: string, range: string): Promise<void>;
    deleteRow(spreadsheetId: string, range: string): Promise<void>;
    batchUpdateCells(spreadsheetId: string, range: string, values: any[][]): Promise<void>;
}
@Injectable()
export class SheetsPersistenceService implements ISheetsPersistenceContract {
    private readonly logger = new Logger(SheetsPersistenceService.name);

    constructor(
        private readonly apiClient: SheetsApiClient,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions
    ) { }
    clearRow(spreadsheetId: string, range: string): Promise<void> {
        throw new Error('Method not implemented.');
    }
    deleteRow(spreadsheetId: string, range: string): Promise<void> {
        throw new Error('Method not implemented.');
    }
    batchUpdateCells(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
        throw new Error('Method not implemented.');
    }

    async appendRows(range: string, values: any[][]): Promise<void> {
        if (!values || values.length === 0) return;

        await this.apiClient.execute(async (sheets) => {
            return await sheets.spreadsheets.values.append({
                spreadsheetId: this.options.SPREADSHEET_ID,
                range,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values },
            });
        });
        this.logger.log(`Se insertaron ${values.length} filas en ${range}`);
    }

    async updateRange(range: string, values: any[][]): Promise<void> {
        await this.apiClient.execute(async (sheets) => {
            return await sheets.spreadsheets.values.update({
                spreadsheetId: this.options.SPREADSHEET_ID,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values },
            });
        });
    }

    async createSheet(title: string): Promise<void> {
        await this.apiClient.execute(async (sheets) => {
            return await sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.options.SPREADSHEET_ID,
                requestBody: { requests: [{ addSheet: { properties: { title } } }] }
            });
        });
    }

    async clearRange(range: string): Promise<void> {
        await this.apiClient.execute(async (sheets) => {
            return await sheets.spreadsheets.values.clear({
                spreadsheetId: this.options.SPREADSHEET_ID,
                range
            });
        });
    }
}