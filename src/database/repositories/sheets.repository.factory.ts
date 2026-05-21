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
import { SheetMetadataOrchestrator } from "@database/gatewayManager/SheetMetadataOrchestrator";
import { SheetsPersistenceService } from "@database/services/sheetDataGateway/SheetsPersistenceService";
import { SheetProvisioner } from "@database/gatewayManager/sheet.provisioner";
import { SheetsApiClient } from "@database/services/sheetDataGateway/SheetsApiClient";
import { SheetDataTransformer } from "@database/engines/shereUtilsEngine/SheetDataTransformer";
import { SheetEntityBinder } from "@database/engines/shereUtilsEngine/SheetEntityBinder";
import { SheetSchemaManager } from "@database/gatewayManager/SheetSchemaManager";
import { UpdateOrchestrator } from "./UpdateOrchestrator";
import { FindOrCreateOrchestrator } from "./FindOrCreateOrchestrator";
import { CreateOrchestrator } from "./CreateOrchestrator";
import { DeleteOrchestrator } from "./DeleteOrchestrator";
import { UpdatePartialOrchestrator } from "./UpdatePartialOrchestrator";
import { MutationOrchestrator } from "@database/orchestrator/MutationOrchestrator";
import { QueryOrchestrator } from "@database/orchestrator/QueryOrchestrator";

@Injectable()
export class SheetsRepositoryFactory<T extends object> {
    constructor(
        // Inyecciones globales
        @Inject(ProjectionService) private readonly projectionService: ProjectionService<any>,
        private readonly moduleRef: ModuleRef,
        @Inject('DATABASE_OPTIONS') private readonly optionsDatabase: DatabaseModuleOptions,
        @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        private readonly googleAuthService: GoogleAutenticarService,
        private readonly metadataRegistry: MetadataRegistry, // CLAVE: Aquí estaba el servicio perdido
        private readonly compareEngine: CompareEngine,
        private readonly relationalUpsertOrchestrator: RelationalUpsertOrchestrator,
        private readonly hydrator: SheetDocumentHydrator,
        private readonly cascadeDeleteOrchestrator: CascadeDeleteOrchestrator,
        private readonly queryExecutionEngine: QueryExecutionEngine,

        // Inyecciones del Gateway
        private readonly apiClient: SheetsApiClient,
        private readonly persistence: SheetsPersistenceService,
        private readonly metadataOrchestrator: SheetMetadataOrchestrator<T>,
        private readonly provisioner: SheetProvisioner,
        private readonly binder: SheetEntityBinder<T>,
        private readonly schemaManager: SheetSchemaManager<T>,
        private readonly transformer: SheetDataTransformer,
        private readonly updateOrchestrator: UpdateOrchestrator,
        private readonly createOrchestrator: CreateOrchestrator,
        private readonly updatePartialOrchestrator: UpdatePartialOrchestrator,
        private readonly deleteOrchestrator: DeleteOrchestrator,
        private readonly findOrCreateOrchestrator: FindOrCreateOrchestrator,
        // Inyectamos los dos únicos orquestadores
        private readonly mutationOrchestrator: MutationOrchestrator,
        private readonly queryOrchestrator: QueryOrchestrator,

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
            this.binder,
            this.schemaManager,
        );

        // 🌟 2. Construcción de la instancia Real de SheetsDataGateway (Matcheando tu archivo al 100%)
        const gateway = new SheetsDataGateway<T>(
            this.apiClient,
            this.persistence,
            this.metadataOrchestrator,
            this.provisioner,
            sheetMapper,
            this.binder,
            this.cacheManager,
            this.optionsDatabase,
            entity as any
        );

        // 3. Inicialización de Motores de Consulta subordinados
        const gettersEngine = new GettersEngine<T>(
            entity,
            this.cacheManager,
            expressionEngine,
            this.compareEngine,
            this.optionsDatabase,
            gateway,
            this.binder,
            this.transformer,
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
            this.compareEngine,
            relationalEngine,
            this.transformer,
        );

        const queryEngine = new QueryEngine(this.compareEngine, relationEngine);
        const sheetsQuery = new SheetsQuery<T>(gettersEngine, {}, queryEngine);




        // 4. Sellado final del Contexto Transportador
        const finalContext = new RepositoryContext<T>({
            entity,
            sheetName: gateway.sheetName,
            gateway,
            options: this.optionsDatabase,
            persistenceEngine,
            compareEngine: this.compareEngine,
            manipulateEngine,
            gettersEngine,
            relationalEngine,
            aggregationEngine,
            expressionEngine,
            queryEngine,
            relationEngine,
            primaryKeyProp: 'id',
            sheetsQuery,
            relationalUpsertOrchestrator: this.relationalUpsertOrchestrator,
            hydrator: this.hydrator,
            cascadeDeleteOrchestrator: this.cascadeDeleteOrchestrator,
            queryExecutionEngine: this.queryExecutionEngine,
            updateOrchestrator: this.updateOrchestrator,
            createOrchestrator: this.createOrchestrator,
            updatePartialOrchestrator: this.updatePartialOrchestrator,
            deleteOrchestrator: this.deleteOrchestrator,
            findOrCreateOrchestrator: this.findOrCreateOrchestrator,
            metadataRegistry: this.metadataRegistry,
            mutationOrchestrator: this.mutationOrchestrator,
            queryOrchestrator: this.queryOrchestrator,
            projectionService: this.projectionService,

        });
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