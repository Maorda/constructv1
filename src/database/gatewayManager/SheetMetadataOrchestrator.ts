import { Injectable, Logger } from "@nestjs/common";
import { ISheetMetadataContract, ISheetsApiContract } from "../services/sheetDataGateway/interfaces/sheets.contracts";
import { SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';
import { MetadataRegistry } from "../services/metadata.registry";
import { ISheetSchemaFactory, SchemaFactory } from "@database/schema/schema.factory";
import { ClassType } from "@database/types/query.types";


@Injectable()
export class SheetMetadataOrchestrator implements ISheetMetadataContract {
    private readonly logger = new Logger(SheetMetadataOrchestrator.name);
    // 🚀 Caché interna para evitar sobrecargar al Factory
    private readonly schemaCache = new Map<string, ISheetSchemaFactory<any>>();

    constructor(
        // 🔒 Dependencia estricta hacia las bases del Nivel 1
        private readonly metadataRegistry: MetadataRegistry
    ) { }

    async getHeaders(entityClass: any): Promise<string[]> {
        const schema = this.getSchema(entityClass);
        const columnMap = this.metadataRegistry.getColumnMap(entityClass);

        if (!columnMap || Object.keys(columnMap).length === 0) {
            throw new Error(`La entidad ${entityClass.name} no tiene columnas decoradas con @Column.`);
        }

        // Respetamos el orden físico usando el mapa del registry
        const orderedKeys = Object.keys(columnMap).sort((a, b) => columnMap[a] - columnMap[b]);
        return orderedKeys.map(key => schema.columns[key]?.name || key);
    }

    async syncSchema(api: ISheetsApiContract, sheetName: string, entityClass: any): Promise<void> {
        const expectedHeaders = await this.getHeaders(entityClass);

        try {
            const response = await api.execute(async (sheets) => {
                return await sheets.spreadsheets.values.get({
                    spreadsheetId: (api as any).optionsDatabase?.SPREADSHEET_ID,
                    range: `${sheetName}!A1:Z1`,
                });
            });

            const currentHeaders = response.data.values?.[0] || [];
            const isDesynced = this.checkDesync(expectedHeaders, currentHeaders);

            if (currentHeaders.length === 0 || isDesynced) {
                this.logger.warn(`[Metadata] Desincronización detectada en "${sheetName}". Actualizando cabeceras físicas...`);

                await api.execute(async (sheets) => {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: (api as any).optionsDatabase?.SPREADSHEET_ID,
                        range: `${sheetName}!A1`,
                        valueInputOption: 'USER_ENTERED',
                        requestBody: { values: [expectedHeaders] },
                    });
                });
                this.logger.log(`[Metadata] Esquema sincronizado inmaculadamente para la pestaña: ${sheetName}`);
            }
        } catch (error: any) {
            this.logger.error(`Error crítico al sincronizar esquema en ${sheetName}: ${error.message}`);
            throw error;
        }
    }
    mapObjectToRowArray<T>(entity: T, headers: string[]): any[] {
        const entityClass = (entity as any).constructor;
        const columnMap = this.metadataRegistry.getColumnMap(entityClass);
        const columnDetails = this.metadataRegistry.getColumnDetails(entityClass);
        const row: any[] = [];

        Object.keys(columnMap).forEach((logicalKey) => {
            const index = columnMap[logicalKey];
            const physicalKey = columnDetails[logicalKey]?.name || logicalKey;

            let value = (entity as any)[logicalKey] ??
                (entity as any)[physicalKey] ??
                (entity as any)[physicalKey.replace(/_/g, '')] ??
                (entity as any)[logicalKey.toUpperCase()];

            if (value instanceof Date) value = value.toISOString();
            if (typeof value === 'object' && value !== null) value = JSON.stringify(value);
            if (value === undefined) value = null;

            row[index] = value;
        });

        return row;
    }
    public resolveSheetName(entityClass: ClassType<any>): string {
        const schema = this.getSchema(entityClass);
        return schema.sheetName;
    }

    /**
        * Compara los encabezados esperados (código) con los actuales (Google Sheets).
        * @returns true si hay un desajuste y se requiere sincronización.
        */
    public checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
        if (expectedHeaders.length !== currentHeaders.length) return true;

        return expectedHeaders.some((expected, index) => {
            const current = currentHeaders[index];
            const normalizedExpected = String(expected || '').trim().toUpperCase();
            const normalizedCurrent = String(current || '').trim().toUpperCase();
            return normalizedExpected !== normalizedCurrent;
        });
    }
    private normalizeFallback(className: string): string {
        // Remover sufijos comunes de la arquitectura
        let name = className.replace(/(Entity|Model|Schema|Repository)$/i, '');

        // Regla de pluralización básica en español
        const lastChar = name.slice(-1).toLowerCase();
        if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
            name = `${name}s`;
        } else {
            name = `${name}es`;
        }

        return name.toUpperCase();
    }

    /**
     * Punto centralizado para obtener un esquema completo
     */
    public getSchema(entityClass: ClassType<any>): ISheetSchemaFactory<any> {
        const className = entityClass.name;
        if (this.schemaCache.has(className)) {
            return this.schemaCache.get(className)!;
        }

        // Uso directo de la fábrica
        const schema = SchemaFactory.createForClass(entityClass);
        this.schemaCache.set(className, schema);
        return schema;
    }
    /**
     * Facilita la conversión de nombres de columnas de hoja a nombres de propiedades de clase
     */
    /*public resolvePropertyKey(entityClass: ClassType<any>, columnName: string): string | undefined {
        return this.schemaManager.getPropertyKeyByColumnName(entityClass, columnName);
    }*/



}