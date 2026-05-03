import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { TABLE_COLUMN_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { ISheetDataGateway, SheetMetadata } from '@database/interfaces/ISheetDataGateway';
import { PersistenceEngine } from '@database/engine/persistence.engine';


@Injectable()
export class SheetsDataGateway<T> implements ISheetDataGateway, OnModuleInit {
    private readonly logger = new Logger(SheetsDataGateway.name);
    private isSynced = false;
    private sheetIdCache = new Map<string, number>();
    protected headers: string[] = [];
    private sheetName: string;
    constructor(

        private readonly googleAuthService: GoogleAutenticarService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly EntityClass: new () => T,
        private readonly sheetMapper: SheetMapper<T>,
        private readonly persistenceEngine: PersistenceEngine,

    ) { }

    async initialize(sheetName: string) {
        let isNewSheet = false;
        // Ajustamos el tiempo de respiro según tu necesidad actual (ej. 5 segundos)
        const propagationWait = 5000;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const metadata = await this.getSpreadsheetMetadata();
                const existingSheets = metadata.sheets.map(s => s.properties.title);

                if (!existingSheets.includes(sheetName)) {
                    this.logger.warn(`🚀 Intento ${attempt}: Creando pestaña "${sheetName}"...`);
                    await this.createSheet(
                        this.optionsDatabase.defaultSpreadsheetId,
                        sheetName
                    );
                    isNewSheet = true;

                    // Aplicamos el "Respiro" ajustable
                    this.logger.debug(`Esperando ${propagationWait}ms por estabilidad de red...`);
                    await new Promise(res => setTimeout(res, propagationWait));
                }

                // Si llegamos aquí, la infraestructura física existe
                await this.sheetMapper.syncSchema(isNewSheet);
                this.isSynced = true;
                return; // Éxito: salimos del bucle de reintentos

            } catch (error) {
                this.logger.error(`⚠️ Fallo en intento ${attempt}/${maxRetries} para ${sheetName}: ${error.message}`);

                if (attempt === maxRetries) {
                    throw new InternalServerErrorException(
                        `Error tras ${maxRetries} reintentos. Revisa la conexión en Huaraz.`
                    );
                }

                // Esperar un poco más en cada reintento (backoff exponencial simple)
                await new Promise(res => setTimeout(res, propagationWait * attempt));
            }
        }
    }

    /**
     * Hook de NestJS que se ejecuta al arrancar el módulo.
     * Garantiza que la infraestructura de Sheets esté lista.
     */
    async onModuleInit() {
        this.logger.log(`🎬 Iniciando validación de infraestructura (Entidad: ${this.EntityClass.name})`);

        try {
            // Ejecutamos la inicialización robusta
            await this.initialize(this.EntityClass.name);
            this.logger.log(`✅ Sincronización exitosa para ${this.EntityClass.name}`);
        } catch (error) {
            // Si después de los reintentos falla, detenemos el proceso
            this.logger.error(`🛑 Error fatal: El servidor no puede arrancar sin acceso a Google Sheets.`);
            process.exit(1); // Opcional: cierra el proceso para que un orquestador (como PM2) lo reinicie
        }
    }
    /**
       * Garantiza que los encabezados estén cargados en memoria.
       * Si ya existen, no hace nada; si no, los trae de la API.
       */
    async ensureSchemaTemporal(sheetName: string): Promise<void> {
        if (this.headers.length > 0) return;

        // Obtenemos solo la primera fila (los encabezados) para ahorrar cuota
        const rows = await this.getAllRows<T>(sheetName);

        if (!rows || rows.length === 0) {
            throw new Error(`No se pudieron encontrar encabezados en la pestaña ${sheetName}`);
        }

        this.headers = rows[0] as string[];
    }

    /*
    *Descripcion: Asegura que el esquema de la hoja de Google Sheets esté sincronizado
    * Parametros: 
    *   none
    * Retorna: void
    */
    async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.sheetMapper.syncSchema();
        this.isSynced = true;
    }

    /**
     * Optiene los valores crudos de una hoja de cálculo
     * @param spreadsheetId ID de la hoja de cálculo
     * @param range Rango de celdas (ej. 'Hoja1!A1:Z100')
     * @returns Array de arrays con los valores de las celdas
     */
    async getAllRows<T>(sheetName: string): Promise<T[]> {
        try {
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                range: sheetName,
            });
            const rows = response.data.values || [];
            if (!rows || rows.length === 0) return [];

            const headers = rows[0];

            // Aquí es donde integras tu utilitario
            return rows.slice(1).map(row =>
                SheetMapper.mapFromRow(headers, row, this.EntityClass)
            );
        } catch (error) {
            // Logeamos el error internamente para depuración
            this.logger.error(`Error al obtener datos de Sheets: ${error.message}: ${sheetName}!A1:Z100`, error.stack);

            // Lanzamos una excepción que NestJS convertirá en una respuesta HTTP 500 clara
            throw new InternalServerErrorException(
                `No se pudo leer la hoja de cálculo. Verifica el ID: ${this.optionsDatabase.defaultSpreadsheetId}`
            );
        }
    }
    async addRow<T>(sheetName: string, entity: T): Promise<void> {
        // 1. Transformamos la entidad a fila (array de valores)
        const row = SheetMapper.entityToRow(entity);

        // 2. Validación de seguridad: No enviar filas vacías
        if (!row || row.length === 0) return;

        try {
            await this.googleAuthService.sheets.spreadsheets.values.append({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                // 'A1' le dice a Google: "Busca la tabla en esta hoja y añade al final"
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: {
                    values: [row] // Matriz con una sola fila
                },
            });
        } catch (error) {
            this.logger.error(`Error al insertar en ${sheetName}: ${error.message}`);
            throw new InternalServerErrorException('Error de persistencia en Google Sheets');
        }
    }

    updateRow(sheetName: string, rowId: string | number, data: any): Promise<any> {
        throw new Error('Method not implemented.');
    }
    batchGet(ranges: string[]): Promise<any> {
        throw new Error('Method not implemented.');
    }
    getSheetMetadata(sheetName: string): Promise<SheetMetadata> {
        throw new Error('Method not implemented.');
    }


    /*
    * Crea una hoja de cálculo.
    */
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

    /**
         * Convierte un objeto JSON a un arreglo plano basado en las cabeceras
         * para poder insertarlo en la hoja.
         */


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
     * 1. updateSheet (Sobrescritura Total)
     * Este método es útil para "re-indexar" o limpiar la base de datos.
     * Actualiza el contenido de una hoja de cálculo reemplazando todos los datos existentes.
     * @param spreadsheetId El ID del documento de Google Sheets.
     * @param sheetName El nombre de la hoja.
     * @param rows Los nuevos datos a escribir (array de arrays).
     */
    async updateSheet(spreadsheetId: string, sheetName: string, rows: any[][]): Promise<void> {
        try {
            // En lugar de borrar todo a ciegas (A:Z), 
            // limpiamos solo si hay datos para evitar dejar basura si el nuevo set es más pequeño.
            await this.clearRange(spreadsheetId, `${sheetName}!A:ZZ`); // Un rango más seguro

            await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: rows },
            });
            this.logger.log(`Hoja '${sheetName}' sincronizada con éxito.`);
        } catch (error) {
            this.logger.error(`Error en updateSheet: ${error.message}`);
            throw error;
        }
    }


    /**
     * 2. updateRowRaw (Sincronización de Esquemas)
     * Este método es excelente por su simplicidad. Es perfecto para 
     * sincronizar cabeceras. Al ser "Raw", no debe tener lógica de negocio, lo cual es correcto.
     * Escribe valores directamente en un rango sin procesar lógica de negocio.
     * Ideal para sincronización de esquemas (cabeceras).
     * Si ya conoces el número de fila (ej. Obreros!A5:Z5), es mucho más rápido que resubir toda la pestaña.
     * Solo afectas el rango A1:Z1, es instantáneo.
     */
    async updateRowRaw(spreadsheetId: string, range: string, values: any[][]): Promise<void> {
        if (!values || values.length === 0) return; // Guardia de seguridad
        try {
            await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values },
            });
        } catch (error) {
            this.logger.error(`Error en updateRowRaw [${range}]: ${error.message}`);
            throw error;
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
    async deleteRow(spreadsheetId: string, sheetId: number, rowIndex: number): Promise<void> {
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



    /**
     * getHeaders Estricto: 
     * Obtiene los encabezados UNICAMENTE de lo definido en los decoradores de la Entidad.
     */
    async getHeaders(): Promise<string[]> {

        const cacheKey = `headers_strict:${this.EntityClass.name}`;

        // 1. Intentar obtener de caché
        const cached = await this.cacheManager.get<string[]>(cacheKey);
        if (Array.isArray(cached) && cached.length > 0) return cached;

        // 2. Obtener encabezados mediante SheetMapper (vía metadatos de Reflection)
        // Esto asegura que el orden y los nombres sean los que TÚ definiste en el código
        const headers = SheetMapper.getColumnHeaders(this.EntityClass);

        if (!headers || headers.length === 0) {
            throw new Error(`La entidad ${this.EntityClass.name} no tiene columnas decoradas con @Column.`);
        }

        // 3. Guardar en caché
        await this.cacheManager.set(cacheKey, headers, 3600000); // 1 hora
        return headers;
    }

    /**
    * Compara los encabezados esperados (código) con los actuales (Google Sheets).
    * @returns true si hay un desajuste y se requiere sincronización.
    */
    private checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
        // 1. Si la longitud es distinta, hay desincronización inmediata
        if (expectedHeaders.length !== currentHeaders.length) {
            return true;
        }

        // 2. Comparamos cada elemento
        // Usamos .some() para que en cuanto encuentre uno diferente, devuelva true
        return expectedHeaders.some((expected, index) => {
            const current = currentHeaders[index];

            // Normalizamos ambos valores para una comparación justa:
            // - Convertimos a String (por si Google devuelve números o nulls)
            // - Quitamos espacios en blanco (.trim())
            // - Pasamos a Mayúsculas (.toUpperCase())
            const normalizedExpected = String(expected || '').trim().toUpperCase();
            const normalizedCurrent = String(current || '').trim().toUpperCase();

            return normalizedExpected !== normalizedCurrent;
        });
    }





}
