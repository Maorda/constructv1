import { SheetDocument } from "@database/wrapper/wrapper.document";

// También actualizamos el retorno aquí
export class DocumentQuery<T> implements PromiseLike<SheetDocument<T> | null> {
  private _populates: string[] = [];

  constructor(
    private readonly repository: any,
    private readonly filter: any,
    private readonly queryEngine: any,
    private readonly manipulateEngine: any
  ) { }

  populate(path: string): this {
    this._populates.push(path);
    return this;
  }

  async then<TResult1 = SheetDocument<T> | null, TResult2 = never>(
    onfulfilled?: ((value: SheetDocument<T> | null) => TResult1 | PromiseLike<TResult1>) | undefined | null
  ): Promise<TResult1 | TResult2> {
    try {
      const allRecords = await this.repository.findAll();
      const rawData = allRecords.find((r: T) => this.queryEngine.applyFilter(r, this.filter));

      if (!rawData) return Promise.resolve(null).then(onfulfilled) as any;

      let data = { ...rawData };

      for (const path of this._populates) {
        data = await this.repository.executePopulate(data, path);
      }

      // Devolvemos SheetDocument
      const doc = new SheetDocument<T>(data, this.repository, this.manipulateEngine);
      return Promise.resolve(doc).then(onfulfilled) as any;
    } catch (error) {
      throw error;
    }
  }
}