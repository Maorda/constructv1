import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { IRelationEngine } from '@database/interfaces/engine/IRelationEngine';

@Injectable()
export class RelationEngine implements IRelationEngine {
    constructor(
        // Usamos forwardRef para evitar dependencias circulares con otros motores
        @Inject(forwardRef(() => 'RepositoryContext'))
        private readonly getContext: () => any
    ) { }

    /**
     * Resuelve las relaciones solicitadas (populate) para una entidad o lista de entidades.
     */
    async resolve<T>(entityClass: new () => T, data: any | any[], path: string): Promise<any> {
        if (!data) return data;

        // Si es un array de resultados, procesamos cada uno
        if (Array.isArray(data)) {
            return await Promise.all(data.map(item => this.resolve(entityClass, item, path)));
        }

        const ctx = this.getContext();
        const parts = path.split('.'); // Soporte para 'supervisores.cuadrillas'
        const currentField = parts[0];
        const remainingPath = parts.slice(1).join('.');

        // 1. Obtener la configuración de la relación desde la metadata de la propiedad
        const options: RelationOptions = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            entityClass.prototype,
            currentField
        );

        if (!options) return data;

        // 2. Ejecutar la búsqueda del/los hijo(s)
        const TargetClass = options.targetEntity();
        const localValue = data[options.localField];

        if (!localValue) return data;

        let relatedResult: any;

        if (options.isMany) {
            // Caso: Una Obra tiene MUCHOS Supervisores
            // Buscamos en la pestaña destino donde la joinColumn coincida con nuestro ID
            const allItems = await ctx.gettersEngine.findAll(TargetClass);
            relatedResult = allItems.filter(item => item[options.joinColumn] === localValue);
        } else {
            // Caso: Un Supervisor tiene UNA Obra
            relatedResult = await ctx.gettersEngine.findOneById(TargetClass, localValue);
        }

        // 3. Convertir resultados en "Documentos Vivos" (SheetDocument)
        if (relatedResult) {
            if (Array.isArray(relatedResult)) {
                relatedResult = relatedResult.map(item => {
                    const doc = ctx.mapper.mapRowToEntity(item, TargetClass);
                    doc.setContext(ctx);
                    return doc;
                });
            } else {
                const doc = ctx.mapper.mapRowToEntity(relatedResult, TargetClass);
                doc.setContext(ctx);
                relatedResult = doc;
            }
        }

        // 4. RECURSIVIDAD: Si hay más niveles (ej. .cuadrillas), seguimos bajando
        if (remainingPath && relatedResult) {
            relatedResult = await this.resolve(TargetClass, relatedResult, remainingPath);
        }

        // Asignamos el resultado al objeto original
        data[currentField] = relatedResult;
        return data;
    }
}