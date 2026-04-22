import { SheetDocument } from "@database/wrapper/sheet.document";
import { CompareEngine } from "./compare.engine";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { GoogleSpreedsheetService } from "@database/services/google.spreedsheet.service";
import { EntityFilterQuery, Projection } from "@database/types/query.types";
import { ManipulateEngine } from "./manipulateEngine";
import { BaseSheetsCrudService } from "@database/services/base.sheets.crud.service";

// También actualizamos el retorno aquí
@Injectable()
export class DocumentQuery<T extends object> implements PromiseLike<SheetDocument<T> | null> {
  private readonly logger = new Logger(DocumentQuery.name);
  private _populates: string[] = [];
  private _projection: Projection<T> = {};

  constructor(
    private readonly googleSheets: GoogleSpreedsheetService<T>,
    private readonly filter: EntityFilterQuery<T>,
    public readonly queryEngine: CompareEngine<T>,
    public readonly manipulateEngine: ManipulateEngine<T>,
    private readonly service: BaseSheetsCrudService<T>,

  ) { }
  /**
     * Define qué campos incluir o excluir
     */
  select(projection: Projection<T>): this {
    this._projection = projection;
    return this;
  }

  populate(path: string): this {
    this._populates.push(path);
    return this;
  }
  // src/database/wrapper/document.query.ts

  async then<TResult1 = SheetDocument<T> | null, TResult2 = never>(
    onfulfilled?: ((value: SheetDocument<T> | null) => TResult1 | PromiseLike<TResult1>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    try {
      // 1. DATA RAW: Desde Google Sheets
      const allRecords = await this.googleSheets.findAll();
      const rawData = allRecords.find((r: T) => this.queryEngine.applyFilter(r, this.filter));

      if (!rawData) return Promise.resolve(null).then(onfulfilled) as any;

      // 2. PROYECCIÓN: "Podamos" el objeto (Asegura el ID)
      // Usamos casting a 'any' para evadir el scope 'protected' si es necesario
      let data = (this.service as any).applyProjection(rawData, this._projection);

      // 3. POPULATE: Resolución de relaciones (simples o anidadas)
      if (this._populates.length > 0) {
        for (const path of this._populates) {
          data = await this.service.executePopulate(data, path);
        }
      }

      // 4. DOCUMENT: Envolvemos en el "Documento Vivo"
      const doc = new SheetDocument<T>(
        data as T,
        this.service,
        this.manipulateEngine
      );

      return Promise.resolve(doc).then(onfulfilled) as any;
    } catch (error) {
      this.logger.error(`Error en DocumentQuery: ${error.message}`);
      throw error;
    }
  }
}