import { Injectable, Logger, InternalServerErrorException, Inject } from '@nestjs/common';
import { SheetsApiClient } from './SheetsApiClient';
import { ISheetsPersistenceContract } from './interfaces/sheets.contracts';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';


@Injectable()
export class SheetsPersistenceService implements ISheetsPersistenceContract {
    private readonly logger = new Logger(SheetsPersistenceService.name);
    private sheetName!: string; // El operador ! le dice a TS que se inicializará mediante el setter

    constructor(
        private readonly apiClient: SheetsApiClient,
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions
    ) { }
    setSheetName(sheetName: string): void {
        this.sheetName = sheetName;
    }


    async appendRows(range: string, values: any[][]): Promise<any> {
        return await this.apiClient.execute(async (sheets) => {
            return await sheets.spreadsheets.values.append({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                range,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values },
            });
        });
    }

    async updateRange(range: string, values: any[][]): Promise<void> {
        try {
            await this.apiClient.execute(async (sheets) => {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                    range,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values },
                });
            });
        } catch (error: any) {
            this.logger.error(`Error de API Google Sheets en updateRange: ${error.message}`);
            throw new InternalServerErrorException('No se pudo persistir la información en la nube.');
        }
    }

    async clearRow(sheetName: string, physicalRow: number): Promise<void> {
        const range = `${sheetName}!${physicalRow}:${physicalRow}`;

        try {
            await this.apiClient.execute(async (sheets) => {
                return await sheets.spreadsheets.values.clear({
                    spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                    range,
                });
            });

            this.logger.debug(`[Persistence] Fila ${physicalRow} limpiada exitosamente en pestaña: ${sheetName}`);
        } catch (error: any) {
            this.logger.error(`[Persistence] Error crítico al limpiar fila física ${physicalRow}: ${error.message}`);
            throw new InternalServerErrorException(`No se pudo realizar el borrado físico en la fila ${physicalRow}`);
        }
    }

    async deleteRow(sheetId: number, rowIndex: number): Promise<void> {
        try {
            await this.apiClient.execute(async (sheets) => {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                    requestBody: {
                        requests: [{
                            deleteDimension: {
                                range: {
                                    sheetId,
                                    dimension: 'ROWS',
                                    startIndex: rowIndex,
                                    endIndex: rowIndex + 1,
                                },
                            },
                        }],
                    },
                });
            });
        } catch (error) {
            throw new InternalServerErrorException('No se pudo eliminar la fila física de Google.');
        }
    }

    async updateCellsBatch(data: any[]): Promise<void> {
        try {
            await this.apiClient.execute(async (sheets) => {
                await sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                    requestBody: {
                        valueInputOption: 'USER_ENTERED',
                        data: data,
                    },
                });
            });
        } catch (error: any) {
            if (error?.status === 429 || error?.response?.status === 429) {
                this.logger.error('Se ha agotado la cuota de la API de Google Sheets. Espera un momento.');
            } else {
                this.logger.error(`Fallo definitivo tras reintentos en batchUpdate: ${error.message}`);
            }
            throw new InternalServerErrorException('No se pudo sincronizar en lote con Google Sheets tras varios intentos.');
        }
    }
}