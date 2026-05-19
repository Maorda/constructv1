import { Injectable } from '@nestjs/common';

import { withRetry } from '@database/utils/tools';
import { GoogleAutenticarService } from '../auth.google.service';
import { ISheetsApiContract } from './interfaces/sheets.contracts';

@Injectable()
export class SheetsApiClient implements ISheetsApiContract {
    constructor(private readonly googleAuthService: GoogleAutenticarService) { }

    /**
     * Ejecuta cualquier operación de la API de Google Sheets con reintentos automáticos
     */
    async execute<T>(operation: (sheets: any) => Promise<T>): Promise<T> {
        return await withRetry(async () => {
            return await operation(this.googleAuthService.sheets);
        }, 3, 1000);
    }
}

export { ISheetsApiContract };
