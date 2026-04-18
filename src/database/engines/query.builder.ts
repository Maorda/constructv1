export class SheetsQuery<T> implements PromiseLike<any[]> {
    private _filter: any;
    private _limit?: number;
    private _skip?: number;
    private _sort?: Record<string, 1 | -1>;
    private _projection?: any;

    constructor(
        private readonly repository: any, // Tu BaseSheetsRepository
        filter: any,
        private readonly queryEngine: any // Tu QueryEngine que tiene el applyProjection de la foto
    ) {
        this._filter = filter;
    }

    /**
     * Encadena la proyección. 
     * Nota: Usamos 'any' o un tipo flexible porque la proyección 
     * transforma la estructura de la Entidad T.
     */
    select(projection: any): this {
        this._projection = projection;
        return this;
    }

    sort(options: Record<string, 1 | -1>): this {
        this._sort = options;
        return this;
    }

    limit(n: number): this {
        this._limit = n;
        return this;
    }

    skip(n: number): this {
        this._skip = n;
        return this;
    }

    /**
     * Método fundamental para el 'await'.
     * Resuelve el error ts(2740) al asegurar que devolvemos un Array (any[]).
     */
    async then<TResult1 = any[], TResult2 = never>(
        onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ): Promise<TResult1 | TResult2> {
        try {
            // 1. Obtenemos todos los registros (Capa de infraestructura)
            const allRecords = await this.repository.findAll();

            // 2. Filtrado (QueryEngine)
            let data = allRecords.filter((r: T) => this.queryEngine.applyFilter(r, this._filter));

            // 3. Ordenamiento (QueryEngine)
            if (this._sort) {
                data = this.queryEngine.applySort(data, this._sort);
            }

            // 4. Paginación (QueryEngine)
            if (this._limit !== undefined || this._skip !== undefined) {
                data = this.queryEngine.applyPagination(data, this._limit, this._skip);
            }

            // 5. Proyección (Utilizando TU método applyProjection de la imagen)
            // Mapeamos los resultados para que cada uno pase por tu filtro de inclusión/exclusión
            if (this._projection) {
                data = data.map((record: T) => this.queryEngine.applyProjection(record, this._projection));
            }

            // Devolvemos los datos procesados como un array
            return Promise.resolve(data).then(onfulfilled, onrejected);
        } catch (error) {
            if (onrejected) return onrejected(error);
            throw error;
        }
    }
}
