import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';

import { withRetry } from '@database/utils/tools';
import { GoogleAutenticarService } from '../auth.google.service';
import { SheetsApiClient } from './SheetsApiClient';

@Injectable()
export class SheetsMetadataService {
    private readonly logger = new Logger(SheetsMetadataService.name);

    constructor(private readonly sheetsApiClient: SheetsApiClient) { }

    /**
     * Consulta el sheetId de una hoja específica de forma aislada.
     */
    async getSheetIdByName(spreadsheetId: string, sheetName: string): Promise<number> {
        try {
            const response = await this.sheetsApiClient.execute((sheets) => sheets.spreadsheets.get({
                spreadsheetId,
            });
        });

        const sheets = response.data.sheets;
        const sheet = sheets?.find(s => s.properties?.title?.toLowerCase() === sheetName.toLowerCase());

        if (!sheet?.properties?.sheetId === undefined) {
            throw new Error(`No se encontró el sheetId para la hoja: ${sheetName}`);
        }

        return sheet.properties!.sheetId!;
    } catch(error: any) {
        this.logger.error(`Error al obtener sheetId de ${sheetName}: ${error.message}`);
        throw new InternalServerErrorException('Error de comunicación con Google Sheets Metadata.');
    }
}
}