import { ISheetDocument } from "./ISheetDocument";

export interface ISheetsRepository<T extends object> {
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
    find(filter?: Partial<T>): Promise<ISheetDocument<T>[]>;

    /**
     * Obtiene todos los registros de la hoja.
     */
    findAll(): Promise<ISheetDocument<T>[]>;

    /**
     * Crea una nueva instancia del documento en memoria (sin persistir aún).
     * Útil para preparar un registro antes de llamar a .save().
     * @param data Datos iniciales de la entidad.
     */
    create(data: Partial<T>): ISheetDocument<T>;

    /**
     * Busca un registro. Si existe, lo devuelve; si no, lo crea.
     */
    findOrCreate(filter: Partial<T>, defaults: Partial<T>): Promise<ISheetDocument<T>>;
}