// persistence.manager.ts
import { Injectable, Logger, Inject, InternalServerErrorException } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { SheetsDataGateway } from '../services/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { BaseEngine } from '../engines/Base.Engine';
import { ClassType } from '@database/types/query.types';
import { ManipulateEngine } from './manipulateEngine';
import { BaseEntity } from '@database/entities/base.entity';
import { GLOBAL_RELATION_REGISTRY, RELATION_METADATA_KEY, RelationOptions } from '@database/decorators/relation.decorator';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { GettersEngine } from './getters.engine';
import { getColumnLetter } from '@database/utils/tools';
import { RepositoryContext } from '@database/repositories/repository.context';
import { PRIMARY_KEY_METADATA_KEY } from '@database/decorators/primarykey.decorator';
import { ColumnOptions, TABLE_COLUMN_DETAILS_KEY, TABLE_COLUMNS_METADATA_KEY } from '@database/decorators/column.decorator';
import { IPersistenceEngine } from '@database/interfaces/engine/IPersistence.engine';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { TABLE_NAME_KEY } from '@database/decorators/table.decorator';



@Injectable()
export class PersistenceEngine<T> implements IPersistenceEngine {

    private readonly logger = new Logger(PersistenceEngine.name);
    private readonly resolvedSheetName: string;
    private readonly primaryKeyProp: string;
    private readonly columnDetails: Record<string, ColumnOptions>;
    private currentHeaders: string[] = [];

    constructor(
        private readonly entityClass: new () => T,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly manipulateEngine: ManipulateEngine<T>,
        private readonly mapper: SheetMapper<T>,
        private readonly googleSpreadsheetService: GoogleAutenticarService,
        private readonly gettersEngine: GettersEngine<T>,

    ) {
        // 1. Resolvemos el nombre de la hoja (usando @Table)
        this.resolvedSheetName = Reflect.getMetadata(TABLE_NAME_KEY, this.entityClass)
            || NamingStrategy.formatSheetName(this.entityClass.name);

        // 2. Pre-cargamos la Primary Key (evita Reflect.getMetadata en cada save)
        this.primaryKeyProp = Reflect.getMetadata(PRIMARY_KEY_METADATA_KEY, this.entityClass.prototype) || 'id';

        // 3. Pre-cargamos el mapa de detalles para conversiones rápidas antes de enviar a Google Sheets
        this.columnDetails = Reflect.getMetadata(TABLE_COLUMN_DETAILS_KEY, this.entityClass.prototype) || {};
    }
    async save<T extends object>(entity: T): Promise<T> {
        throw new Error('Method not implemented.');
    }
    /**
     * CREATE: Procesa y guarda un nuevo registro en Google Sheets.
     */
    async create<T extends object>(entity: T): Promise<T> {
        const sheetName = this.resolvedSheetName;

        // 1. Obtener encabezados desde el motor de lectura (Aprovecha el caché)
        const rawData = await this.gettersEngine.getOrFetchSheet(sheetName);
        const headers = rawData && rawData.length > 0 ? rawData[0] : [];

        if (headers.length === 0) {
            throw new InternalServerErrorException(`Estructura de hoja no encontrada: ${sheetName}`);
        }

        // 2. Mapeo Profesional (Inverso)
        // Usamos el SheetMapper con el mapa de detalles que ya conoce los tipos (Soles, Fechas, etc.)
        const row = SheetMapper.mapToRow(headers, entity, this.columnDetails);

        try {
            // 3. Persistencia física
            await this.gateway.appendRows(
                this.optionsDatabase.defaultSpreadsheetId,
                `${sheetName}!A1`,
                [row]
            );

            // 4. Mantenimiento de Caché
            // Invalida la lista para que el usuario vea su nuevo registro inmediatamente
            await this.clearCache(sheetName);

            return entity;
        } catch (error) {
            throw new InternalServerErrorException('Error al persistir en Google Sheets.');
        }
    }
    async update<T extends object>(id: string | number, entity: T): Promise<T> {
        throw new Error('Method not implemented.');
    }

    async delete<T extends object>(id: string | number): Promise<void> {
        throw new Error('Method not implemented.');
    }
    async exists<T extends object>(id: string | number): Promise<boolean> {
        throw new Error('Method not implemented.');
    }
    /**
 * Actualiza parcialmente una entidad usando su índice de fila interno.
 */
    async updateEntity(entity: T, changes: Partial<T>): Promise<void> {
        const rowIndex = (entity as any).__row;

        if (rowIndex === undefined) {
            throw new Error("No se puede actualizar una entidad que no tiene un índice de fila (__row).");
        }

        // Ejecutamos la actualización parcial que ya configuramos con BatchUpdate
        await this.updatePartialBatch(rowIndex, changes);

        // Opcional: Actualizamos el objeto en memoria para que refleje los cambios
        Object.assign(entity, changes);
    }

    /*
      * Descripcion: Limpia el caché de la hoja, Invalida todos 
      * los niveles de caché relacionados con una hoja específica
      * Se ubica en PersistenceEngine porque este motor conoce la estructura 
      * de almacenamiento en Google Sheets.
      * Parametros: 
      *   sheetName: Nombre de la hoja
      * Retorna: void
    */
    /**
 * 
 */
    private async clearCache(sheetName: string): Promise<void> {
        const spreadsheetId = this.optionsDatabase.defaultSpreadsheetId;

        // Definimos las llaves que queremos limpiar
        const keys = [
            `sheet_data:${spreadsheetId}:${sheetName}`, // Data cruda (infraestructura)
            `list:${sheetName}`,                        // Lista de entidades (dominio)
        ];

        try {
            // Ejecución en paralelo para máxima velocidad
            await Promise.all(keys.map(key => this.cacheManager.del(key)));

            this.logger.debug(`[Cache] Memoria invalidada para la hoja: "${sheetName}"`);
        } catch (error) {
            this.logger.error(`[Cache] Error al intentar limpiar caché de ${sheetName}: ${error.message}`);
            // No lanzamos error para no romper la ejecución principal (create/update)
            // ya que el caché eventualmente expirará por TTL.
        }
    }

    /**
     * Escribe o actualiza datos y limpia el caché correspondiente.
     */
    private async updateRow(sheetName: string, range: string, values: any[]): Promise<void> {
        await this.gateway.updateSheet(this.optionsDatabase.defaultSpreadsheetId, `${sheetName}!${range}`, [values]);
        await this.clearCache(sheetName);
    }

    /**
 * Actualización masiva de celdas basada en propiedades de la entidad.
 * @param rowIndex El índice de la fila (0 para la primera fila de datos, después del header).
 * @param changes Objeto parcial con los campos a actualizar { sueldo: 1500, estado: 'PAGADO' }.
 */
    async updatePartialBatch(rowIndex: number, changes: Partial<T>): Promise<void> {
        // 1. Sincronizar headers para saber en qué columnas están las propiedades
        await this.refreshHeaders();

        // 2. Construir el array de actualizaciones traduciendo propKeys a Rangos A1
        const updates = Object.entries(changes).map(([propKey, value]) => {
            const config = this.columnDetails[propKey];
            return {
                range: this.getCellRange(propKey, rowIndex), // Ahora currentHeaders ya existe
                value: value,
                type: config?.type
            };
        });

        // 3. Ejecutar el BatchUpdate que ya definimos
        await this.updateCellsBatch(updates);
    }

    /**
     * El método core que realiza la petición física.
     */
    async updateCellsBatch(updates: { range: string, value: any, type?: string }[]): Promise<void> {
        if (!updates || updates.length === 0) return;

        try {
            const data = updates.map(u => ({
                range: u.range,
                values: [[SheetMapper.prepareValueForSheet(u.value, u.type)]]
            }));

            await this.googleSpreadsheetService.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: this.optionsDatabase.defaultSpreadsheetId,
                requestBody: {
                    valueInputOption: 'USER_ENTERED',
                    data: data
                }
            });

            // Limpiar caché para que la siguiente lectura sea verídica
            await this.cacheManager.del(`sheet_data:${this.optionsDatabase.defaultSpreadsheetId}:${this.resolvedSheetName}`);

        } catch (error) {
            throw new InternalServerErrorException('Error al sincronizar celdas por lote.');
        }
    }

    /**
     * Asegura que tengamos los headers más recientes de la hoja.
     */
    private async refreshHeaders(): Promise<void> {
        const rawData = await this.gettersEngine.getOrFetchSheet(this.resolvedSheetName);
        this.currentHeaders = (rawData && rawData.length > 0) ? rawData[0] : [];

        if (this.currentHeaders.length === 0) {
            throw new Error(`No se pudieron obtener los encabezados de ${this.resolvedSheetName}`);
        }
    }

    /**
     * Resuelve la coordenada A1 para una propiedad específica y un índice de fila.
     */
    private getCellRange(propKey: string, rowIndex: number): string {
        // 1. Obtener la configuración de la columna para saber su nombre en Excel
        const config = this.columnDetails[propKey];
        const headerName = config?.name || propKey;

        // 2. Encontrar el índice de la columna en los headers actuales
        // (Esta lista de headers deberías tenerla cacheada o pasarla como argumento)
        const colIndex = this.currentHeaders.findIndex(
            h => h.trim().toLowerCase() === headerName.toLowerCase()
        );

        if (colIndex === -1) throw new Error(`Columna ${headerName} no encontrada en la hoja.`);

        // 3. Convertir índice (0, 1, 2...) a letra (A, B, C... AA, AB...)
        const colLetter = this.indexToColumnLetter(colIndex);

        // 4. Retornar rango (rowIndex + 2 porque la fila 1 son headers y Excel es base 1)
        return `${this.resolvedSheetName}!${colLetter}${rowIndex + 2}`;
    }

    /**
     * Convierte un índice numérico a letras de columna de Excel (0 -> A, 26 -> AA).
     */
    private indexToColumnLetter(index: number): string {
        let temp = index;
        let letter = '';
        while (temp >= 0) {
            letter = String.fromCharCode((temp % 26) + 65) + letter;
            temp = Math.floor(temp / 26) - 1;
        }
        return letter;
    }



}

