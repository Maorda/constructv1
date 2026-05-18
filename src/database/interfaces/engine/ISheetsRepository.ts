import { FilterQuery, UpdateAggregationPipeline, UpdateQuery } from "@database/types/query.types";
import { QueryOptions } from "./IQueryEngine";
import { ISheetDocument } from "./ISheetDocument";
import { DocumentQuery } from "@database/engines/document.query";
import { SheetDocument } from "@database/wrapper/sheet.document";
export interface UpdateOptions {
    upsert?: boolean;
    new?: boolean; // true para retornar el documento actualizado, false para el anterior
}

export interface ISheetsRepository<T extends object> {
    findOneAndUpdate(
        filter: FilterQuery<T>,
        updateData: UpdateQuery<T> | UpdateAggregationPipeline, // 🚀 Ajuste aquí, Acepta unión de tipos
        options: UpdateOptions
    ): Promise<SheetDocument<T> | null>;
    /**
     * Busca un único registro por su ID y lo devuelve envuelto.
     * @param id Identificador único de la entidad.
     * @returns Promesa con el documento envuelto o null si no existe.
     */
    findById(id: string | number): Promise<ISheetDocument<T> | null>;

    /**
     * Busca todos los registros que coincidan con un criterio.
     * @param filter Objeto parcial con las propiedades a filtrar.
     * @returns Promesa con un arreglo de documentos envueltos.
     */
    find(filter: FilterQuery<T>, options: QueryOptions): Promise<SheetDocument<T>[]>


    /**
     * Obtiene todos los registros de la hoja.
     */
    findAll(): Promise<ISheetDocument<T>[]>;

    /**
     * Crea una nueva instancia del documento en memoria (sin persistir aún).
     * Útil para preparar un registro antes de llamar a .save().
     * @param data Datos iniciales de la entidad.
     */
    createDocument(data: Partial<T>): ISheetDocument<T>;

    /**
     * Busca un registro. Si existe, lo devuelve; si no, lo crea.
     */
    findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<ISheetDocument<T>>;
}