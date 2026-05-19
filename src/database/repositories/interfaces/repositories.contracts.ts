// @database/interfaces/engine/IQueryExecutionEngine.ts
import { ClassType, FilterQuery, UpdateAggregationPipeline, UpdateQuery } from "@database/types/query.types";
import { SheetDocument } from "@database/wrapper/sheet.document";
import { SheetsRepository } from "@database/repositories/sheets.repository";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";
import { UpdateOptions } from "@database/interfaces/engine/ISheetsRepository";

export interface IUpdatePartialOrchestrator {
    execute<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number,
        changes: Partial<T>
    ): Promise<SheetDocument<T>>;
}
export interface ICreateOrchestrator {
    execute<T extends object>(
        repository: SheetsRepository<T>,
        docData: Partial<T>
    ): Promise<SheetDocument<T>>;
}

export interface IUpdateOrchestrator {
    execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | UpdateAggregationPipeline,
        options: UpdateOptions
    ): Promise<SheetDocument<T> | null>;
}
export interface IQueryExecutionEngine {
    /** Ejecuta una consulta compleja devolviendo múltiples resultados */
    findMany<T extends object>(
        repository: SheetsRepository<T>,
        filter?: FilterQuery<T>,
        options?: QueryOptions
    ): Promise<SheetDocument<T>[]>;

    /** Ejecuta una consulta devolviendo un único resultado vivo */
    findOne<T extends object>(
        repository: SheetsRepository<T>,
        filter?: FilterQuery<T>,
        projection?: any
    ): Promise<SheetDocument<T> | null>;

    /** Búsqueda optimizada atómica por Llave Primaria */
    findById<T extends object>(
        repository: SheetsRepository<T>,
        id: string | number
    ): Promise<SheetDocument<T> | null>;

    /** Recupera la totalidad de la colección mapeada en memoria */
    findAll<T extends object>(
        repository: SheetsRepository<T>
    ): Promise<SheetDocument<T>[]>;
}

export interface HydratorOptions {
    new?: boolean;
    oldDataFlat?: any;
}

export interface ISheetDocumentHydrator {
    /**
     * Transforma datos crudos en un documento administrado, aplicando 
     * protecciones de Express (toJSON) y controlando referencias circulares.
     */
    hydrateAndShield<T extends object>(
        entityClass: ClassType<T>,
        repository: SheetsRepository<T>,
        rawData: any,
        options?: HydratorOptions
    ): SheetDocument<T> | null;
}



export interface IRelationalUpsertOrchestrator {
    /**
     * Orquesta la inserción o actualización de un registro maestro, 
     * propagando las mutaciones hacia las pestañas hijas en cascada.
     */
    execute<T extends object>(
        repository: SheetsRepository<T>,
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | any,
        options?: UpdateOptions
    ): Promise<SheetDocument<T> | null>;
}


export interface ICascadeDeleteOrchestrator {
    /**
     * Orquesta la eliminación de una entidad resolviendo previamente
     * la destrucción de sus dependencias/hijos en subcolecciones para evitar huérfanos.
     */
    execute<T extends object>(
        repository: SheetsRepository<T>,
        idOrEntity: string | number | T
    ): Promise<void>;
}
