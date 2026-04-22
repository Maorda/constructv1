import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí
import { SheetMapper } from '@database/mappers/sheet.mapper';
import { TABLE_COLUMN_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';

@Injectable()
export class GoogleSpreedsheetService<T> {
    private readonly logger = new Logger(GoogleSpreedsheetService.name);
    private sheetIdCache = new Map<string, number>();
    protected readonly EntityClass: new () => T;

    constructor(
        private readonly googleAuthService: GoogleAutenticarService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly sheetMapper: SheetMapper

    ) { }
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
    * MÉTODO DE TU SCRIPT (Optimizado)
    * Se encarga de la comunicación técnica y el caché de la API.
    */
    /**
   * Obtiene los datos de una hoja con lógica de caché para optimizar el rendimiento.
   */
    public async getOrFetchSheet(sheetName: string): Promise<any[][] | null> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;
        const cacheKey = `sheet_data:${spreadsheetId}:${sheetName}`;

        // 1. Intentar obtener del caché
        const cachedData = await this.cacheManager.get<any[][]>(cacheKey);
        if (cachedData) return cachedData;

        // 2. Si no hay caché, pedir a Google Sheets
        // Usamos un rango amplio A:Z o ajustado dinámicamente
        const freshData = await this.getValues(spreadsheetId, `${sheetName}!A:Z`);

        if (freshData && freshData.length > 0) {
            // 3. Guardar en caché (ejemplo: 10 segundos para alta concurrencia)
            await this.cacheManager.set(cacheKey, freshData, 10000);
        }

        return freshData;
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

    // src/database/google-spreadsheet.service.ts

    async updateSheet(spreadsheetId: string, sheetName: string, rows: any[][]): Promise<void> {
        try {
            // LLAMADA INTERNA: Aquí sí existe clearRange porque están en la misma clase
            await this.clearRange(spreadsheetId, `${sheetName}!A:Z`);

            const range = `${sheetName}!A1`;
            await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: rows,
                },
            });

            this.logger.log(`Hoja '${sheetName}' sobrescrita con éxito.`);
        } catch (error) {
            this.logger.error(`Error en updateSheet: ${error.message}`);
            throw error;
        }
    }
    // src/database/google-sheets/google-sheets.service.ts

    /**
     * Escribe valores directamente en un rango sin procesar lógica de negocio.
     * Ideal para sincronización de esquemas (cabeceras).
     */
    async updateRowRaw(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
        try {
            await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED', // Permite que Google interprete fechas/números
                requestBody: {
                    values, // Ejemplo: [['id', 'nombre', 'sueldo']]
                },
            });
        } catch (error) {
            this.logger.error(`Error en updateRowRaw [${range}]: ${error.message}`);
            throw error;
        }
    }

    /**
     * Convierte un objeto JSON a un arreglo plano basado en las cabeceras
     * para poder insertarlo en la hoja.
     */
    async appendObject(spreadsheetId: string, sheetName: string, data: any) {
        const values = await this.getValues(spreadsheetId, `${sheetName}!1:1`);
        const headers = values[0] || [];

        // Mapeamos el objeto al orden de las columnas de la hoja
        const row = headers.map(header => data[header] ?? '');

        try {
            return await this.googleAuthService.sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [row] },
            });
        } catch (error) {
            throw new InternalServerErrorException('Error al escribir en Google Sheets.');
        }
    }

    /**
     * Método para limpiar el rango (Asegúrate de que sea public o private según necesites)
     */
    async clearRange(spreadsheetId: string, range: string): Promise<void> {
        await this.googleAuthService.sheets.spreadsheets.values.clear({
            spreadsheetId,
            range,
        });
    }

    /**
     * Retorna todos los registros de la hoja (usando caché)
     * Parametros: 
     *   none
     * Retorna: Entidad encontrada
     * Ejemplo: 
     *   await this.repository.findAll();
     */
    /**
 * Busca todos los registros de la hoja.
 * Implementa caché de capa superior (objetos ya mapeados).
 */
    async findAll(): Promise<T[]> {
        // Usamos el nombre de la clase de la entidad como nombre de la hoja
        const sheetName = this.EntityClass.name;
        const cacheKey = `list:${sheetName}`;

        // 1. Intentar obtener de caché (Lista de objetos tipados)
        const cached = await this.cacheManager.get<T[]>(cacheKey);
        if (cached) return cached;

        // 2. Consultar Google (Aprovechamos el caché de infraestructura que ya creamos)
        const rows = await this.getOrFetchSheet(sheetName);

        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        const dataRows = rows.slice(1);

        // 3. Mapear de filas a objetos
        // Usamos el EntityClass que definimos como protected abstract
        const entities = dataRows.map(row => {
            // Aquí podrías usar la lógica de conversión de tipos que hicimos en findRawWithIndex
            return this.mapRowToEntity(headers, row);
        });

        // 4. Guardar en caché (TTL opcional, por defecto el global)
        await this.cacheManager.set(cacheKey, entities);

        return entities;
    }

    /**
 * Transforma una fila cruda en una instancia de la entidad T
 * respetando los tipos definidos en los decoradores.
 */
    protected mapRowToEntity(headers: string[], row: any[]): T {
        // Instanciamos la clase (ej: new Obrero())
        const entity = new this.EntityClass();

        // Obtenemos las propiedades decoradas desde el prototipo
        const target = this.EntityClass.prototype;
        const columns: string[] = Reflect.getMetadata(TABLE_COLUMNS_METADATA_KEY, target) || [];

        columns.forEach(propKey => {
            const options = Reflect.getMetadata(TABLE_COLUMN_KEY, target, propKey);
            if (options) {
                const colName = options.name || propKey;
                const colIndex = headers.indexOf(colName);

                if (colIndex !== -1) {
                    const rawValue = row[colIndex];
                    // Usamos la lógica de casting que ya definimos (puedes mover castValue a una utilidad)
                    (entity as any)[propKey] = SheetMapper.castValue(rawValue, options.type, options.default);
                }
            }
        });

        return entity;
    }

    async deleteRow(spreadsheetId: string, sheetId: number, rowIndex: number) {
        try {
            return await this.googleAuthService.sheets.spreadsheets.batchUpdate({
                spreadsheetId,
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
        } catch (error) {
            throw new InternalServerErrorException('No se pudo eliminar la fila.');
        }
    }

    // src/database/google-sheets/google-sheets.service.ts

    /**
     * Obtiene la información estructural del documento (Metadatos).
     * @param spreadsheetId El ID del documento de Google Sheets.
     * @returns Un objeto con las propiedades del documento y la lista de hojas.
     */
    // src/database/google-sheets/google-sheets.service.ts

    /**
     * Obtiene la información estructural del Spreadsheet (título, hojas, configuración).
     * Útil para verificar conectividad y existencia de pestañas.
     */
    async getSpreadsheetMetadata(): Promise<any> {
        try {
            // La llamada .get() sin rangos solo trae los metadatos del archivo
            const response = await this.googleAuthService.sheets.spreadsheets.get({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                includeGridData: false, // Importante: NO descarga los datos de las celdas
            });

            return response.data;
        } catch (error) {
            this.logger.error(`Error al obtener metadatos de la hoja [${this.optionsDatabase.defaultSpreadsheetId}]: ${error.message}`);

            // Manejo específico de errores para el Health Check
            if (error.status === 404) {
                throw new Error('El archivo de Google Sheets no fue encontrado (ID incorrecto).');
            }
            if (error.status === 403) {
                throw new Error('La cuenta de servicio no tiene permisos de lectura sobre este archivo.');
            }

            throw error;
        }
    }

}
