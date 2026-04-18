// Renombramos a SheetDocument para evitar conflicto con el DOM
export class SheetDocument<T> {
    private readonly _repository: any;
    private readonly _manipulateEngine: any;

    constructor(data: T, repository: any, manipulateEngine: any) {
        this._repository = repository;
        this._manipulateEngine = manipulateEngine;

        // Mantenemos la compatibilidad 100%: copiamos propiedades al root
        Object.assign(this, data);
    }

    async save(): Promise<T> {
        const rawData = this.toObject();

        // 1. Aplanamos populates (de objeto a ID)
        const payload = this.prepareForPersistence(rawData);

        // 2. Transformaciones (ManipulateEngine)
        const processedData = this._manipulateEngine.prepareForSave(payload);

        // 3. Persistencia
        const id = (processedData as any).id;
        let result: T;

        if (id) {
            result = await this._repository.findOneAndUpdate({ id }, { $set: processedData });
        } else {
            result = await this._repository.create(processedData);
        }

        Object.assign(this, result);
        return result;
    }

    private prepareForPersistence(data: any): any {
        const copy = { ...data };
        for (const key in copy) {
            if (copy[key] && typeof copy[key] === 'object' && copy[key].id) {
                copy[key] = copy[key].id;
            }
        }
        return copy;
    }

    toObject(): T {
        const obj: any = { ...this };
        Object.keys(obj).forEach(key => {
            if (key.startsWith('_') || typeof obj[key] === 'function') delete obj[key];
        });
        return obj as T;
    }
}