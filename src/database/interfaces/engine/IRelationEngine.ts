/*
*Este es el cerebro detrás de los vínculos entre hojas. 
*Maneja el "Populate", permitiendo que una Obra conozca a sus Obreros y viceversa.
*/

export interface IRelationEngine {
    /** 
     * Carga los datos de una relación específica (ej: 'inspector' en la clase Obra)
     */
    populate<T>(
        data: T | T[],
        path: string,
        entityClass: new () => T
    ): Promise<any>;

    /** 
     * Resuelve las dependencias de una entidad antes de guardarla 
     * (Verifica que los IDs de las llaves foráneas existan)
     */
    validateRelations<T>(entityClass: new () => T, data: T): Promise<boolean>;

    /** Obtiene los metadatos de las relaciones definidas en la clase (@ManyToOne, etc.) */
    getRelationMetadata(entityClass: any): any;
}