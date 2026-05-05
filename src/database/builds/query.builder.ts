import { GettersEngine } from "@database/engine/getters.engine";
import { Injectable } from "@nestjs/common";
import { IQueryBuilder } from "@database/builds/IQueryBuilder";
import { QueryEngine } from "@database/engine/query.engine";
import { Projection } from "@database/types/query.types";
import { ISheetDocument } from "@database/interfaces/engine/ISheetDocument";


@Injectable()
export class QueryBuilder<T extends object> implements IQueryBuilder<T> {
    // Estado para Aggregation Pipeline ($match, $group, etc.)
    private pipeline: any[] = [];

    // Estado para Consultas Clásicas (where, select, orderBy)
    private query: {
        where: Record<string, any>;
        limit?: number;
        skip?: number;
        orderBy?: { field: keyof T; order: 'ASC' | 'DESC' };
        select?: (keyof T)[];
        populate?: string[];
    } = { where: {} };

    constructor(
        private readonly queryEngine: QueryEngine,
        private readonly gettersEngine: GettersEngine<T>, // Inyectado para obtener la data
        private readonly entityClass: string | (new () => T) // Referencia a la hoja/entidad
    ) { }

    // ============================================================
    // MÉTODOS DE CONSULTA CLÁSICA
    // ============================================================

    where(conditions: Partial<Record<keyof T, any>>): this {
        this.query.where = { ...this.query.where, ...conditions };
        // También lo inyectamos al pipeline por si el usuario mezcla métodos
        this.pipeline.push({ $match: conditions });
        return this;
    }

    select(projection: Projection<T>): this {
        if (Array.isArray(projection)) {
            this.query.select = projection as (keyof T)[];
            // Convertir array clásico a objeto $project para el pipeline
            const projObj = projection.reduce((acc, field) => ({ ...acc, [field]: 1 }), {});
            this.pipeline.push({ $project: projObj });
        } else {
            this.pipeline.push({ $project: projection });
            // Extraer solo las llaves para el modo clásico
            this.query.select = Object.keys(projection) as (keyof T)[];
        }
        return this;
    }

    populate(path: string): this {
        if (!this.query.populate) this.query.populate = [];
        this.query.populate.push(path);
        return this;
    }

    // ============================================================
    // MÉTODOS DE AGREGACIÓN Y MÉTODOS COMPARTIDOS
    // ============================================================

    match(condition: Record<string, any>): this {
        this.pipeline.push({ $match: condition });
        this.query.where = { ...this.query.where, ...condition };
        return this;
    }

    project(projection: Record<string, any>): this {
        this.pipeline.push({ $project: projection });
        return this;
    }

    group(groupConfig: Record<string, any>): this {
        this.pipeline.push({ $group: groupConfig });
        return this;
    }

    // ============================================================
    // MANEJO DE SOBRECARGAS (Paginación y Ordenamiento)
    // ============================================================

    /** Sobrecarga de firmas para soportar ambos estilos de ordenamiento */
    sort(field: keyof T, order: 'ASC' | 'DESC'): this;
    sort(sortConfig: Record<string, 1 | -1>): this;
    sort(fieldOrConfig: any, order?: 'ASC' | 'DESC'): this {
        if (typeof fieldOrConfig === 'string' && order) {
            // Estilo Clásico
            this.query.orderBy = { field: fieldOrConfig as keyof T, order };
            this.pipeline.push({ $sort: { [fieldOrConfig]: order === 'ASC' ? 1 : -1 } });
        } else if (typeof fieldOrConfig === 'object' && fieldOrConfig !== null) {
            // Estilo Agregación (Objeto)
            const config = fieldOrConfig as Record<string, 1 | -1>;
            this.pipeline.push({ $sort: config });

            // Sincronización con el modo clásico
            const keys = Object.keys(config);
            if (keys.length > 0) {
                const firstField = keys[0];
                // Usamos el acceso por corchetes con el tipo correcto
                const direction = config[firstField];

                this.query.orderBy = {
                    field: firstField as keyof T,
                    order: direction === 1 ? 'ASC' : 'DESC'
                };
            }
        }
        return this;
    }

    limit(value: number): this {
        this.query.limit = value;
        this.pipeline.push({ $limit: value });
        return this;
    }

    skip(value: number): this {
        this.query.skip = value;
        this.pipeline.push({ $skip: value });
        return this;
    }

    // ============================================================
    // EJECUTORES (Resolución de Promesas)
    // ============================================================

    async execute(): Promise<any[]> {
        // Obtenemos los datos crudos
        const allData = await this.gettersEngine.findAll();
        // Ejecutamos usando el motor de pipelines
        const result = await this.queryEngine.aggregate(allData, this.pipeline);
        this.clearState();
        return result;
    }

    async getMany(): Promise<ISheetDocument<T>[]> {
        const allData = await this.gettersEngine.findAll();
        // Ejecutamos usando el motor clásico
        const result = this.queryEngine.execute(allData, this.query);
        this.clearState();
        return result as ISheetDocument<T>[];
    }

    async getOne(): Promise<ISheetDocument<T> | null> {
        this.limit(1);
        const results = await this.getMany();
        return results.length > 0 ? results[0] : null;
    }

    async getCount(): Promise<number> {
        // En modo clásico, ejecutamos la consulta sin límite/skip para contar
        const backupLimit = this.query.limit;
        const backupSkip = this.query.skip;

        delete this.query.limit;
        delete this.query.skip;

        const results = await this.getMany();

        // Restaurar estado si se reutilizara el builder antes de limpiar (opcional)
        this.query.limit = backupLimit;
        this.query.skip = backupSkip;

        return results.length;
    }

    /** Limpia el estado después de una ejecución para permitir reuso */
    private clearState(): void {
        this.pipeline = [];
        this.query = { where: {} };
    }
}
