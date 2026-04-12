import { Inject, Injectable, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleSpreedsheetService } from '../services/google.spreedsheet.service';
import { SheetMapper } from '../mappers/sheet.mapper';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { TABLE_NAME_KEY } from '../decorators/table.decorator';
import { NamingStrategy } from '@database/strategy/naming.strategy';

@Injectable()
export abstract class BaseSheetsRepository<T extends object> {
    private isSynced = false; // Flag para no repetir el proceso

    protected abstract readonly EntityClass: new () => T;
    protected readonly logger = new Logger(this.constructor.name);

    @Inject(GoogleSpreedsheetService)
    protected readonly googleSheets: GoogleSpreedsheetService;

    public sheetName: string;

    constructor(

        @Inject('DATABASE_OPTIONS') protected readonly options: DatabaseModuleOptions,
    ) { }

    // src/database/repositories/base.sheets.repository.ts

    async initialize(sheetName: string) {
        this.sheetName = sheetName;
        let isNewSheet = false;

        try {
            const existingSheets = await this.googleSheets.getExistingSpreadsheetSheets(this.spreadsheetId);

            if (!existingSheets.includes(this.sheetName)) {
                this.logger.warn(`🚀 Pestaña "${this.sheetName}" no encontrada. Creándola...`);
                await this.googleSheets.createSheet(this.spreadsheetId, this.sheetName);
                isNewSheet = true;

                // Aumentamos a 1.5 segundos el respiro para Google
                await new Promise(res => setTimeout(res, 1500));
            }

            // Pasamos el flag isNewSheet para forzar la escritura
            await this.syncSchema(isNewSheet);

        } catch (error) {
            this.logger.error(`❌ Error en inicialización de ${this.sheetName}: ${error.message}`);
        }
    }

    // src/database/repositories/base.sheets.repository.ts

    async syncSchema(force: boolean = false): Promise<void> {

        const expectedHeaders = SheetMapper.getColumnHeaders(this.EntityClass);


        // Definimos cleanExpected: Limpiamos y convertimos a Mayúsculas
        const cleanExpected = expectedHeaders.map(h => String(h || '').trim().toUpperCase());

        // DIAGNÓSTICO 1: ¿Qué estamos intentando escribir?
        this.logger.debug(`[${this.sheetName}] Cabeceras esperadas: ${JSON.stringify(cleanExpected)}`);

        if (cleanExpected.length === 0) {
            this.logger.error(`❌ Error: No se encontraron decoradores @Column en ${this.EntityClass.name}`);
            return;
        }

        try {
            let currentHeaders: any[] = [];

            // Solo leemos si no estamos forzando la creación
            if (!force) {
                const range = `${this.sheetName}!A1:Z1`;
                const response = await this.googleSheets.getValues(this.spreadsheetId, range);
                currentHeaders = (response && response.length > 0) ? response[0] : [];
            }

            // Comparamos normalizando
            const isDesync = force ||
                cleanExpected.length !== currentHeaders.length ||
                cleanExpected.some((h, i) => String(currentHeaders[i] || '').trim().toUpperCase() !== h);

            if (isDesync) {
                this.logger.warn(`✍️ Escribiendo cabeceras en "${this.sheetName}"...`);

                // DIAGNÓSTICO 2: Verificamos antes de disparar la API
                console.log(`Enviando a Google -> SpreadsheetId: ${this.spreadsheetId}, Range: ${this.sheetName}!A1`);

                await this.googleSheets.updateRow(
                    this.spreadsheetId,
                    `${this.sheetName}!A1`,
                    [cleanExpected] // Debe ser una matriz: [ ["COL1", "COL2"] ]
                );

                this.logger.log(`✅ ¡Cabeceras enviadas a "${this.sheetName}" con éxito!`);
            } else {
                this.logger.log(`✅ Esquema de "${this.sheetName}" está al día.`);
            }
        } catch (error) {
            // DIAGNÓSTICO 3: Captura de error específico de la API
            this.logger.error(`❌ Error en syncSchema para ${this.sheetName}: ${error.message}`);
            if (error.response?.data) {
                console.error('Detalle de Google:', JSON.stringify(error.response.data, null, 2));
            }
        }
    }

    // src/database/repositories/base.sheets.repository.ts

    private async ensureSchema() {
        if (this.isSynced) return;

        // Ejecutamos la lógica de sincronización que escribimos antes
        await this.syncSchema();
        this.isSynced = true;
    }


    /**
     * Compara dos arrays de cabeceras de forma tolerante (sin espacios y en mayúsculas)
     */
    private checkDesync(expected: string[], current: any[]): boolean {
        // Si tienen diferente longitud, definitivamente están desincronizados
        if (expected.length !== current.length) return true;

        // Comparamos elemento por elemento normalizando el texto
        return expected.some((header, index) => {
            const normalize = (val: any) => String(val || '').trim().toUpperCase();
            return normalize(header) !== normalize(current[index]);
        });
    }

    /**
   * Actualiza un registro por un identificador (ej: DNI)
   */
    async update(identifierColumn: string, value: any, partialEntity: Partial<T>): Promise<T> {
        await this.ensureSchema();

        const range = `${this.sheetName}!A:Z`;
        const rows = await this.googleSheets.getValues(this.spreadsheetId, range);
        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(identifierColumn);

        if (colIndex === -1) throw new Error(`Columna ${identifierColumn} no encontrada`);

        const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[colIndex]) === String(value));
        if (rowIndex === -1) throw new NotFoundException('Registro no encontrado');

        // Mapear, fusionar y actualizar
        const currentData = SheetMapper.mapToEntity(headers, rows[rowIndex], this.EntityClass);
        const updatedData = Object.assign(currentData, partialEntity);
        const updatedRow = SheetMapper.mapToRow(headers, updatedData);

        // El rango es 1-based, por eso rowIndex + 1
        await this.googleSheets.updateRow(this.spreadsheetId, `${this.sheetName}!A${rowIndex + 1}`, [updatedRow]);
        return updatedData;
    }


    /**
     * Obtiene el ID del spreadsheet (usa el por defecto o el de env)
     */
    protected get spreadsheetId(): string {
        const id = this.options.defaultSpreadsheetId || process.env.SPREADSHEET_ID;
        if (!id) throw new Error(`No se encontró SPREADSHEET_ID para ${this.sheetName}`);
        return id;
    }

    /**
     * Busca todos los registros de la pestaña mapeados a la Entidad
     */
    async findAll(): Promise<T[]> {
        await this.ensureSchema();
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return [];

        const headers = rows[0] as string[];
        return rows.slice(1).map(row => SheetMapper.mapToEntity(headers, row, this.EntityClass));
    }

    /**
     * Busca un registro por una columna y valor específico
     */
    async findOneByColumn(columnName: string, value: any): Promise<T | null> {
        await this.ensureSchema();
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        if (!rows || rows.length <= 1) return null;

        const headers = rows[0] as string[];
        const colIndex = headers.indexOf(columnName);

        if (colIndex === -1) {
            this.logger.error(`La columna "${columnName}" no existe en la pestaña "${this.sheetName}"`);
            return null;
        }

        const foundRow = rows.slice(1).find(row => String(row[colIndex]) === String(value));
        return foundRow ? SheetMapper.mapToEntity(headers, foundRow, this.EntityClass) : null;
    }

    /**
   * Carga relaciones de forma inteligente (Uno a Uno o Uno a Muchos)
   */
    async populate(entity: T, relationName: keyof T): Promise<T> {
        await this.ensureSchema();
        const options: RelationOptions = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            this.EntityClass.prototype,
            relationName as string
        );

        if (!options) {
            this.logger.warn(`Propiedad "${String(relationName)}" no es una relación válida.`);
            return entity;
        }

        // 1. Obtener los datos de la pestaña destino
        const relRows = await this.googleSheets.getValues(this.spreadsheetId, `${options.targetSheet}!A:Z`);
        if (!relRows || relRows.length <= 1) {
            entity[relationName] = (options.isMany ? [] : null) as any;
            return entity;
        }

        const headers = relRows[0] as string[];
        const joinColIndex = headers.indexOf(options.joinColumn);
        const localValue = entity[options.localField];
        const TargetClass = options.targetEntity();

        if (joinColIndex === -1) {
            this.logger.error(`Columna de unión "${options.joinColumn}" no existe en "${options.targetSheet}"`);
            return entity;
        }

        // 2. Filtrar o buscar según el tipo de relación (isMany)
        const dataRows = relRows.slice(1);

        if (options.isMany) {
            // Caso: Uno a Muchos (ej: Empleado -> Adelantos[])
            const relatedEntities = dataRows
                .filter(row => String(row[joinColIndex]) === String(localValue))
                .map(row => SheetMapper.mapToEntity(headers, row, TargetClass));

            entity[relationName] = relatedEntities as any;
        } else {
            // Caso: Uno a Uno (ej: Adelanto -> Empleado)
            const foundRow = dataRows.find(row => String(row[joinColIndex]) === String(localValue));

            entity[relationName] = foundRow
                ? SheetMapper.mapToEntity(headers, foundRow, TargetClass) as any
                : null;
        }

        return entity;
    }

    /**
     * Inserta un nuevo registro mapeando la entidad a una fila de Excel
     */
    async create(entity: T): Promise<void> {
        await this.ensureSchema();
        const rows = await this.googleSheets.getValues(this.spreadsheetId, `${this.sheetName}!A:Z`);
        const headers = rows[0] as string[];

        const newRow = SheetMapper.mapToRow(headers, entity);
        // 3. Append a la hoja (usamos el método append de tu servicio)
        await this.googleSheets.appendRow(this.spreadsheetId, this.sheetName, newRow);
    }
    /**
   * Busca registros de un DNI dentro de un rango de fechas.
   * Asume que la entidad tiene las propiedades 'dni' y 'fecha'.
   */
    async findRange(dni: string, fechaInicio: string, fechaFin: string): Promise<T[]> {
        const todos = await this.findAll();

        return todos.filter((item: any) => {
            const cumpleDni = item.dni === dni;
            const cumpleFecha = item.fecha >= fechaInicio && item.fecha <= fechaFin;
            return cumpleDni && cumpleFecha;
        });
    }
}