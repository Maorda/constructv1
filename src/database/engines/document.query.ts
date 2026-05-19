import { SheetDocument } from "@database/wrapper/sheet.document";
import { CompareEngine } from "./compare.engine";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { SheetsDataGateway } from "@database/services/sheetDataGateway/sheetDataGateway";
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
    if (path && !this._populates.includes(path)) {
      this._populates.push(path);
    }
    return this;
  }
  /**
   * Ejecución de la consulta (se dispara al usar await)
   */
  /**
   * EL CORAZÓN DEL QUERY: Implementación de PromiseLike
   */
  /**
   * EL CORAZÓN DEL QUERY: Intercepta el uso de la palabra clave 'await' para desencadenar
   * la consulta física optimizada contra Google Sheets.
   */
  async then<TResult1 = R, TResult2 = never>(
    onfulfilled?: ((value: R) => TResult1 | PromiseLike<TResult1>) | null
  ): Promise<TResult1 | TResult2> {
    try {
      // 1. EVALUACIÓN Y SELECCIÓN DE MOTOR INTERNO
      const rawData = this._isMany
        ? await this.repositoryContext.gettersEngine.findInternal(
          this.filter,
          this.repositoryContext.compareEngine,
          { limit: this._limit, offset: this._offset, sort: this._sort }
        )
        : await this.repositoryContext.gettersEngine.findOneInternal(
          this.filter,
          this.repositoryContext.compareEngine
        );

      // Si no hay datos físicos, cortamos de manera segura devolviendo colecciones vacías o nulos
      if (!rawData || (Array.isArray(rawData) && rawData.length === 0)) {
        const emptyResult = (this._isMany ? [] : null) as unknown as R;
        return Promise.resolve(emptyResult).then(onfulfilled as any);
      }

      // 2. PROCESAMIENTO CENTRALIZADO DE RELACIONES (POPULATE)
      let processedData = Array.isArray(rawData) ? [...rawData] : { ...rawData };

      for (const path of this._populates) {
        processedData = await this.repositoryContext.relationEngine.populate(processedData, path);
      }

      // 3. APLICACIÓN DE PROYECCIONES DE COLUMNAS A TRAVÉS DEL ENGINE
      let result: any;
      if (this._isMany && Array.isArray(processedData)) {
        result = processedData.map(item => {
          const projected = this.repositoryContext.gettersEngine.applyProjection(item, this._projection);
          return this.hydrate(projected);
        });
      } else {
        const projected = this.repositoryContext.gettersEngine.applyProjection(processedData, this._projection);
        result = this.hydrate(projected);
      }

      return Promise.resolve(result as R).then(onfulfilled as any);
    } catch (error) {
      this.logger.error(`❌ Error procesando DocumentQuery para la entidad [${this.entityClass.name}]: ${error.message}`);
      throw error;
    }
  }
  /**
   * Instancia la entidad pura y la envuelve en un patrón Active Record (Documento Vivo)
   * inyectándole los métodos nativos de persistencia (.save(), .delete()).
   */
  private hydrate(data: any): SheetDocument<T> {
    const instance = new this.entityClass();

    // Mapeamos los datos al objeto plano de la clase entidad
    Object.assign(instance, data);

    // Devolvemos el Documento Vivo conectado al repositorio de Google Sheets actual
    return new SheetDocument(instance, this.sheetRepository);
  }
}