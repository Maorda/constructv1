import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { RELATION_METADATA_KEY, RelationOptions } from '../decorators/relation.decorator';
import { IRelationEngine } from '@database/interfaces/engine/IRelationEngine';
import { TABLE_COLUMN_DETAILS_KEY } from '@database/decorators/column.decorator';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class RelationEngine<T> implements IRelationEngine {
    private readonly metadataKey: any;
    constructor(
        private readonly entityClass: new () => T,
        // Usamos forwardRef para evitar dependencias circulares con otros motores
        @Inject(forwardRef(() => 'RepositoryContext'))
        private readonly getContext: () => any,
        private readonly moduleRef: ModuleRef,
    ) {
        this.metadataKey = Reflect.getMetadata(RELATION_METADATA_KEY, this.entityClass.prototype) || {};
    }

    /**
 * Implementación de Joins lógicos para el ODM de Google Sheets.
 * @param data Registros de la colección principal (Hoja origen)
 * @param config Configuración del lookup (from, localField, foreignField, as)
 */
    async applyLookup<T>(data: T[], config: {
        from: string;           // Nombre de la hoja/entidad destino
        localField: string;     // Campo en la entidad actual
        foreignField: string;   // Campo en la entidad destino
        as: string;             // Nombre de la propiedad resultante
    }): Promise<any[]> {
        const { from, localField, foreignField, as } = config;

        // 1. Obtenemos el repositorio de la entidad destino a través del ModuleRef
        // Nota: Esto asume que tienes un Registry o que el ModuleRef puede resolverlo
        const targetRepository = this.moduleRef.get(`${from}Repository`, { strict: false });

        if (!targetRepository) {
            console.warn(`[RelationEngine] No se encontró el repositorio para: ${from}`);
            return data;
        }

        // 2. Extraemos todos los IDs únicos del localField para hacer una sola consulta masiva (Optimización)
        const localValues = [...new Set(data.map(item => item[localField as keyof T]).filter(val => val !== undefined && val !== null))];

        if (localValues.length === 0) {
            return data.map(item => ({ ...item, [as]: [] }));
        }

        // 3. Consultamos la hoja destino buscando coincidencias ($in)
        // Usamos el SheetsQuery del repositorio destino
        const relatedDocs = await targetRepository.find({
            where: {
                [foreignField]: { $in: localValues }
            }
        });

        // 4. Mapeo y Ensamblaje (Join en memoria)
        return data.map(item => {
            const itemValue = item[localField as keyof T];

            // Filtramos los documentos relacionados que coinciden con el valor local
            const matches = relatedDocs.filter(doc => {
                // Normalizamos la comparación (especialmente útil para IDs numéricos o strings)
                return String(doc[foreignField]) === String(itemValue);
            });

            // Retornamos el objeto extendido con la nueva propiedad 'as'
            return {
                ...item,
                [as]: matches
            };
        });
    }
    /**
     * Punto de entrada principal para cargar relaciones.
     * Soporta tanto objetos únicos como arrays.
     */
    async populate<TData>(data: TData | TData[], path: string): Promise<any> {
        if (!data) return data;
        // Delegamos a resolve para aprovechar la lógica recursiva que ya tienes
        return await this.resolve(this.entityClass, data, path);
    }
    /**
     * Valida la integridad referencial antes de un guardado.
     * Verifica que los IDs proporcionados existan en las hojas de Google Sheets destino.
     */
    async validateRelations<TEntity>(data: TEntity): Promise<boolean> {
        const ctx = this.getContext();
        const relations = Object.entries(this.metadataKey);

        for (const [fieldName, options] of relations) {
            const opt = options as RelationOptions;

            // Solo validamos relaciones 1:1 (donde tenemos el ID local)
            if (!opt.isMany) {
                const localValue = (data as any)[opt.localField];

                if (localValue) {
                    const TargetClass = opt.targetEntity();
                    // Intentamos buscar el ID en la hoja destino
                    const exists = await ctx.gettersEngine.findOneById(TargetClass, localValue);

                    if (!exists) {
                        throw new Error(
                            `Error de Integridad: La relación "${fieldName}" falló. ` +
                            `No existe un registro con ID "${localValue}" en la entidad destino.`
                        );
                    }
                }
            }
        }
        return true;
    }
    /**
     * Retorna el mapa completo de relaciones configuradas para esta entidad.
     */
    getRelationMetadata(): Record<string, RelationOptions> {
        return this.metadataKey;
    }

    /**
     * Resuelve las relaciones solicitadas (populate) para una entidad o lista de entidades.
     */
    /**
     * Tu método resolve mejorado para ser llamado desde populate
     */
    async resolve<TEntity>(entityClass: new () => TEntity, data: any | any[], path: string): Promise<any> {
        if (!data) return data;

        if (Array.isArray(data)) {
            return await Promise.all(data.map(item => this.resolve(entityClass, item, path)));
        }

        const ctx = this.getContext();
        const parts = path.split('.');
        const currentField = parts[0];
        const remainingPath = parts.slice(1).join('.');

        // IMPORTANTE: Obtenemos metadatos de la clase actual (podría ser una hija en recursividad)
        const currentMetadata = Reflect.getMetadata(RELATION_METADATA_KEY, entityClass.prototype) || {};
        const options: RelationOptions = currentMetadata[currentField];

        if (!options) return data;

        const TargetClass = options.targetEntity();
        const localValue = data[options.localField];

        if (!localValue && !options.isMany) return data;

        let relatedResult: any;

        if (options.isMany) {
            // Caso: Obra -> Muchos Obreros (Buscamos obreros donde idObra === localValue)
            const allItems = await ctx.gettersEngine.findAll(TargetClass);
            relatedResult = allItems.filter((item: any) => item[options.joinColumn] === localValue);
        } else {
            // Caso: Obrero -> Una Obra
            relatedResult = await ctx.gettersEngine.findOneById(TargetClass, localValue);
        }

        // Transformación a Documentos Vivos
        if (relatedResult) {
            if (Array.isArray(relatedResult)) {
                relatedResult = relatedResult.map(item => {
                    const doc = ctx.mapper.mapRowToEntity(item, TargetClass);
                    if (doc.setContext) doc.setContext(ctx);
                    return doc;
                });
            } else {
                const doc = ctx.mapper.mapRowToEntity(relatedResult, TargetClass);
                if (doc.setContext) doc.setContext(ctx);
                relatedResult = doc;
            }
        }

        // Recursividad para paths profundos (ej: 'supervisor.direccion.ciudad')
        if (remainingPath && relatedResult) {
            relatedResult = await this.resolve(TargetClass, relatedResult, remainingPath);
        }

        data[currentField] = relatedResult;
        return data;
    }
}