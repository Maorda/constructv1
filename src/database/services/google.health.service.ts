import { Injectable, Logger, Inject } from '@nestjs/common';
import { GoogleSpreedsheetService } from './google.spreedsheet.service';


@Injectable()
export class GoogleHealthService {
    private readonly logger = new Logger(GoogleHealthService.name);

    constructor(
        private readonly googleSheets: GoogleSpreedsheetService,
        // Inyectamos el ID base para probar conectividad general
        @Inject("FOLDERID") private readonly folderId: string
    ) { }

    /**
     * Verifica la salud de la conexión con Google Sheets
     */
    // src/google/services/google-health.service.ts

    async checkConnection(retries = 3): Promise<{ status: string; details?: any }> {
        const spreadsheetId = process.env.SPREADSHEET_ID;

        for (let i = 0; i < retries; i++) {
            try {
                // Cambio crítico: No buscamos "Obrero", validamos el acceso al documento
                await this.googleSheets.getSpreadsheetMetadata(spreadsheetId);
                return { status: 'up' };
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