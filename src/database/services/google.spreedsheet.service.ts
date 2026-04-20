import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';

@Injectable()
export class GoogleSpreedsheetService {
    private readonly logger = new Logger(GoogleSpreedsheetService.name);
    private sheetIdCache = new Map<string, number>();

    constructor(private readonly googleAuthService: GoogleAutenticarService) { }
    async getValues(spreadsheetId: string, range: string): Promise<any[][]> {
        try {
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId,
                range,
            });
            return response.data.values || [];
        } catch (error) {
            // Logeamos el error internamente para depuración
            this.logger.error(`Error al obtener datos de Sheets: ${error.message}: ${range}`, error.stack);

            // Lanzamos una excepción que NestJS convertirá en una respuesta HTTP 500 clara
            throw new InternalServerErrorException(
                `No se pudo leer la hoja de cálculo. Verifica el ID: ${spreadsheetId}`
            );
        }
    }

    /**
 * Inserta múltiples filas en una sola operación HTTP.
 * @param spreadsheetId El ID del documento de Google Sheets.
 * @param range El rango o nombre de la hoja (ej. 'Hoja1!A1').
 * @param values Array de arrays con los datos mapeados.
 */
    async appendRows(
        spreadsheetId: string,
        range: string,
        values: any[][]
    ): Promise<void> {
        if (!values || values.length === 0) return;

        try {
            await this.googleAuthService.sheets.spreadsheets.values.append({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED', // Permite que Sheets interprete fechas y números
                insertDataOption: 'INSERT_ROWS', // Asegura que se creen nuevas filas si es necesario
                requestBody: {
                    values: values, // Aquí enviamos el lote completo
                },
            });

            this.logger.log(`Se insertaron exitosamente ${values.length} filas en el rango ${range}`);
        } catch (error) {
            this.logger.error(`Error al insertar múltiples filas en Sheets: ${error.message}`);

            // Manejo de cuotas (Rate Limit)
            if (error.code === 429) {
                throw new InternalServerErrorException('Límite de cuota de Google Sheets alcanzado. Reintentando en breve...');
            }

            throw new InternalServerErrorException('Error crítico al escribir en la base de datos de Google.');
        }
    }

    /**
* Actualiza múltiples celdas en una sola petición HTTP
* @param spreadsheetId ID del documento
* @param updates Array de objetos { range: 'Hoja1!A2', value: 'nuevo_valor' }
*/
    async updateCellsBatch(spreadsheetId: string, updates: { range: string, value: any }[]): Promise<void> {
        try {
            const data = updates.map(u => ({
                range: u.range,
                values: [[u.value]] // Google requiere un array de arrays para los valores
            }));

            await this.googleAuthService.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: data
                }
            });

            this.logger.log(`BatchUpdate exitoso: ${updates.length} celdas actualizadas.`);
        } catch (error) {
            this.logger.error(`Error en BatchUpdate: ${error.message}`);
            throw new InternalServerErrorException('No se pudo realizar la actualización por lotes.');
        }
    }



}