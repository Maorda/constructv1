/*
*const obrasRecientes = await obraRepo.createQueryBuilder()
    .where({ estado: 'ACTIVO' })
    .sort('fechaInicio', 'DESC')
    .limit(5)
    .populate('inspector') // Trae los datos del inspector automáticamente
    .getMany();
*/

import { Projection } from "@database/types/query.types";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";

export interface IQueryBuilder<T> {
    /** Filtrado */
    where(filter: Partial<T>): this;

    /** Proyección */
    select(projection: Projection<T>): this;

    /** Paginación y Orden */
    sort(field: keyof T, order: 'ASC' | 'DESC'): this;
    limit(value: number): this;
    skip(value: number): this;

    /** Relaciones */
    populate(path: string): this;

    /** Ejecutores */

    getMany(): Promise<ISheetDocument<T>[]>;
    getOne(): Promise<ISheetDocument<T> | null>;
    getCount(): Promise<number>;
    match(condition: Record<string, any>): this;
    project(projection: Record<string, any>): this;
    /**
     * Agrupa los documentos de entrada por la expresión del _id especificada y aplica acumuladores.
     */
    group(groupConfig: Record<string, any>): this;
    sort(sortConfig: Record<string, 1 | -1>): this;
}