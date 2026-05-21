import { SHEETS_COLUMN_LIST, SHEETS_TABLE_NAME, TABLE_COLUMN_KEY } from "@database/constants/metadata.constants";
import { ColumnOptions } from "@database/decorators/column.decorator";
import { ClassType } from "@database/types/query.types";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ISheetSchemaManager } from "../engines/shereUtilsEngine/interfaces/sheet.mapper.interface";
import { MetadataRegistry } from "@database/services/metadata.registry";
import { Cache } from "cache-manager";
import { CACHE_MANAGER } from "@nestjs/cache-manager";


@Injectable()
export class SheetSchemaManager implements ISheetSchemaManager {
    private columnDetails: Record<string, ColumnOptions> = {};
    private readonly logger = new Logger(SheetSchemaManager.name);

    constructor(
        private readonly metadataRegistry: MetadataRegistry, // Única fuente
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    ) { }
    syncSchema(force?: boolean): Promise<void> {
        throw new Error("Method not implemented.");
    }
    checkDesync(expectedHeaders: string[], currentHeaders: any[]): boolean {
        throw new Error("Method not implemented.");
    }
    public getPrimaryKey(EntityClass: ClassType<any>): string {
        const details = this.metadataRegistry.getColumnDetails(EntityClass);
        // Buscamos la propiedad marcada con la lógica de PrimaryKey 
        // (Asegúrate de tener un flag 'isPrimary: true' en tus ColumnOptions o una convención)
        const pkProp = Object.keys(details).find(key => details[key].isPrimary); // Asumiendo que añades 'isPrimary'

        if (!pkProp) {
            throw new Error(`La entidad ${EntityClass.name} requiere una propiedad con 'isPrimary: true' en ColumnOptions.`);
        }
        return pkProp;
    }


    public initialize(entityClass: ClassType<any>): void {
        const props: string[] = Reflect.getMetadata(SHEETS_COLUMN_LIST, entityClass.prototype) || [];
        this.columnDetails = {};

        props.forEach(propKey => {
            this.columnDetails[propKey] = Reflect.getMetadata(TABLE_COLUMN_KEY, entityClass.prototype, propKey);
        });
    }

    public getColumnDetails(entityClass: ClassType<any>): Record<string, ColumnOptions> {
        return this.metadataRegistry.getColumnDetails(entityClass);
    }

    /**
         * Resuelve el nombre de la hoja leyendo directamente la metadata de la clase
         */
    public resolveSheetName(entityClass: ClassType<any>): string {
        const decoratedName = Reflect.getMetadata(SHEETS_TABLE_NAME, entityClass);
        if (decoratedName) return decoratedName;

        // Fallback de pluralización si no tiene decorador explícito
        let baseName = entityClass.name.replace(/(Entity|Model|Schema)$/i, '');
        const lastChar = baseName.slice(-1).toLowerCase();
        return ['a', 'e', 'i', 'o', 'u'].includes(lastChar)
            ? `${baseName}S`.toUpperCase()
            : `${baseName}ES`.toUpperCase();
    }
    /**
     * Obtiene los nombres de las columnas (headers) definidos en los decoradores @Column
     */
    public getColumnHeaders(EntityClass: ClassType<any>): string[] {
        const columnMap = this.metadataRegistry.getColumnMap(EntityClass);
        const details = this.metadataRegistry.getColumnDetails(EntityClass);

        if (!columnMap || Object.keys(columnMap).length === 0) {
            throw new Error(`La entidad ${EntityClass.name} no tiene columnas decoradas.`);
        }

        // Ordenamos basándonos en el índice posicional guardado por el decorador
        const orderedKeys = Object.keys(columnMap).sort((a, b) => columnMap[a] - columnMap[b]);

        return orderedKeys.map(key => {
            const options = details[key];
            return options?.name || key;
        });
    }

    public getPropertyKeyByColumnName(entityClass: ClassType<any>, columnName: string): string | undefined {
        const details = this.metadataRegistry.getColumnDetails(entityClass);

        return Object.keys(details).find(key => {
            const options = details[key];
            const currentColumnName = options?.name || key;
            return currentColumnName.trim().toLowerCase() === columnName.trim().toLowerCase();
        });

    }

    public getFullRange(sheetName: string, specificRange: string): string {
        return `'${sheetName}'!${specificRange}`;
    }

}
