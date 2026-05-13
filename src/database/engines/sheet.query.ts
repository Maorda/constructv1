import { GettersEngine } from "@database/engine/getters.engine";
import { QueryEngine } from "@database/engine/query.engine";
import { SheetsRepository } from "@database/repositories/sheets.repository";

export class SheetsQuery<T extends object> implements PromiseLike<any[]> {

    private _limit?: number;
    private _skip?: number;
    private _sort?: Record<string, 1 | -1>;
    private _projection?: any;

    constructor(
        private readonly getter: GettersEngine<T>, // Tu BaseSheetsRepository
        private _filter: any = {},
        private readonly queryEngine: QueryEngine<T> // Tu QueryEngine que tiene el applyProjection de la foto
    ) {
        if (!this.getter) throw new Error(`[SheetsQuery] GettersEngine no inyectado para ${this.constructor.name}`);
        if (!this.queryEngine) throw new Error(`[SheetsQuery] QueryEngine no inyectado para ${this.constructor.name}`);
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
  * El motor de ejecución (Orquestador final).
  * Implementa la interfaz 'Thenable' para que la consulta se ejecute al hacer 'await'.
  */
    async then<TResult1 = T[], TResult2 = never>(
        onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ): Promise<TResult1 | TResult2> {
        try {
            // 1. Obtener datos (Caché / Sheets)
            // Aseguramos que results sea tratado como T[] para mantener los tipos de la entidad
            let results: T[] = await this.getter.findAllRaw();

            // 2. Aplicar Filtros
            // Usamos el predicado booleano que optimizamos en el CompareEngine
            if (this._filter) {
                results = results.filter(item => this.queryEngine.applyFilter(item, this._filter));
            }

            // 3. Aplicar Sort
            // FIX: Eliminamos el error de tipo usando un casting a Record, 
            // ya que nuestro nuevo applySort ya sabe procesar objetos { campo: 1 | -1 }
            if (this._sort && Object.keys(this._sort).length > 0) {
                results = this.queryEngine.applySort(results, this._sort as Record<string, any>);
            }

            // 4. Paginación (Skip y Limit)
            if (this._skip) results = results.slice(this._skip);
            if (this._limit) results = results.slice(0, this._limit);

            // 5. Aplicar Proyección
            // La proyección suele devolver objetos parciales, por eso el casting final
            if (this._projection) {
                results = results.map(item => this.queryEngine.applyProjection(item, this._projection)) as unknown as T[];
            }

            // 6. Resolver la promesa con el tipo correcto
            const finalResult = onfulfilled
                ? await onfulfilled(results)
                : (results as unknown as TResult1);

            return finalResult;
        } catch (error) {
            if (onrejected) return await onrejected(error);
            throw error;
        }
    }

}
