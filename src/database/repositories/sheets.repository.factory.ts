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

@Injectable()
export class SheetsRepositoryFactory<T extends object> {
    constructor(
        // Inyectamos los servicios globales que el Repositorio necesita
        @Inject(ProjectionService) private readonly projectionService: ProjectionService<any>,
        private readonly moduleRef: ModuleRef, // Para buscar otros repositorios en relaciones
        // Inyectamos los motores globales
        @Inject('DATABASE_OPTIONS') private readonly options: DatabaseModuleOptions,
        public readonly gateway: SheetsDataGateway<T>,//Proveer la conexión física a Google Sheets.
        public readonly persistenceEngine: PersistenceEngine<T>,//Encargado de la escritura (Save, Update, Delete).
        public readonly compareEngine: CompareEngine,//Realiza las comparaciones (>, <, ==).
        public readonly manipulateEngine: ManipulateEngine<T>,//Realiza operaciones matemáticas y transformaciones.
        public readonly gettersEngine: GettersEngine<T>,//Encargado de la lectura y gestión de caché.
        public readonly relationalEngine: RelationalEngine<T>,
        public readonly aggregationEngine: AggregationEngine<T>,
        public readonly expressionEngine: ExpressionEngine,
        public readonly queryEngine: QueryEngine,//Procesa la lógica de filtrado y ordenamiento.
        public readonly sheetRepository: SheetsRepository<T>,
        public readonly relationEngine: RelationEngine<T>

    ) { }

    create(entity: ClassType<T>): SheetsRepository<T> {
        // 1. EXTRAEMOS EL PLANO (Metadata)
        const schema = SchemaFactory.createForClass(entity);

        if (!schema.sheetName) {
            throw new Error(`La entidad ${entity.name} no tiene el decorador @Table`);
        }

        // 2. CONFIGURAMOS EL CONTEXTO USANDO EL SCHEMA
        // Aquí es donde el schema cobra vida
        const context = new RepositoryContext<T>(
            entity,
            schema.sheetName, // Se pasa como 2do argumento, no dentro de options
            this.gateway,
            this.options,
            this.persistenceEngine,
            this.compareEngine,
            this.manipulateEngine,
            this.gettersEngine,
            this.relationalEngine,
            this.aggregationEngine,
            this.expressionEngine,
            this.queryEngine,
            this.relationEngine,
            schema.primaryKey,
        );

        // 3. PASAMOS LOS VIRTUALS Y RELACIONES AL REPOSITORIO
        const virtuals = schema.virtuals || {}; // Opcional, si los manejas en el schema

        return new SheetsRepository<T>(
            entity,
            context,
            virtuals,
            this.projectionService,
        );
    }
}