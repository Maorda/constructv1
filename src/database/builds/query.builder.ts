import { GettersEngine } from "@database/engine/getters.engine";

export class QueryBuilder<T extends object> {


    constructor(
        private readonly entityClass: new () => T,
        private readonly queryEngine: any, // Inyectado desde el contexto
        private readonly gettersEngine: GettersEngine, // Para obtener los datos iniciales
        private readonly timezone: any
    ) { }

    // La "mochila" donde guardamos los filtros
    private query: {
        where: Record<string, any>;
        limit?: number;
        orderBy?: { field: keyof T; order: 'ASC' | 'DESC' };
        select?: (keyof T)[];
    } = { where: {} };

    // .where({ estado: 'ACTIVO', categoria: 'A' })
    where(conditions: Partial<Record<keyof T, any>>): this {
        this.query.where = { ...this.query.where, ...conditions };
        return this;
    }

    // .limit(10)
    limit(n: number): this {
        this.query.limit = n;
        return this;
    }

    // .orderBy('nombre', 'ASC')
    orderBy(field: keyof T, order: 'ASC' | 'DESC' = 'ASC'): this {
        this.query.orderBy = { field, order };
        return this;
    }

    // El disparador final
    async getMany(): Promise<T[]> {
        // 1. Obtenemos todos los datos (ya sea de Caché o Google vía GettersEngine)
        const allData = await this.gettersEngine.findAll<T>(this.entityClass);

        // 2. Le pasamos la data y la "receta" al QueryEngine para que procese
        return this.queryEngine.execute(allData, this.query);
    }

    async getOne(): Promise<T | null> {
        this.query.limit = 1;
        const results = await this.getMany();
        return results.length > 0 ? results[0] : null;
    }
    select(fields: (keyof T)[]): this {
        this.query.select = fields;
        return this;
    }
}
