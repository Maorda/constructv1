import { SheetDocument } from "@database/wrapper/sheet.document";
import { CompareEngine } from "./compare.engine";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { SheetsDataGateway } from "@database/services/sheetDataGateway";
import { FilterQuery, Projection } from "@database/types/query.types";
import { ManipulateEngine } from "../engine/manipulateEngine";


import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { ProjectionService } from "@database/services/projection.seervice";
import { QueryOptions } from "@database/interfaces/engine/IQueryEngine";
import { SheetsRepository } from "@database/repositories/sheets.repository";


/*
*1. ¿Qué es DocumentQuery? (Función Fundamental)
*Es la clase encargada de la Lazy Evaluation (evaluación perezosa). 
*Su función es permitir que el programador "encadene" filtros antes
*de ejecutar la consulta real en Google Sheets.
*Sin DocumentQuery, tendrías que pasar 20 argumentos a un método find()
*/

// También actualizamos el retorno aquí
@Injectable()
export class DocumentQuery<T extends object, R = SheetDocument<T> | SheetDocument<T>[]>
  implements PromiseLike<R> {

  private readonly logger = new Logger(DocumentQuery.name);
  private _populates: string[] = [];
  private _projection: QueryOptions['projection'] = {};
  private _isMany = false; // Flag para saber si devolver un objeto o un array

  private _limit?: QueryOptions['limit'];
  private _offset?: QueryOptions['offset'];
  private _sort?: QueryOptions['sort'];

  constructor(
    private readonly entityClass: new () => T,
    private readonly filter: FilterQuery<T> = {},
    private readonly service: ProjectionService<T>,
    private readonly repositoryContext: RepositoryContext<T>, // <--- INYECTAMOS EL CONTEXTO
    private readonly sheetRepository: SheetsRepository<T>,
    //private readonly isMany?: boolean
  ) { }

  limit(n: number): this { this._limit = n; return this; }
  offset(n: number): this { this._offset = n; return this; }
  sort(field: string, order: 'ASC' | 'DESC'): this {
    this._sort = { field, order };
    return this;
  }

  /**
   * Indica que la consulta debe devolver un array de documentos.
   */
  findMany(): this {
    this._isMany = true;
    return this;
  }
  /**
   * Permite seleccionar qué campos traer. 
   * Si se usa, el documento será un "Partial" pero aún funcional.
   */
  /**
   * Configura qué campos queremos incluir o excluir en el resultado final.
   */
  select(projection: Projection): this {
    this._projection = projection;
    return this;
  }

  /**
   * Soporta múltiples rutas: .populate('cuadrilla').populate('obra')
   */
  /**
   * Permite cargar relaciones de otras pestañas: .populate('cuadrilla')
   */
  populate(path: string): this {
    this._populates.push(path);
    return this;
  }/**
   * Ejecución de la consulta (se dispara al usar await)
   */
  /**
   * EL CORAZÓN DEL QUERY: Implementación de PromiseLike
   */
  async then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1 | TResult2> {
    try {
      // 1. Inyectamos los estados acumulados al motor de búsqueda
      const rawData = this._isMany
        ? await this.repositoryContext.gettersEngine.findInternal(
          this.filter,
          this.repositoryContext.compareEngine,
          { limit: this._limit, offset: this._offset, sort: this._sort } // <--- Flujo de datos hacia el Engine
        )
        : await this.repositoryContext.gettersEngine.findOneInternal(
          this.filter,
          this.repositoryContext.compareEngine
        );

      if (!rawData || (Array.isArray(rawData) && rawData.length === 0)) {
        return Promise.resolve(this._isMany ? [] : null).then(onfulfilled as any);
      }

      // 2. Procesamiento de Relaciones y Proyección (IDEM a lo anterior)
      const processItem = async (item: any) => {
        let processed = { ...item };
        for (const path of this._populates) {
          processed = await this.repositoryContext.relationEngine.resolve(this.entityClass, processed, path);
        }
        return this.service.applyProjection(processed, this._projection);
      };

      // 3. Hidratación a Documentos Vivos
      let result: any;
      if (this._isMany) {
        const items = await Promise.all((rawData as any[]).map(processItem));
        result = items.map(data => this.hydrate(data));
      } else {
        const data = await processItem(rawData);
        result = this.hydrate(data);
      }

      return Promise.resolve(result).then(onfulfilled as any);
    } catch (error) {
      throw error;
    }
  }
  private hydrate(data: any): SheetDocument<T> {
    const instance = new this.entityClass();
    Object.assign(instance, data);
    return new SheetDocument(instance, this.sheetRepository);
  }
}