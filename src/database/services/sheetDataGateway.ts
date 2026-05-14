import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { TABLE_COLUMN_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { ISheetDataGateway, SheetMetadata } from '@database/interfaces/ISheetDataGateway';
import { PersistenceEngine } from '@database/engine/persistence.engine';
import { MetadataRegistry } from './metadata.registry';
import { withRetry } from '@database/utils/tools';
import { ClassType } from '@database/types/query.types';
import { RepositoryContext } from '@database/repositories/repository.context';


@Injectable()
export class SheetsDataGateway<T extends object> implements ISheetDataGateway {
    private readonly logger = new Logger(SheetsDataGateway.name);
    private isSynced = false;
    private sheetIdCache = new Map<string, number>();
    protected headers: string[] = [];
    public sheetName: string;
    constructor(

        private readonly googleAuthService: GoogleAutenticarService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly EntityClass: new () => T,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly sheetMapper: SheetMapper<T>,
        private readonly ctx?: RepositoryContext<T> // <--- NUEVO INYECTADO


    ) { }
    async updateCellsBatch(data: any): Promise<void> {

        try {

            return await this.googleAuthService.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: data
                }
            })


        } catch (error) {
            const status = error?.status || error?.response?.status;
            if (status === 429) {
                this.logger.error("Se ha agotado la cuota de la API de Google Sheets. Espera un momento.");
            } else {
                this.logger.error(`Fallo definitivo tras reintentos: ${error.message}`);
            }
            throw new InternalServerErrorException('No se pudo sincronizar con Google Sheets tras varios intentos.');
        }
    }
    async getSheetIdByName(spreadsheetId: string, sheetName: string): Promise<number> {
        try {
            // Obtenemos los metadatos del documento completo
            const response = await this.googleAuthService.sheets.spreadsheets.get({
                spreadsheetId: spreadsheetId,
            });

            const sheets = response.data.sheets;
            // Buscamos la hoja que coincida con el nombre
            const sheet = sheets?.find(s => s.properties?.title === sheetName);

            if (!sheet || sheet.properties?.sheetId === undefined) {
                throw new Error(`No se encontró el sheetId para la hoja: ${sheetName}`);
            }

            return sheet.properties.sheetId;
        } catch (error) {
            this.logger.error(`Error al obtener sheetId de ${sheetName}: ${error.message}`);
            throw new InternalServerErrorException('Error de comunicación con Google Sheets Metadata.');
        }
    }
    /**
 * Inserta una fila y devuelve la respuesta técnica de la API de Google.
 * @returns La respuesta de Google que contiene el rango actualizado.
 */
    async appendRow<T>(data: T): Promise<any> {
        const rowValues = this.mapObjectToRowArray(data);
        const range = `${this.sheetName}!A1`;

        // 1. Capturamos el resultado del append
        const response = await this.appendRange(range, [rowValues]);

        // 2. Retornamos la respuesta (que contiene updatedRange)
        return response;
    }

    /**
     * initialize: Método funcional llamado por el DatabaseConfigService.
     * Incluye un seguro de vida para esperar la inicialización del motor de Google.
     */
    async initialize(entity: ClassType<T>) {
        /**
         * SOLUCIÓN DEFINITIVA:
         * 1. Intentamos obtener el nombre que la Factory ya procesó y guardó en el contexto.
         * 2. Si por alguna razón no está, usamos la clave correcta del metadato.
         * 3. Como último recurso, aplicamos la normalización manual que definimos.
         */
        const processedName = this.ctx?.sheetName;
        const metadataName = Reflect.getMetadata('sheets:table_name', entity);

        this.sheetName = processedName || metadataName || this.normalizeFallback(entity.name);
        // Con el Getter, esto disparará la inicialización automáticamente si es necesario
        const client = this.googleAuthService.sheets;

        if (!client) {
            throw new Error(`No se pudo conectar con la API de Google para ${this.sheetName}`);
        }

        // --- BLOQUE DE SEGURIDAD: ESPERA ACTIVA ---
        // Dado que NestJS puede demorar milisegundos en propagar la instancia inyectada,
        // esperamos hasta 5 segundos (10 intentos de 500ms).
        let attempts = 0;
        while (!this.googleAuthService.sheets && attempts < 10) {
            this.logger.warn(`⏳ Esperando a que el motor de Google Sheets esté listo para: ${this.sheetName} (Intento ${attempts + 1})...`);
            await new Promise(res => setTimeout(res, 500));
            attempts++;
        }

        // Validación definitiva tras la espera
        if (!this.googleAuthService.sheets) {
            this.logger.error(`❌ El cliente de Google no se encontró en el servicio de autenticación.`);
            throw new Error(`GoogleAuthService.sheets no está inicializado para la entidad ${this.sheetName}`);
        }
        // --- FIN BLOQUE DE SEGURIDAD ---

        let isNewSheet = false;
        const propagationWait = 5000;
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                // Ahora es seguro llamar a getSpreadsheetMetadata
                const metadata = await this.getSpreadsheetMetadata();
                const existingSheets = metadata.sheets.map(s => s.properties.title);

                if (!existingSheets.includes(this.sheetName)) {
                    this.logger.warn(`🚀 Intento ${attempt}: Creando pestaña "${this.sheetName}"...`);
                    await this.createSheet(
                        this.optionsDatabase.defaultSpreadsheetId,
                        this.sheetName
                    );
                    isNewSheet = true;

                    // El "Respiro" ajustable para estabilidad en la red de Huaraz
                    this.logger.debug(`Esperando ${propagationWait}ms por estabilidad de red...`);
                    await new Promise(res => setTimeout(res, propagationWait));
                }

                // Sincronizar esquema (cabeceras)
                await this.sheetMapper.syncSchema(isNewSheet);
                this.isSynced = true;

                this.logger.log(`✅ Infraestructura lista para la entidad: ${this.sheetName}`);
                return; // Éxito total

            } catch (error) {
                this.logger.error(`⚠️ Fallo en intento ${attempt}/${maxRetries} para ${this.sheetName}: ${error.message}`);

                if (attempt === maxRetries) {
                    throw new Error(`Error fatal tras ${maxRetries} reintentos en la hoja ${this.sheetName}.`);
                }

                // Backoff exponencial simple: 5s, 10s, 15s...
                await new Promise(res => setTimeout(res, propagationWait * attempt));
            }
        }
    }

    /**
     * Hook de NestJS que se ejecuta al arrancar el módulo.
     * Garantiza que la infraestructura de Sheets esté lista.
     */
    /*async onModuleInit() {
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
    }*/

    async appendRange(range: string, values: any[][]): Promise<void> {
        try {
            const response = await this.googleAuthService.sheets.spreadsheets.values.append({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                range: range,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: { values },
            });

            return response.data; // <--- Crucial: retornar los datos de la respuesta
        } catch (error) {
            this.logger.error(`Error en Google API (Append): ${error.message}`);
            throw new Error('Fallo al añadir registros en la nube.');
        }
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
    async getAllRows<T>(sheetName: string): Promise<T[][]> {
        try {
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                range: sheetName, // Trae toda la hoja
            });

            const rows = response.data.values || [];

            // Retornamos la matriz completa (incluyendo headers)
            return rows;
        } catch (error) {
            this.logger.error(`Error al obtener datos de Sheets: ${error.message}`, error.stack);
            throw new InternalServerErrorException(
                `No se pudo leer la hoja: ${sheetName}. Verifica permisos e ID.`
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

    /**
   * Actualiza una fila específica en Google Sheets.
   * @param rowId Puede ser el valor de la PK o el índice físico __row
   * @param data Objeto con la data final procesada por el PersistenceEngine
   */
    async updateRow<T>(rowIndex: number, data: T): Promise<T> {
        // Recibe directamente el rowIndex (el __row)
        const range = `${this.sheetName}!A${rowIndex}`;
        const rowValues = this.mapObjectToRowArray(data);

        await this.updateRange(range, [rowValues]);
        return data;
    }
    async updateRange(range: string, values: any[][]): Promise<void> {
        try {
            await this.googleAuthService.sheets.spreadsheets.values.update({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                range: range,
                valueInputOption: 'USER_ENTERED', // Permite que Google Sheets interprete fechas/números
                requestBody: {
                    values: values,
                },
            });
        } catch (error) {
            this.logger.error(`Error de API Google Sheets: ${error.message}`);
            throw new Error('No se pudo persistir la información en la nube.');
        }
    }

    /**
     * Convierte el objeto en un array siguiendo el orden de las columnas de la hoja.
     */
    /**  /**
     * Convierte el objeto en un array siguiendo el orden de las columnas de la hoja.
     */
    private mapObjectToRowArray<T>(data: T): any[] {
        // Obtenemos el mapa de columnas (ej: { nombre: 0, dni: 1, fecha: 2 })
        const columnMap = this.metadataRegistry.getColumnMap(this.EntityClass);
        const row: any[] = [];

        Object.keys(columnMap).forEach((key) => {
            const index = columnMap[key];
            let value = (data as any)[key];

            // Normalización de tipos para Sheets
            if (value instanceof Date) value = value.toISOString();
            if (typeof value === 'object' && value !== null) value = JSON.stringify(value);
            if (value === undefined) value = null;

            row[index] = value;
        });

        return row;
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
    /**
 * Limpia físicamente el contenido de una fila específica.
 * @param physicalRow Número de fila físico en Google Sheets.
 */
    async clearRow(physicalRow: number): Promise<void> {
        // Definimos el rango de la fila completa (ej: "USUARIOS!10:10")
        const range = `${this.sheetName}!${physicalRow}:${physicalRow}`;

        try {
            await withRetry(async () => {
                await this.googleAuthService.sheets.spreadsheets.values.clear({
                    spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                    range: range,
                });
            }, 3, 1000);

            this.logger.debug(`Fila ${physicalRow} limpiada físicamente en ${this.sheetName}`);
        } catch (error) {
            this.logger.error(`Error al limpiar fila ${physicalRow}: ${error.message}`);
            throw new InternalServerErrorException(`No se pudo realizar el borrado físico en la fila ${physicalRow}`);
        }
    }
    private normalizeFallback(className: string): string {
        let name = className.replace(/(Entity|Model|Schema)$/i, '');
        if (['a', 'e', 'i', 'o', 'u'].includes(name.slice(-1).toLowerCase())) {
            name = `${name}s`;
        } else {
            name = `${name}es`;
        }
        return name.toUpperCase();
    }






}
