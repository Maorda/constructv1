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
     * El motor de ejecución.
     * Aquí es donde la consulta deja de ser una definición y se convierte en datos.
     */
    async then<TResult1 = any[], TResult2 = never>(
        onfulfilled?: ((value: any[]) => TResult1 | PromiseLike<TResult1>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ): Promise<TResult1 | TResult2> {
        try {
            // 1. Obtener todos los datos a través del repositorio (usando caché)
            let results = await this.repository.findAllRaw();

            // 2. Aplicar Filtros (QueryEngine)
            results = results.filter(item => this.queryEngine.applyFilter(item, this._filter));

            // 3. Aplicar Sort
            if (this._sort) {
                results = this.queryEngine.applySort(results, this._sort);
            }

            // 4. Aplicar Skip y Limit (Paginación)
            if (this._skip) results = results.slice(this._skip);
            if (this._limit) results = results.slice(0, this._limit);

            // 5. Aplicar Proyección (Selección de campos)
            if (this._projection) {
                results = results.map(item => this.queryEngine.applyProjection(item, this._projection));
            }

            // 6. Resolver la promesa
            const finalResult = onfulfilled ? onfulfilled(results) : (results as any);
            return finalResult;
        } catch (error) {
            if (onrejected) return onrejected(error);
            throw error;
        }
    }

}
