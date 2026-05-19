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
import { SheetsDataGateway } from "@database/services/sheetDataGateway/sheetDataGateway";
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
import { CascadeDeleteOrchestrator } from "./CascadeDeleteOrchestrator";
import { QueryExecutionEngine } from "./QueryExecutionEngine";
import { RelationalUpsertOrchestrator } from "./RelationalUpsertOrchestrator";
import { SheetDocumentHydrator } from "./SheetDocumentHydrator";
import { SheetMetadataOrchestrator } from "@database/services/sheetDataGateway/SheetMetadataOrchestrator";
import { SheetsPersistenceService } from "@database/services/sheetDataGateway/SheetsPersistenceService";
import { SheetProvisioner } from "@database/services/sheetDataGateway/sheet.provisioner";
import { SheetsApiClient } from "@database/services/sheetDataGateway/SheetsApiClient";

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
        private readonly compareEngine: CompareEngine, // Asumiendo que es un Singleton global
        private readonly relationalUpsertOrchestrator: RelationalUpsertOrchestrator,
        private readonly hydrator: SheetDocumentHydrator,
        private readonly cascadeDeleteOrchestrator: CascadeDeleteOrchestrator,
        private readonly queryExecutionEngine: QueryExecutionEngine,

        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,


        // 🌟 Inyecciones necesarias para suministrar al constructor del Gateway
        private readonly apiClient: SheetsApiClient,
        private readonly persistence: SheetsPersistenceService,
        private readonly metadataOrchestrator: SheetMetadataOrchestrator,
        private readonly provisioner: SheetProvisioner,

    ) { }
    public create(entity: ClassType<T>): SheetsRepository<T> {
        const schema = SchemaFactory.createForClass(entity);
        if (!schema.sheetName) {
            throw new Error(`La entidad ${entity.name} requiere obligatoriamente el decorador @Table o configuración de pestaña.`);
        }

        // Resoluciones iniciales de contexto cruzado
        const contextProxy: any = {};
        const expressionEngine = new ExpressionEngine(entity);
        const manipulateEngine = new ManipulateEngine<T>(entity, null as any); // Ajustar según tu metadataRegistry si aplica

        // 🌟 1. Construcción del SheetMapper específico para la entidad
        const sheetMapper = new SheetMapper<T>(
            this.optionsDatabase,
            entity,
            null as any, // Ajustar dependencias internas del constructor de tu Mapper si las pide
            null as any,
            this.cacheManager
        );

        // 🌟 2. Construcción de la instancia Real de SheetsDataGateway (Matcheando tu archivo al 100%)
        const gateway = new SheetsDataGateway<T>(
            this.apiClient,
            this.persistence,
            this.metadataOrchestrator,
            this.provisioner,
            sheetMapper,
            this.cacheManager,
            this.optionsDatabase,
            entity as any // Mantiene el token de la clase (EntityClass)
        );

        // 3. Inicialización de Motores de Consulta subordinados
        const gettersEngine = new GettersEngine<T>(
            entity,
            this.cacheManager,
            expressionEngine,
            this.compareEngine,
            this.optionsDatabase,
            gateway,
            sheetMapper
        );

        const aggregationEngine = new AggregationEngine<T>(
            expressionEngine,
            this.moduleRef,
            gateway
        );

        const relationEngine = new RelationEngine<T>(
            entity,
            () => contextProxy as RepositoryContext<T>,
            this.moduleRef
        );

        const relationalEngine = new RelationalEngine(this.moduleRef);

        const persistenceEngine = new PersistenceEngine<T>(
            entity,
            gateway,
            this.optionsDatabase,
            gettersEngine,
            this.moduleRef,
            aggregationEngine,
            null as any, // metadataRegistry
            this.compareEngine,
            relationalEngine
        );

        const queryEngine = new QueryEngine(this.compareEngine, relationEngine);
        const sheetsQuery = new SheetsQuery<T>(gettersEngine, {}, queryEngine);
        const primaryKeyProp = 'id'; // O tu extractor dinámico de PK

        // 4. Sellado final del Contexto Transportador
        const finalContext = new RepositoryContext<T>(
            entity,
            gateway.sheetName, // Extraído directamente del procesamiento del Gateway
            gateway,
            this.optionsDatabase,
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
            sheetsQuery,

            // Motores de Extirpación Quirúrgica
            this.relationalUpsertOrchestrator,
            this.hydrator,
            this.cascadeDeleteOrchestrator,
            this.queryExecutionEngine
        );

        Object.assign(contextProxy, finalContext);

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