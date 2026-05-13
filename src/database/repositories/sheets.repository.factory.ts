import { SchemaFactory } from "@database/schema/schema.factory";
import { Inject, Injectable } from "@nestjs/common";
import { RepositoryContext } from "./repository.context";
import { GettersEngine } from "@database/engine/getters.engine";
import { ManipulateEngine } from "@database/engine/manipulateEngine";
import { PersistenceEngine } from "@database/engine/persistence.engine";
import { QueryEngine } from "@database/engine/query.engine";
import { RelationEngine } from "@database/engine/relationEngine";
import { AggregationEngine } from "@database/engines/aggregation.engine";
import { CompareEngine } from "@database/engines/compare.engine";
import { ExpressionEngine } from "@database/engines/expressionEngine";
import { RelationalEngine } from "@database/engines/relational.engine";
import { DatabaseModuleOptions } from "@database/interfaces/database.options.interface";
import { SheetsDataGateway } from "@database/services/sheetDataGateway";
import { ClassType } from "@database/types/query.types";
import { ModuleRef } from "@nestjs/core";
import { SheetsRepository } from "./sheets.repository";
import { ProjectionService } from "@database/services/projection.seervice";
import { SheetsQuery } from "@database/engines/sheet.query";
import { DatabaseModule } from "@database/database.module";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { GoogleAutenticarService } from "@database/services/auth.google.service";

@Injectable()
export class SheetsRepositoryFactory<T extends object> {
    constructor(
        @Inject(ProjectionService) private readonly projectionService: ProjectionService<any>,
        private readonly moduleRef: ModuleRef,
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions,
        // ELIMINAMOS todos los motores dinámicos del constructor

    ) { }

    create(entity: ClassType<T>): SheetsRepository<T> {
        // 1. EXTRAEMOS EL PLANO (Metadata)
        const schema = SchemaFactory.createForClass(entity);

        if (!schema.sheetName) {
            throw new Error(`La entidad ${entity.name} no tiene el decorador @Table`);
        }

        // 2. OBTENEMOS LAS DEPENDENCIAS GLOBALES DEL MODULE REFRE
        // Esto permite que la fábrica sea "ligera" al arrancar
        const container = {
            gateway: null, // Se creará dentro de createRepositoryContext
            options: this.options,
            cache: this.moduleRef.get(CACHE_MANAGER, { strict: false }),
            moduleRef: this.moduleRef,
            googleAuthService: this.moduleRef.get(GoogleAutenticarService, { strict: false }),
            queryEngine: this.moduleRef.get(QueryEngine, { strict: false }),
            compareEngine: this.moduleRef.get(CompareEngine, { strict: false }),
        };

        // 3. USAMOS EL MÉTODO ESTÁTICO DEL MÓDULO PARA CREAR EL CONTEXTO
        // IMPORTANTE: Debes llamar al método que centraliza la lógica de 'new Engine()'
        const context = DatabaseModule.createRepositoryContext(entity, container);

        // 4. RETORNAMOS EL REPOSITORIO
        return new SheetsRepository(
            entity,
            context,
            schema.virtuals || {},
            this.projectionService,
        );
    }
}