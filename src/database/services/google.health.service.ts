import { Injectable, Logger, Inject } from '@nestjs/common';
import { SheetsDataGateway } from './sheetDataGateway';
import { GoogleAutenticarService } from './auth.google.service';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';


@Injectable()
export class GoogleHealthService<T extends object> {
    private readonly logger = new Logger(GoogleHealthService.name);

    constructor(
        private readonly googleSheets: GoogleAutenticarService,
        // Inyectamos el ID base para probar conectividad general
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
    ) { }

    /**
     * Verifica la salud de la conexión con Google Sheets
     */
    // src/google/services/google-health.service.ts

    async checkConnection(retries = 3): Promise<{ status: string; details?: any }> {

        for (let i = 0; i < retries; i++) {
            try {
                // Cambio crítico: No buscamos "Obrero", validamos el acceso al documento
                const response = this.googleSheets.sheets.spreadsheets.get({
                    spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                    includeGridData: false,
                });
                const title = response.data.properties.title;

                this.logger.log(`✅ Conexión exitosa con el documento: "${title}"`);
                return {
                    status: 'up',
                    details: { documentTitle: title, sheetsCount: response.data.sheets.length }
                };
            } catch (error) {
                if (i === retries - 1) {
                    return { status: 'down', details: { error: error.message } };
                }
                this.logger.warn(`⚠️ Intento ${i + 1}/${retries} fallido. Reintentando...`);
                await new Promise(res => setTimeout(res, 1000));
            }
        }
        return { status: 'down' };
    }

}