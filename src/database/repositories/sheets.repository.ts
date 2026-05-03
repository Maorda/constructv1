import { SheetsQuery } from "@database/engines/sheet.query";
import { RepositoryContext } from "./repository.context";
import { BaseSheetsCrudService } from "@database/services/base.sheets.crud.service";
import { ClassType, EntityFilterQuery } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { QueryEngine } from "@database/engine/query.engine";
import { GettersEngine } from "@database/engine/getters.engine";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";
import { ISheetsRepository } from "@database/interfaces/engine/ISheetsRepository";
import { VirtualType } from "@database/interfaces/virtual.type";
import { Inject, Injectable } from "@nestjs/common";
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

    constructor(
        protected readonly entityClass: new () => T,
        protected readonly ctx: RepositoryContext,
        // Inyectamos el servicio de proyecciones aquí
        protected readonly baseService: BaseServiceInterface<T>,
        protected readonly virtuals: Record<string, VirtualType> = {}

    ) { }

    createQueryBuilder(): QueryBuilder<T> {
        return new QueryBuilder(
            this.entityClass,
            this.ctx.queryEngine,   // El que procesa
            this.ctx.gettersEngine,  // El que trae los datos de Google/Caché
            this.ctx.options.timezone
        );
    }
    async findById(id: string | number): Promise<ISheetDocument<T> | null> {
        const rawData = await this.ctx.getters.findById(this.entityClass, id);
        if (!rawData) return null;

        return new SheetDocument<T>(
            rawData,             // data: T
            this.entityClass,    // entityClass
            this.ctx,            // ctx
            this.virtuals,        // _virtuals
            this.baseService, // baseService (Inyectado en el repo)
        );
    }

    /**
     * Inicia una consulta fluida (Select, Where, etc.)
     */
    find(filter: any = {}): SheetsQuery<T> {
        // Retornamos una nueva instancia del motor de consultas
        // inyectándole este repositorio y el motor de comparación
        return new SheetsQuery<T>(this as any, filter, this.ctx['compareEngine']);
    }

    /**
     * Guarda un objeto en la hoja de cálculo.
     * Maneja la sincronización de columnas y la persistencia física.
     */
    async save(entity: T): Promise<T> {
        // 1. Usamos el PersistenceEngine para escribir los datos
        // El persistenceEngine sabe cómo hablar con GoogleSheetsService
        return await this.ctx.persistenceEngine.save(this.EntityClass, entity, this.ctx);
    }

    /**
     * Busca un único documento por su ID u otro filtro
     */
    findOne(filter: EntityFilterQuery<T> = {}): DocumentQuery<SheetDocument<T> | null> {
        // El repositorio conoce todo lo necesario para armar el DocumentQuery
        return new DocumentQuery<T>(
            this.EntityClass,
            filter,
            this.ctx,
            false
        );
    }

    /**
     * Nombre de la hoja basado en la clase o metadata
     */
    get sheetName(): string {
        return this.EntityClass.name;
    }

    /**
     * Elimina registros basados en un filtro
     */
    async delete(filter: any): Promise<void> {
        return await this.ctx.persistenceEngine.delete(this.EntityClass, filter, this.ctx);
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
        const existing = await this.findOne(filter as EntityFilterQuery<T>);
        if (existing) return existing;

        // 2. Crear uno nuevo
        // Unimos los datos por defecto con los filtros (el filtro puede tener el ID o datos nuevos)
        const combinedData = { ...defaults, ...filter } as T;
        const doc = new SheetDocument<T>(combinedData, this.ctx.persistence, this.entityClass);

        // 3. Guardarlo inmediatamente
        return await doc.save();
    }
    create(data: Partial<T>): ISheetDocument<T> {
        // Instanciamos la clase y asignamos valores
        const entity = new this.entityClass();
        Object.assign(entity, data);

        // Devolvemos envuelto para que el usuario pueda hacer .save()
        return new SheetDocument<T>(
            entity,
            this.ctx.persistence,
            this.entityClass
        );
    }
}