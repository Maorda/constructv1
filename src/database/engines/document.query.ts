import { SheetDocument } from "@database/wrapper/sheet.document";
import { CompareEngine } from "./compare.engine";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { SheetsDataGateway } from "@database/services/sheetDataGateway";
import { EntityFilterQuery, Projection } from "@database/types/query.types";
import { ManipulateEngine } from "../engine/manipulateEngine";
import { BaseSheetsCrudService } from "@database/services/base.sheets.crud.service";
import { BaseEngine } from "./Base.Engine";
import { RepositoryContext } from "@database/repositories/repository.context";
import { BaseServiceInterface } from "@database/interfaces/base.service.interface";


/*
*1. ¿Qué es DocumentQuery? (Función Fundamental)
*Es la clase encargada de la Lazy Evaluation (evaluación perezosa). 
*Su función es permitir que el programador "encadene" filtros antes
*de ejecutar la consulta real en Google Sheets.
*Sin DocumentQuery, tendrías que pasar 20 argumentos a un método find()
*/

// También actualizamos el retorno aquí
@Injectable()
export class DocumentQuery<T extends object> implements PromiseLike<SheetDocument<T> | null> {
  private readonly logger = new Logger(DocumentQuery.name);
  private _populates: string[] = [];
  private _projection: Projection = {};

  constructor(
    private readonly EntityClass: new () => T,
    private readonly filter: EntityFilterQuery<T> = {},
    private readonly repositoryContext: RepositoryContext, // <--- INYECTAMOS EL CONTEXTO
    private readonly isMany?: boolean
  ) { }
  /**
     * Define qué campos incluir o excluir
     */
  select(projection: Projection): this {
    this._projection = projection;
    return this;
  }

  populate(path: string): this {
    this._populates.push(path);
    return this;
  }
  // src/database/wrapper/document.query.ts

  async then<TResult1 = any, TResult2 = never>(
    onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    try {
      // 1. DATA RAW: Pasamos this.EntityClass para que el SpreadsheetService 
      // y el SheetMapper sepan cómo transformar fechas con Day.js
      const allRecords = await this.repositoryContext.gettersEngine.findAll(this.EntityClass);

      // CORRECCIÓN: Quitamos el casting (r: T) ya que T no existe en el scope de la clase
      const rawData = allRecords.find((r: any) => this.repositoryContext.compareEngine.applyFilter(r, this.filter));

      if (!rawData) {
        return Promise.resolve(null).then(onfulfilled) as any;
      }

      // 2. PROYECCIÓN: Filtramos columnas
      let data = this.service.applyProjection(rawData, this._projection);

      // 3. POPULATE: Resolución de relaciones
      if (this._populates.length > 0) {
        for (const path of this._populates) {
          // El RelationEngine hace todo el trabajo de buscar, filtrar y convertir a Documentos

          data = await this.repositoryContext.relationEngine.resolve(
            this.EntityClass,
            data,
            path
          );
        }
      }

      // 4. DOCUMENT: Envolvemos en el "Documento Vivo"
      // Pasamos la clase para que el documento sepa quién es su "dueño"
      const doc = new SheetDocument(
        data,
        this.service,
        this.repositoryContext,
        this.EntityClass // <--- Es vital pasar esto para futuros guardados (save)
      );

      return Promise.resolve(doc).then(onfulfilled) as any;
    } catch (error) {
      this.logger.error(`Error en DocumentQuery: ${error.message}`);
      throw error;
    }
  }
}