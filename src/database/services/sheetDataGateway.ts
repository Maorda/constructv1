import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleAutenticarService } from './auth.google.service';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { ISheetDataGateway, SheetMetadata } from '@database/interfaces/ISheetDataGateway';
import { MetadataRegistry } from './metadata.registry';
import { withRetry } from '@database/utils/tools';
import { ClassType } from '@database/types/query.types';
import { RepositoryContext } from '@database/repositories/repository.context';
import { SHEETS_TABLE_NAME, TABLE_COLUMN_KEY } from '@database/constants/metadata.constants';
import { ColumnOptions } from '@database/decorators/column.decorator';


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


    ) {
        // Extraer el nombre real de la tabla desde el decorador @Table o aplicar fallback
        const decoratedName = Reflect.getMetadata(SHEETS_TABLE_NAME, this.EntityClass);
        this.sheetName = decoratedName || this.normalizeFallback(this.EntityClass.name);
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


}
