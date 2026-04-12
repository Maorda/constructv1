import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';

@Injectable()
export class GoogleSpreedsheetService {
    private readonly logger = new Logger(GoogleSpreedsheetService.name);
    // Almacén en memoria: Key = "spreadsheetId-sheetName", Value = sheetId
    private sheetIdCache = new Map<string, number>();

    constructor(private readonly googleAuthService: GoogleAutenticarService) { }

    /**
     * Obtiene los valores de un rango específico con manejo de errores
     */
    async getValues(spreadsheetId: string, range: string) {
        try {
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId,
                range,
            });
            return response.data.values;
        } catch (error) {
            // Logeamos el error internamente para depuración
            this.logger.error(`Error al obtener datos de Sheets: ${error.message}`, error.stack);

            // Lanzamos una excepción que NestJS convertirá en una respuesta HTTP 500 clara
            throw new InternalServerErrorException(
                `No se pudo leer la hoja de cálculo. Verifica el ID: ${spreadsheetId}`
            );
        }
    }

    /**
     * Inserta una nueva fila con manejo de errores
     */
    async appendRow(spreadsheetId: string, range: string, values: any[]) {
        try {
            const result = await this.googleAuthService.sheets.spreadsheets.values.append({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [values],
                },
            });
            return result.data;
        } catch (error) {
            this.logger.error(`Error al insertar fila en Sheets: ${error.message}`);

            throw new InternalServerErrorException(
                'Error al registrar los datos en Google Sheets. Revisa los permisos de la cuenta de servicio.'
            );
        }
    }

    /**
     * Actualiza datos con manejo de errores
     */
    async updateRow(spreadsheetId: string, range: string, values: any[][]) {
        try {
            const result = await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values,
                },
            });
            return result.data;
        } catch (error) {
            this.logger.error(`Error al actualizar Sheets: ${error.message}`);
            throw new InternalServerErrorException('Error crítico al intentar actualizar la celda.');
        }

    }
    /**
     * Elimina una fila completa desplazando las inferiores hacia arriba
     * @param spreadsheetId ID del documento
     * @param sheetId ID numérico de la pestaña (Gid)
     * @param rowIndex Índice de la fila a eliminar (empezando desde 0)
     */
    async deleteRow(spreadsheetId: string, sheetId: number, rowIndex: number) {
        try {
            return await this.googleAuthService.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            deleteDimension: {
                                range: {
                                    sheetId: sheetId,
                                    dimension: 'ROWS',
                                    startIndex: rowIndex,
                                    endIndex: rowIndex + 1,
                                },
                            },
                        },
                    ],
                },
            });
        } catch (error) {
            this.logger.error(`Error al eliminar fila en Sheets: ${error.message}`);
            throw new InternalServerErrorException(
                'No se pudo eliminar la fila. Verifica que el índice sea válido y que el sheetId sea correcto.'
            );
        }
    }
    /**
   * Obtiene el índice de la última fila que contiene al menos un dato.
   * Útil para saber dónde termina la lista de asistencias.
   */
    async getLastRowIndex(spreadsheetId: string, range: string): Promise<number> {
        try {
            const values = await this.getValues(spreadsheetId, range);
            if (!values || values.length === 0) return 0;

            // Filtramos de atrás hacia adelante para encontrar la última fila no vacía
            for (let i = values.length - 1; i >= 0; i--) {
                if (values[i].some(cell => cell !== null && cell !== '')) {
                    return i + 1; // Retornamos en formato 1-based (como lo usa Sheets)
                }
            }
            return 0;
        } catch (error) {
            this.logger.error(`Error calculando última fila: ${error.message}`);
            throw new InternalServerErrorException('No se pudo determinar la última fila con datos');
        }
    }

    /**
     * Obtiene el índice de la última columna que contiene datos en una fila específica
     * o en todo el rango analizado.
     */
    async getLastColumnIndex(spreadsheetId: string, range: string): Promise<number> {
        try {
            const values = await this.getValues(spreadsheetId, range);
            if (!values || values.length === 0) return 0;

            let maxCol = 0;
            // Recorremos todas las filas para encontrar la columna más lejana con datos
            values.forEach(row => {
                for (let j = row.length - 1; j >= 0; j--) {
                    if (row[j] !== null && row[j] !== '') {
                        if (j + 1 > maxCol) maxCol = j + 1;
                        break;
                    }
                }
            });

            return maxCol;
        } catch (error) {
            this.logger.error(`Error calculando última columna: ${error.message}`);
            throw new InternalServerErrorException('No se pudo determinar la última columna con datos');
        }
    }
    /**
    * Obtiene el ID numérico (sheetId) de una pestaña buscando por su nombre.
    * @param spreadsheetId El ID largo del documento (de la URL).
    * @param sheetName El nombre de la pestaña (ej: 'Asistencias').
    * @returns El sheetId numérico.
    */
    async getSheetIdByName(spreadsheetId: string, sheetName: string): Promise<number> {
        const cacheKey = `${spreadsheetId}-${sheetName}`;

        // 1. Intentar obtenerlo de la caché
        if (this.sheetIdCache.has(cacheKey)) {
            this.logger.log(`Caché Hit: Usando ID guardado para "${sheetName}"`);
            return this.sheetIdCache.get(cacheKey)!;
        }

        try {
            this.logger.log(`Caché Miss: Consultando metadatos en Google para "${sheetName}"`);
            const response = await this.googleAuthService.sheets.spreadsheets.get({
                spreadsheetId,
            });

            const sheet = response.data.sheets?.find(
                (s) => s.properties?.title === sheetName
            );

            if (!sheet || sheet.properties?.sheetId === undefined) {
                throw new Error(`No se encontró la pestaña: ${sheetName}`);
            }

            const sheetId = sheet.properties.sheetId;

            // 2. Guardar en la caché antes de devolver
            this.sheetIdCache.set(cacheKey, sheetId);

            return sheetId;
        } catch (error) {
            this.logger.error(`Error al obtener sheetId: ${error.message}`);
            throw new InternalServerErrorException(
                `Error al buscar la pestaña "${sheetName}".`
            );
        }
    }

    /**
     * Método opcional para limpiar la caché si cambias nombres de pestañas en caliente
     */
    clearSheetCache() {
        this.sheetIdCache.clear();
        this.logger.log('Caché de Google Sheets limpiada correctamente.');
    }
    /**
    * Filtra filas en una pestaña basándose en una columna y un valor específico.
    * Útil para obtener todos los "Adelantos" de un "EmpleadoID".
    */
    async findRowsByFilter(spreadsheetId: string, range: string, fieldName: string, value: any): Promise<any[][]> {
        const allValues = await this.getValues(spreadsheetId, range);
        if (!allValues || allValues.length === 0) return [];

        const headers = allValues[0];
        const columnIndex = headers.indexOf(fieldName);

        if (columnIndex === -1) {
            throw new Error(`La columna ${fieldName} no existe para filtrar.`);
        }

        // Retornamos todas las filas donde la columna coincida con el valor
        return allValues.slice(1).filter(row => String(row[columnIndex]) === String(value));
    }
    // src/google/google-sheets.service.ts
    async createSheet(spreadsheetId: string, title: string): Promise<void> {
        await this.googleAuthService.sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        addSheet: {
                            properties: { title },
                        },
                    },
                ],
            },
        });
    }
    // src/google/services/google-sheets.service.ts
    async getSpreadsheetMetadata(spreadsheetId: string) {
        const response = await this.googleAuthService.sheets.spreadsheets.get({
            spreadsheetId,
            includeGridData: false, // No pedimos datos, solo metadatos (rápido)
        });
        return response.data;
    }

    async getExistingSpreadsheetSheets(spreadsheetId: string): Promise<string[]> {
        const metadata = await this.getSpreadsheetMetadata(spreadsheetId);
        // Retorna un array con los nombres de las pestañas: ['OBREROS', 'BALANCES', etc.]
        return metadata.sheets?.map(s => s.properties?.title) || [];
    }



}
