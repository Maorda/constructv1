import { SheetsQuery } from "@database/engines/sheet.query";
import { RepositoryContext } from "./repository.context";
import { BaseSheetsCrudService } from "@database/services/base.sheets.crud.service";
import { ClassType, FilterQuery } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { QueryEngine } from "@database/engine/query.engine";
import { GettersEngine } from "@database/engine/getters.engine";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { ISheetsRepository } from "@database/interfaces/engine/ISheetsRepository";
import { VirtualType } from "@database/interfaces/virtual.type";
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ProjectionService } from "@database/services/projection.seervice";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";

/*
* SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
* Funciona como el 'Model' de Mongoose.
* Es el punto de entrada oficial para cualquier operación con los datos de Google Sheets y actúa
* como una "Fábrica de Entidades Inteligentes".
* En términos sencillos: el Repositorio es quien saca los datos del "mundo frío" de las tablas de
* Google Sheets y los convierte en objetos vivos con "superpoderes" en tu código.
*/

/**
 * sheets-repository.ts (Equivalente al Model de Mongoose)
 * SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
 * Funciona como el 'Model' de Mongoose.
 */

export class SheetsRepository<T extends object> implements ISheetsRepository<T> {
    private readonly logger = new Logger(SheetsRepository.name);

    constructor(
        public readonly entityClass: new () => T,
        protected readonly ctx: RepositoryContext<T>,
        // Inyectamos el servicio de proyecciones aquí
        protected readonly baseService: BaseServiceInterface<T>,
        protected readonly virtuals: Record<string, VirtualType> = {}

    ) { }
    async initialize(sheetName: string): Promise<void> {
        // El repositorio solo le pide al gateway que haga su trabajo
        await this.ctx.gateway.initialize(sheetName);
    }

    createQueryBuilder(): QueryBuilder<T> {
        return new QueryBuilder(
            this.entityClass,
            this.ctx.queryEngine,   // El que procesa
            this.ctx.gettersEngine,  // El que trae los datos de Google/Caché
            this.ctx.options
        );
    }
    /**
 * Recibe un ID y un objeto con campos parciales, y delega la 
 * actualización optimizada al motor de persistencia.
 */
    /**
 * Actualiza de forma optimizada solo los campos que han cambiado.
 * @param id El identificador único del registro.
 * @param changes El delta de cambios (campos modificados).
 */
    async updatePartial(id: string | number, changes: Partial<T>): Promise<T> {
        // 1. Localizamos la fila física en Google Sheets
        // Usamos el gettersEngine que ya tenemos en el contexto
        const rowIndex = await this.ctx.gettersEngine.findRowIndexById(id);

        if (rowIndex === -1) {
            throw new NotFoundException(
                `No se pudo realizar la actualización parcial. El registro con ID "${id}" no existe en la hoja ${this.resolvedSheetName}.`
            );
        }

        // 2. Si no hay cambios reales en el objeto de entrada, evitamos la llamada a la API
        if (Object.keys(changes).length === 0) {
            return this.findById(id);
        }

        // 3. Delegamos al PersistenceEngine la actualización por lotes (Batch Update)
        // El motor se encargará de traducir cada propiedad a su columna (A, B, C...)
        await this.ctx.persistenceEngine.updatePartialBatch(rowIndex, changes);

        this.logger.debug(`[UpdatePartial] ID ${id} actualizado con éxito en la fila ${rowIndex + 2}`);

        // 4. Retornamos la entidad fresca y completa
        // Esto es vital para que el SheetDocument actualice su snapshot interno con los datos finales
        return await this.findById(id);
    }

    async findById(id: string | number): Promise<ISheetDocument<T> | null> {
        // 1. La búsqueda en Google Sheets/Caché es ASÍNCRONA (await)
        const rawData = await this.ctx.gettersEngine.findByRowId(this.entityClass.name, id);

        // 2. Si no hay datos, retornamos null
        if (!rawData) return null;

        // 3. La creación del "Documento" (el envoltorio) es SÍNCRONA
        // Pero como la función es 'async', el resultado se envuelve en una Promesa automáticamente
        return this.createDocument(rawData);
    }

    /**
     * Inicia una consulta fluida (Select, Where, etc.)
     */
    find(filter: Partial<T> = {}): Promise<ISheetDocument<T>> {
        // Retornamos una nueva instancia del motor de consultas
        // inyectándole este repositorio y el motor de comparación
        return new SheetsQuery<T>(this as any, filter, this.ctx.compareEngine);
    }

    /**
     * Guarda un objeto en la hoja de cálculo.
     * Maneja la sincronización de columnas y la persistencia física.
     */
    async save(entity: T): Promise<T> {
        // 1. Usamos el PersistenceEngine para escribir los datos
        // El persistenceEngine sabe cómo hablar con GoogleSheetsService
        return await this.ctx.persistenceEngine.save(this.entityClass, entity, this.ctx);
    }

    /**
     * Busca un único documento por su ID u otro filtro
     */
    findOne(filter: FilterQuery<T> = {}): DocumentQuery<SheetDocument<T> | null> {
        // El repositorio conoce todo lo necesario para armar el DocumentQuery
        return new DocumentQuery<T>(
            this.entityClass,
            filter,
            this.ctx,
            false
        );
    }

    /**
     * Nombre de la hoja basado en la clase o metadata
     */
    get sheetName(): string {
        return this.entityClass.name;
    }

    /**
     * Elimina registros basados en un filtro
     */
    async delete(filter: any): Promise<void> {
        return await this.ctx.persistenceEngine.delete(this.entityClass, filter, this.ctx);
    }

    async findAll(): Promise<ISheetDocument<T>[]> {
        const allData = await this.ctx.getters.findAll(this.entityClass);

        // Mapeamos cada resultado a un nuevo envoltorio
        return allData.map(data => new SheetDocument<T>(
            data,
            this.ctx.persistence,
            this.entityClass
        ));
    }

    async findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<ISheetDocument<T>> {
        // 1. Buscar si existe
        const existing = await this.findOne(filter as FilterQuery<T>);
        if (existing) return existing;

        // 2. Crear uno nuevo
        // Unimos los datos por defecto con los filtros (el filtro puede tener el ID o datos nuevos)
        const combinedData = { ...defaults, ...filter } as T;
        const doc = new SheetDocument<T>(combinedData, this.ctx.persistence, this.entityClass);

        // 3. Guardarlo inmediatamente
        return await doc.save();
    }
    createDocument(data: Partial<T>): ISheetDocument<T> {
        // Devolvemos envuelto para que el usuario pueda hacer .save()
        return new SheetDocument<T>(
            data,
            this.entityClass,
            this.ctx,
            this.virtuals,
            this.baseService
        );
    }
}