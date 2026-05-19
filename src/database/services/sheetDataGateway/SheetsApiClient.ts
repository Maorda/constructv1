import { Injectable } from '@nestjs/common';
import { ISheetsApiContract } from './interfaces/sheets.contracts';
import { withRetry } from '@database/utils/tools';
import { GoogleAutenticarService } from '../auth.google.service';

@Injectable()
export class SheetsApiClient implements ISheetsApiContract {
    constructor(private readonly googleAuthService: GoogleAutenticarService) { }

    get sheets() {
        return this.googleAuthService.sheets;
    }

    async execute<T>(operation: (sheets: any) => Promise<T>): Promise<T> {
        return await withRetry(async () => {
            if (!this.googleAuthService.sheets) {
                throw new Error('El cliente oficial de la API de Google Sheets no se encuentra inicializado.');
            }
            return await operation(this.googleAuthService.sheets);
        }, 3, 1000);
    }
}