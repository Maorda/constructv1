import { SHEETS_COLUMN_LIST, TABLE_COLUMN_KEY } from "@database/constants/metadata.constants";
import { ColumnOptions } from "@database/decorators/column.decorator";
import { ClassType } from "@database/types/query.types";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ISheetSchemaManager } from "./interfaces/sheet.mapper.interface";
import { SheetsDataGateway } from "@database/services/sheetDataGateway/sheetDataGateway";
import { DatabaseModuleOptions } from "@database/interfaces/database.options.interface";
import { GoogleAutenticarService } from "@database/services/auth.google.service";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";

@Injectable()
export class SheetSchemaManager<T extends object> implements ISheetSchemaManager {

    constructor(
        @Inject('DATABASE_OPTIONS') protected readonly optionsDatabase: DatabaseModuleOptions,
        private readonly googleAuthService: GoogleAutenticarService,
        private readonly gateway: SheetsDataGateway<T>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) { }
    private columnDetails: Record<string, ColumnOptions> = {};
    private readonly logger = new Logger(SheetSchemaManager.name);

    public initialize(entityClass: ClassType<any>): void {
        const props: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass.prototype) || [];
        this.columnDetails = {};

        props.forEach(propKey => {
            this.columnDetails[propKey] = Reflect.getMetadata(TABLE_COLUMN_KEY, entityClass.prototype, propKey);
        });
    }

    public getColumnDetails(): Record<string, ColumnOptions> {
        return this.columnDetails;
    }
    /**
         * Sincroniza el esquema de la hoja de Google Sheets.
         * Compara las cabeceras actuales con las definidas en los decoradores de la Entidad.
         */
    async syncSchema(force: boolean = false): Promise<void> {
        const spreadsheetId = this.optionsDatabase.SPREADSHEET_ID;
        const sheetName = this.gateway.sheetName; //this.EntityClass.name;

        try {
            // Fuente de verdad: Metadatos del código (con tu caché)
            const expected = await this.gateway.getHeaders();
            const headerRange = this.getFullRange(sheetName, '1:1');

            // Realidad actual: Fila 1 de Google Sheets (sin caché)
            const response = await this.googleAuthService.sheets.spreadsheets.values.get({
                spreadsheetId: this.optionsDatabase.SPREADSHEET_ID,
                range: headerRange,
            });
            const current = response.data.values?.[0] || [];

            // Validación usando el nuevo método
            if (force || this.checkDesync(expected, current)) {
                this.logger.warn(`Desincronización detectada en ${sheetName}. Actualizando...`);

                await this.gateway.updateRowRaw(spreadsheetId, `${sheetName}!1:1`, [expected]);

                // Opcional: Limpiar el caché después de actualizar para asegurar consistencia
                await this.cacheManager.del(`headers_strict:${sheetName}`);
            }
        } catch (error) {
            this.logger.error(`Error en sync: ${error.message}`);
        }
    }


    /**
    * Compara los encabezados esperados (código) con los actuales (Google Sheets).
    * @returns true si hay un desajuste y se requiere sincronización.
    */
    public checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
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
     * Obtiene los nombres de las columnas (headers) definidos en los decoradores @Column
     */
    public getColumnHeaders(EntityClass: ClassType<any>): string[] {
        // 1. Buscamos la lista de propiedades (el array ['dni', 'nombres', etc.])
        // Intentamos primero en la Clase (Constructor), que es donde el decorador Column lo inyecta.
        const props: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, EntityClass);

        if (!props || props.length === 0) {
            // Log de ayuda para debuguear en la consola de NestJS
            console.error(`[Metadata Error] No se encontraron columnas para: ${EntityClass.name}. 
        Verifica que las propiedades tengan el decorador @Column() y que estés importando 'reflect-metadata'.`);

            throw new Error(`La entidad ${EntityClass.name} no tiene columnas decoradas.`);
        }

        // 2. Mapeamos cada propiedad TS a su nombre de cabecera en Google Sheets
        return props.map(key => {
            // Los detalles de cada columna (@Column options) SIEMPRE están en el prototipo
            const options = Reflect.getMetadata(
                TABLE_COLUMN_KEY,
                EntityClass.prototype,
                key
            ) as ColumnOptions;

            // Si existe el nombre decorado (ej: "DNI_OBRERO"), lo usamos. 
            // Si no, usamos el nombre de la variable (ej: "dni").
            return options?.name || String(key);
        });
    }

    public getPropertyKeyByColumnName(entityClass: ClassType<any>, columnName: string): string | undefined {
        const target = entityClass.prototype;

        // 1. CORRECCIÓN: Usar la constante unificada SHEETS_COLUMN_LIST
        const columns: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass) || [];

        return columns.find(key => {
            // Los detalles individuales están en el prototipo
            const options: ColumnOptions = Reflect.getMetadata(TABLE_COLUMN_KEY, target, key);

            // Comparamos de forma segura ignorando mayúsculas/minúsculas y espacios
            const currentColumnName = options?.name || String(key);
            return currentColumnName.trim().toLowerCase() === columnName.trim().toLowerCase();
        });
    }

    public getFullRange(sheetName: string, specificRange: string): string {
        return `'${sheetName}'!${specificRange}`;
    }

}
