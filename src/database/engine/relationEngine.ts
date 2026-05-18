import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { RelationOptions } from '../decorators/relation.decorator';
import { IRelationEngine } from '@database/interfaces/engine/IRelationEngine';

import { ModuleRef } from '@nestjs/core';
import { SHEETS_ALL_RELATIONS, SHEETS_RELATIONS_LIST } from '@database/constants/metadata.constants';


@Injectable()
export class RelationEngine<T> implements IRelationEngine {
    private readonly metadataKey: any;
    private readonly logger = new Logger(RelationEngine.name);
    constructor(
        private readonly entityClass: new () => T,
        // Usamos forwardRef para evitar dependencias circulares con otros motores
        @Inject(forwardRef(() => 'RepositoryContext'))
        private readonly getContext: () => any,
        private readonly moduleRef: ModuleRef,
    ) { }

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
    /**
     * Punto de entrada unificado para hidratar (populate) relaciones.
     * Soporta tanto objetos planos individuales como listados.
     */
    async populate<TData>(data: TData | TData[], path: string): Promise<any> {
        if (!data) return data;
        return await this.resolve(this.entityClass, data, path);
    }
    /**
     * Valida la integridad referencial antes de un guardado.
     * Verifica que los IDs proporcionados existan en las hojas de Google Sheets destino.
     */
    /**
     * Valida la integridad referencial antes de persistir físicamente los datos.
     * Verifica que los IDs foráneos existan realmente en las hojas destino correspondientes.
     */
    async validateRelations<TEntity>(data: TEntity): Promise<boolean> {
        if (!data) return true;

        const metadata = this.getRelationMetadata();

        for (const [fieldName, options] of Object.entries(metadata)) {
            // Solo validamos campos locales (relaciones de pertenencia donde no es Many)
            if (!options.isMany) {
                const localValue = (data as any)[options.localField];

                if (localValue !== undefined && localValue !== null && localValue !== '') {
                    const TargetEntity = options.targetEntity();

                    // Resolvemos el repositorio destino dinámicamente desde el árbol de dependencias
                    const targetRepository = this.moduleRef.get(options.targetRepository, { strict: false });

                    if (!targetRepository) {
                        this.logger.error(`❌ No se pudo resolver el repositorio "${options.targetRepository}" para validar integridad.`);
                        continue;
                    }

                    // Ejecutamos la búsqueda del ID
                    const exists = await targetRepository.findOne({
                        where: { id: localValue } // Reemplazar por primaryKey si no se llama 'id'
                    });

                    if (!exists) {
                        throw new Error(
                            `[Integrity Error] Falló la restricción de clave foránea en la propiedad "${fieldName}". ` +
                            `El valor "${localValue}" no existe en la tabla/hoja destino.`
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
        const target = this.entityClass.prototype;
        const relationsList: string[] = Reflect.getMetadata(SHEETS_RELATIONS_LIST, target) || [];
        const metadataMap: Record<string, RelationOptions> = {};

        for (const key of relationsList) {
            const options = Reflect.getMetadata(SHEETS_ALL_RELATIONS, target, key);
            if (options) {
                metadataMap[key] = options;
            }
        }
        return metadataMap;
    }

    /**
     * Resuelve las relaciones solicitadas (populate) para una entidad o lista de entidades.
     */
    /**
     * Tu método resolve mejorado para ser llamado desde populate
     */
    /**
     * Resuelve las relaciones solicitadas de manera recursiva (soporta notación de puntos '.' para sub-niveles).
     */
    private async resolve(currentClass: new () => any, data: any | any[], path: string): Promise<any> {
        if (!data) return data;

        // Si es un array, procesamos concurrentemente cada elemento de la fila
        if (Array.isArray(data)) {
            return await Promise.all(data.map(item => this.resolve(currentClass, item, path)));
        }

        const parts = path.split('.');
        const currentField = parts[0];
        const remainingPath = parts.slice(1).join('.');

        // 1. EXTRAER METADATOS UTILIZANDO LAS CONSTANTES UNIFICADAS (Desde el prototipo)
        const targetPrototype = currentClass.prototype;
        const options: RelationOptions = Reflect.getMetadata(SHEETS_ALL_RELATIONS, targetPrototype, currentField);

        if (!options) {
            this.logger.warn(`No se encontró configuración de relación para el campo "${currentField}" en la clase ${currentClass.name}`);
            return data;
        }

        const TargetEntityClass = options.targetEntity();

        // 🔥 CORRECCIÓN 1: Extraer el valor local soportando si 'data' es un SheetDocument o un objeto plano
        const targetData = (data as any).data ?? (data as any)._snapshot ?? data;
        const localValue = targetData[options.localField];

        // 2. RESOLVER EL REPOSITORIO DESTINO VÍA NESTJS MODULEREF
        const targetRepository = this.moduleRef.get(options.targetRepository, { strict: false });

        if (!targetRepository) {
            this.logger.error(`❌ Repositorio de relación "${options.targetRepository}" no disponible en el contexto de NestJS.`);
            return data;
        }

        let relatedResult: any;

        // 3. CONSULTAR USANDO LA CAPA DE PERSISTENCIA CORRECTA DEL REPOSITORIO HIJO
        if (options.isMany) {
            this.logger.debug(`[RelationEngine] Buscando hijos (1:N) en repositorio remoto para el campo "${currentField}"`);

            // 🚀 CORRECCIÓN 2: Invocación limpia delegando la construcción de opciones por defecto al repositorio hijo
            relatedResult = await targetRepository.find(
                { [options.joinColumn]: localValue },
                undefined // Permitimos que el Repositorio use sus QueryOptions por defecto integrales
            );
        } else {
            // Relación directa (1:1 / N:1) -> Buscamos por la clave primaria remota o columna asignada
            this.logger.debug(`[RelationEngine] Buscando hijo directo (1:1) en repositorio remoto para el campo "${currentField}"`);
            relatedResult = await targetRepository.findOne({
                [options.joinColumn || 'id']: localValue
            });
        }

        // 4. RECURSIVIDAD PROFUNDA
        // Si quedan rutas pendientes (ej. 'asistencias.marcas') y tenemos datos, seguimos bajando por el árbol
        if (remainingPath && relatedResult) {
            relatedResult = await this.resolve(TargetEntityClass, relatedResult, remainingPath);
        }

        // 5. ASIGNACIÓN E HIDRATACIÓN EN LA ENTIDAD PADRE (CONSERVANDO PERSISTENCIA)
        // 🔥 CORRECCIÓN 3: Escribimos tanto en la raíz como en el almacenamiento real del Wrapper (_snapshot / data)
        // para asegurar que .toObject(), .entity y la serialización JSON de NestJS expongan la subcolección.
        if ((data as any)._snapshot) {
            (data as any)._snapshot[currentField] = relatedResult;
        }
        if ((data as any).data) {
            (data as any).data[currentField] = relatedResult;
        }

        // Asignación fallback en la raíz por si se consume como objeto plano
        data[currentField] = relatedResult;

        return data;
    }
}