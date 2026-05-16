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
        // 1. ANÁLISIS DE METADATOS EXTRAÍDOS DEL ESQUEMA
        const schema = SchemaFactory.createForClass(entity);
        if (!schema.sheetName) {
            throw new Error(`La entidad ${entity.name} requiere obligatoriamente el decorador @Table.`);
        }

        const sheetName = schema.sheetName
            ? schema.sheetName.toUpperCase()
            : this.normalizeEntityName(entity.name);

        // 2. INICIALIZACIÓN DE MOTORES MATEMÁTICOS Y DE EXPRESIONES
        const expressionEngine = new ExpressionEngine(entity);
        const manipulateEngine = new ManipulateEngine<T>(entity, this.metadataRegistry);

        // 3. CAPA DE INFRAESTRUCTURA DE RED (GATEWAY Y MAPPER)
        const gateway = new SheetsDataGateway<T>(
            this.googleAuthService,
            this.cache,
            this.options,
            entity,
            this.metadataRegistry,
            null as any // Inyección diferida para romper ciclo
        );

        const sheetMapper = new SheetMapper<T>(
            this.options,
            entity,
            this.googleAuthService,
            gateway,
            this.cache
        );

        // Resolución de la referencia circular del Gateway
        (gateway as any).sheetMapper = sheetMapper;

        // 4. INSTANCIACIÓN DE MOTORES DE CONSULTA (GETTERS Y AGGREGATION)
        const gettersEngine = new GettersEngine<T>(
            entity,
            this.cache,
            expressionEngine,
            this.compareEngine,
            this.options,
            gateway,
            sheetMapper
        );

        const aggregationEngine = new AggregationEngine<T>(
            expressionEngine,
            this.moduleRef,
            gateway
        );

        // 5. SOLUCIÓN RELACIONAL: Respetamos las dos clases independientes según tus scripts
        const contextProxy: any = {};

        // RelationEngine: Mantiene la callback para resolver referencias cruzadas en queries (.populate)
        const relationEngine = new RelationEngine<T>(
            entity,
            () => contextProxy as RepositoryContext<T>,
            this.moduleRef
        );

        // RelationalEngine: Firma estricta de UN (1) argumento para despachar borrados en cascada
        const relationalEngine = new RelationalEngine(this.moduleRef);

        // 6. MOTOR DE PERSISTENCIA CON EL INYECTOR DE BORRADOS EN CASCADA
        const persistenceEngine = new PersistenceEngine<T>(
            entity,
            gateway,
            this.options,
            gettersEngine,
            this.moduleRef,
            aggregationEngine,
            this.metadataRegistry,
            this.compareEngine,
            relationalEngine // Envía el despachador de borrados modificado en el paso anterior
        );

        // 7. MOTOR DE QUERIES NO-SQL
        const queryEngine = new QueryEngine(this.compareEngine, relationEngine);
        const sheetsQuery = new SheetsQuery<T>(gettersEngine, {}, queryEngine);
        const primaryKeyProp = this.metadataRegistry.getPrimaryKeyField(entity);

        // 8. CONSTRUCCIÓN Y SELLADO DEL CONTEXTO DE OPERACIONES
        const finalContext = new RepositoryContext<T>(
            entity,
            sheetName,
            gateway,
            this.options,
            persistenceEngine,
            this.compareEngine,
            manipulateEngine,
            gettersEngine,
            relationalEngine, // Pasado limpiamente al contexto
            aggregationEngine,
            expressionEngine,
            queryEngine,
            relationEngine,   // Mantiene el resolvedor de populates
            primaryKeyProp,
            sheetsQuery
        );

        // Sincronizamos el Proxy en memoria para activar las llamadas circulares de relaciones
        Object.assign(contextProxy, finalContext);

        // 9. RETORNO DEL REPOSITORIO DE CARGA
        return new SheetsRepository(
            entity,
            finalContext,
            schema.virtuals || {}
        );
    }

    /**
     * Convierte nombres de clase en plurales funcionales en mayúsculas.
     */
    private normalizeEntityName(className: string): string {
        let name = className.replace(/(Entity|Model|Repository)$/i, '');
        const lastChar = name.slice(-1).toLowerCase();

        if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
            name = `${name}s`;
        } else if (lastChar === 'z') {
            name = `${name.slice(0, -1)}ces`;
        } else {
            name = `${name}es`;
        }

        return name.toUpperCase();
    }
}