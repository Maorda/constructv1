import { SheetsQuery } from "@database/engines/sheet.query";
import { RepositoryContext } from "./repository.context";
import { BaseSheetsCrudService } from "@database/services/base.sheets.crud.service";
import { ClassType } from "@database/types/query.types";
import { QueryBuilder } from "@database/builds/query.builder";
import { QueryEngine } from "@database/engine/query.engine";
import { GettersEngine } from "@database/engine/getters.engine";

/*
* SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
* Funciona como el 'Model' de Mongoose.
* Es el punto de entrada oficial para cualquier operación con los datos de Google Sheets y actúa como una "Fábrica de Entidades Inteligentes".
* En términos sencillos: el Repositorio es quien saca los datos del "mundo frío" de las tablas de Excel y los convierte en objetos vivos con "superpoderes" en tu código.
*/

/**
 * sheets-repository.ts (Equivalente al Model de Mongoose)
 * SheetsRepository: El puente entre tu Entidad de TypeScript y la pestaña de Google Sheets.
 * Funciona como el 'Model' de Mongoose.
 */
export class SheetsRepository<T extends object> {
    constructor(
        private readonly EntityClass: new () => T,
        private readonly ctx: RepositoryContext, // Este ctx ya trae los motores vinculados a 'entity'


    ) { }

    createQueryBuilder(): QueryBuilder<T> {
        return new QueryBuilder(
            this.EntityClass,
            this.ctx.queryEngine,   // El que procesa
            this.ctx.gettersEngine,  // El que trae los datos de Google/Caché
            this.ctx.options.timezone
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
        return await this.ctx['persistenceEngine'].save(this.sheetName, entity, this.entityClass);
    }

    /**
     * Busca un único documento por su ID u otro filtro
     */
    async findOne(filter: any): Promise<T | null> {
        const results = await this.find(filter);
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Elimina registros basados en un filtro
     */
    async delete(filter: any): Promise<void> {
        return await this.ctx['persistenceEngine'].d.delete(this.sheetName, filter);
    }

    async findAll(): Promise<T[]> {
        // Le pasas la clase que guardaste en el constructor
        return await this.ctx.googleSheets.findAll<T>(this.entityClass);
    }
}