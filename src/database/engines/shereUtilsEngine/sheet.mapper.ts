import 'reflect-metadata';
import { ColumnOptions } from '../../decorators/column.decorator';
import dayjs, { tz } from 'dayjs';
// Usamos require para evitar el error de compilación de módulos, 
// pero mantenemos la lógica de tipos de Day.js
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { Inject, InternalServerErrorException, Logger } from '@nestjs/common';
import { DatabaseModuleOptions } from '@database/interfaces/database.options.interface';
import { GoogleAutenticarService } from '@database/services/auth.google.service';
import { SheetsDataGateway } from '@database/services/sheetDataGateway/sheetDataGateway';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager'; // <--- Asegúrate de que venga de aquí
import { GettersEngine } from '@database/engine/getters.engine';
import { ClassType } from '@database/types/query.types';


// Extendemos dayjs
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
import {
    SHEETS_COLUMN_LIST,
    TABLE_COLUMN_KEY
} from '@database/constants/metadata.constants';
import { SheetSchemaManager } from '../../gatewayManager/SheetSchemaManager';
import { SheetEntityBinder } from './SheetEntityBinder';
import { SheetDataTransformer } from './SheetDataTransformer';


/*
*Descripcion: Clase encargada de mapear entidades a filas de Google Sheets y viceversa
*/
export class SheetMapper<T extends object> {
    private readonly logger = new Logger(SheetMapper.name);
    private entityClass: ClassType<T>;

    constructor(
        private readonly binder: SheetEntityBinder<T>,
        private readonly schemaManager: SheetSchemaManager<T>,

        // Cache interno
    ) { }
    /**
     * Inicializa el mapper con la clase entidad y prepara los metadatos.
     */
    async initialize(entityClass: ClassType<T>): Promise<void> {
        this.entityClass = entityClass;
        // Delegamos la carga de metadatos al SchemaManager (que ya tiene caché)
        this.schemaManager.initialize(entityClass);
    }

    /**
     * Orquesta la sincronización del esquema en Google Sheets.
     */
    async syncSchema(force: boolean = false): Promise<void> {
        // El SchemaManager contiene la lógica de validación y sincronización
        await this.schemaManager.syncSchema(force);
    }

    /**
     * Método principal para mapear una entidad a una fila (Array).
     */
    public mapEntityToRow(entity: T, headers: string[]): any[] {
        if (!this.entityClass) {
            throw new Error("[SheetMapper] Mapper no inicializado. Llama a initialize() primero.");
        }
        return this.binder.mapEntityToRow(entity, headers, this.entityClass);
    }

    /**
     * Alias para compatibilidad con código existente.
     */
    public mapToRow(entity: T, headers: string[]): any[] {
        return this.mapEntityToRow(entity, headers);
    }

    /**
     * Alias para compatibilidad con código existente.
     */
    public entityToRow(entity: T, headers: string[]): any[] {
        return this.mapEntityToRow(entity, headers);
    }


}