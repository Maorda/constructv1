import { Inject, Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";

import { SchemaFactory } from "@database/schema/schema.factory";
import { RepositoryContext } from "./repository.context";
import { SheetsRepository } from "./sheets.repository";
import { DatabaseModuleOptions } from "@database/interfaces/database.options.interface";
import { ClassType } from "@database/types/query.types";

// Servicios Globales
import { GoogleAutenticarService } from "@database/services/auth.google.service";
import { ProjectionService } from "@database/services/projection.seervice";
import { MetadataRegistry } from "@database/services/metadata.registry";
import { SheetsDataGateway } from "@database/services/sheetDataGateway";
import { SheetMapper } from "@database/engines/shereUtilsEngine/sheet.mapper";

// Motores Dinámicos y Específicos por Entidad
import { GettersEngine } from "@database/engine/getters.engine";
import { ManipulateEngine } from "@database/engine/manipulateEngine";
import { PersistenceEngine } from "@database/engine/persistence.engine";
import { QueryEngine } from "@database/engine/query.engine";
import { RelationEngine } from "@database/engine/relationEngine";
import { AggregationEngine } from "@database/engines/aggregation.engine";
import { CompareEngine } from "@database/engines/compare.engine";
import { ExpressionEngine } from "@database/engines/expressionEngine";
import { RelationalEngine } from "@database/engines/relational.engine";
import { SheetsQuery } from "@database/engines/sheet.query";

@Injectable()
export class SheetsRepositoryFactory<T extends object> {
    constructor(
        // 1. INYECCIÓN NATIVA DE SERVICIOS GLOBALES Y SINGLETONS
        // NestJS se encarga de proveer todo esto automáticamente al arrancar.
        @Inject(ProjectionService) private readonly projectionService: ProjectionService<any>,
        private readonly moduleRef: ModuleRef,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions,
        @Inject(CACHE_MANAGER) private readonly cache: Cache,
        private readonly googleAuthService: GoogleAutenticarService,
        private readonly metadataRegistry: MetadataRegistry,
        private readonly compareEngine: CompareEngine // Asumiendo que es un Singleton global
    ) { }

    create(entity: ClassType<T>): SheetsRepository<T> {
        // 1. EXTRAEMOS EL PLANO (Metadata)
        const schema = SchemaFactory.createForClass(entity);

        if (!schema.sheetName) {
            throw new Error(`La entidad ${entity.name} no tiene el decorador @Table`);
        }

        const sheetName = schema.sheetName
            ? schema.sheetName.toUpperCase()
            : this.normalizeEntityName(entity.name);

        // 2. INSTANCIACIÓN DE MOTORES ESPECÍFICOS PARA LA ENTIDAD
        // Al usar 'new' aquí, aseguramos que cada repositorio tenga sus propios motores
        // vinculados exclusivamente a su entidad (T), sin cruzar datos.
        const expressionEngine = new ExpressionEngine(entity);
        const manipulateEngine = new ManipulateEngine<T>(entity, this.metadataRegistry);

        // 3. PUENTE CON GOOGLE SHEETS (Gateway & Mapper)
        // Resolvemos la instanciación circular mediante asignación posterior.
        const gateway = new SheetsDataGateway<T>(
            this.googleAuthService,
            this.cache,
            this.options,
            entity,
            this.metadataRegistry,
            null as any // Se inyecta después
        );

        const sheetMapper = new SheetMapper<T>(
            this.options,
            entity,
            this.googleAuthService,
            gateway,
            this.cache
        );

        // Cerramos el ciclo
        (gateway as any).sheetMapper = sheetMapper;

        // 4. INSTANCIACIÓN DE MOTORES DE LECTURA Y PERSISTENCIA
        // CORRECCIÓN: Añadimos sheetMapper al constructor del GettersEngine
        const gettersEngine = new GettersEngine<T>(
            entity,
            this.cache,
            expressionEngine,
            this.compareEngine,
            this.options,
            gateway,
            sheetMapper // <--- ESTE ES EL ARGUMENTO QUE TE FALTABA
        );

        const aggregationEngine = new AggregationEngine<T>(
            expressionEngine,
            this.moduleRef,
            gateway
        );

        const persistenceEngine = new PersistenceEngine<T>(
            entity,
            gateway,
            this.options,
            gettersEngine,
            this.moduleRef,
            aggregationEngine,
            this.metadataRegistry,
            this.compareEngine
        );

        // 5. MOTORES DE RELACIONES Y CONSULTAS AVANZADAS
        const contextProxy: any = {};
        const relationEngine = new RelationEngine<T>(
            entity,
            () => contextProxy as RepositoryContext<T>,
            this.moduleRef
        );
        const relationalEngine = new RelationalEngine<T>(this.moduleRef);
        const queryEngine = new QueryEngine(this.compareEngine, relationEngine);

        const primaryKeyProp = this.metadataRegistry.getPrimaryKeyField(entity);
        const sheetsQuery = new SheetsQuery<T>(gettersEngine, {}, queryEngine);

        // 6. CONSTRUCCIÓN DEL CONTEXTO FINAL
        const finalContext = new RepositoryContext<T>(
            entity,
            sheetName,
            gateway,
            this.options,
            persistenceEngine,
            this.compareEngine,
            manipulateEngine,
            gettersEngine,
            relationalEngine,
            aggregationEngine,
            expressionEngine,
            queryEngine,
            relationEngine,
            primaryKeyProp,
            sheetsQuery
        );

        // Asignamos al proxy para que relationEngine pueda acceder al contexto completo
        Object.assign(contextProxy, finalContext);

        // 7. RETORNAMOS EL REPOSITORIO LISTO PARA SER INYECTADO POR NESTJS
        return new SheetsRepository(
            entity,
            finalContext,
            schema.virtuals || {},
            this.projectionService
        );
    }
    /**
     * Transforma "ObreroEntity" o "Obrero" en "OBREROS"
     */
    private normalizeEntityName(className: string): string {
        // 1. Quitamos la palabra "Entity" o "Model" si existen al final
        let name = className.replace(/(Entity|Model)$/i, '');

        // 2. Regla básica de pluralización en español/inglés simple
        // Si termina en vocal, añadir 'S'. Si termina en consonante, 'ES'.
        if (['a', 'e', 'i', 'o', 'u'].includes(name.slice(-1).toLowerCase())) {
            name = `${name}s`;
        } else {
            name = `${name}es`;
        }

        // 3. Retornar en MAYÚSCULAS
        return name.toUpperCase();
    }
}