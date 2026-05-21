import { Cache } from 'cache-manager';
// Ajusta ruta
import { PersistenceEngine } from '../engine/persistence.engine'; // Ajusta ruta
import { SheetsDataGateway } from '../services/sheetDataGateway/sheetDataGateway';
import { DatabaseModuleOptions } from '../interfaces/database.options.interface';
import { CompareEngine } from '@database/engines/compare.engine';
import { AggregationEngine } from '@database/engines/aggregation.engine';
import { ExpressionEngine } from '@database/engines/expressionEngine';
import { GettersEngine } from '@database/engine/getters.engine';
import { ManipulateEngine } from '@database/engine/manipulateEngine';
import { RelationalEngine } from '@database/engines/relational.engine';
import { ModuleRef } from '@nestjs/core';
import { QueryEngine } from '@database/engine/query.engine';
import { SheetMapper } from '@database/engines/shereUtilsEngine/sheet.mapper';
import { Inject, Logger } from '@nestjs/common';
import { RelationEngine } from '@database/engine/relationEngine';
import { createModel, Model } from '@database/factory/model.factory';
import { ClassType } from '@database/types/query.types';
import { SheetsRepository } from './sheets.repository';
import { SheetsQuery } from '@database/engines/sheet.query';
import { RelationalUpsertOrchestrator } from './RelationalUpsertOrchestrator';
import { CascadeDeleteOrchestrator } from './CascadeDeleteOrchestrator';
import { QueryExecutionEngine } from './QueryExecutionEngine';
import { SheetDocumentHydrator } from './SheetDocumentHydrator';
import { UpdateOrchestrator } from './UpdateOrchestrator';
import { CreateOrchestrator } from './CreateOrchestrator';
import { UpdatePartialOrchestrator } from './UpdatePartialOrchestrator';
import { FindOrCreateOrchestrator } from './FindOrCreateOrchestrator';
import { DeleteOrchestrator } from './DeleteOrchestrator';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { ProjectionService } from '@database/services/projection.seervice';
import { MutationOrchestrator } from '@database/orchestrator/MutationOrchestrator';
import { QueryOrchestrator } from '@database/orchestrator/QueryOrchestrator';

/*
1. Los Motores (Los "Músculos")
Son los que ya hemos definido y que ejecutan la lógica pesada.
GettersEngine: Para leer y gestionar la caché.
PersistenceEngine: Para crear, actualizar y borrar filas.
QueryEngine: Para filtrar, ordenar y seleccionar campos.
ManipulateEngine: Para manipular datos.

*/
/*
2. El Contenedor (El "Cerebro")
Es la clase RepositoryContext. Su único trabajo es guardar 
las llaves (referencias) de todos los motores.
No tiene lógica propia de negocio.
Simplemente dice: "Aquí tengo a GettersEngine, a PersistenceEngine, etc."
*/
/*
3. El Repositorio (El "Músculo" Final)
Es la clase SheetsRepository. Es la que se inyecta en tus controladores.

Su trabajo es muy simple: Recibir el contexto y llamar al motor adecuado.

Ejemplo: Cuando llamas a repo.find(), el repositorio no sabe filtrar; le dice al QueryEngine: "Oye, filtra esto".
*/

// 1. Definimos la interfaz de configuración
export interface RepositoryContextOptions<T extends object> {
    entity: ClassType<T>;
    sheetName: string;
    gateway: SheetsDataGateway<T>;
    options: DatabaseModuleOptions;
    persistenceEngine: PersistenceEngine<T>;
    compareEngine: CompareEngine;
    manipulateEngine: ManipulateEngine<T>;
    gettersEngine: GettersEngine<T>;
    relationalEngine: RelationalEngine;
    aggregationEngine: AggregationEngine<T>;
    expressionEngine: ExpressionEngine;
    queryEngine: QueryEngine<T>;
    relationEngine: RelationEngine<T>;
    primaryKeyProp: string;
    sheetsQuery: SheetsQuery<T>;
    relationalUpsertOrchestrator: RelationalUpsertOrchestrator;
    hydrator: SheetDocumentHydrator;
    cascadeDeleteOrchestrator: CascadeDeleteOrchestrator;
    queryExecutionEngine: QueryExecutionEngine;
    updateOrchestrator: UpdateOrchestrator;
    createOrchestrator: CreateOrchestrator;
    updatePartialOrchestrator: UpdatePartialOrchestrator;
    deleteOrchestrator: DeleteOrchestrator;
    findOrCreateOrchestrator: FindOrCreateOrchestrator;
    metadataRegistry: MetadataRegistry;
    mutationOrchestrator: MutationOrchestrator;
    queryOrchestrator: QueryOrchestrator;
    projectionService: ProjectionService<any>;
}
export class RepositoryContext<T extends object> implements RepositoryContextOptions<T> {
    // Declaración explícita de propiedades para que TS las reconozca
    public readonly entity!: ClassType<T>;
    public readonly sheetName!: string;
    public readonly gateway!: SheetsDataGateway<T>;
    public readonly options!: DatabaseModuleOptions;
    public readonly persistenceEngine!: PersistenceEngine<T>;
    public readonly compareEngine!: CompareEngine;
    public readonly manipulateEngine!: ManipulateEngine<T>;
    public readonly gettersEngine!: GettersEngine<T>;
    public readonly relationalEngine!: RelationalEngine;
    public readonly aggregationEngine!: AggregationEngine<T>;
    public readonly expressionEngine!: ExpressionEngine;
    public readonly queryEngine!: QueryEngine<T>;
    public readonly relationEngine!: RelationEngine<T>;
    public readonly primaryKeyProp!: string;
    public readonly sheetsQuery!: SheetsQuery<T>;
    public readonly relationalUpsertOrchestrator!: RelationalUpsertOrchestrator;
    public readonly hydrator!: SheetDocumentHydrator;
    public readonly cascadeDeleteOrchestrator!: CascadeDeleteOrchestrator;
    public readonly queryExecutionEngine!: QueryExecutionEngine;
    public readonly updateOrchestrator!: UpdateOrchestrator;
    public readonly createOrchestrator!: CreateOrchestrator;
    public readonly updatePartialOrchestrator!: UpdatePartialOrchestrator;
    public readonly deleteOrchestrator!: DeleteOrchestrator;
    public readonly findOrCreateOrchestrator!: FindOrCreateOrchestrator;
    public readonly metadataRegistry!: MetadataRegistry;
    public readonly projectionService!: ProjectionService<any>;
    public readonly mutationOrchestrator!: MutationOrchestrator;
    public readonly queryOrchestrator!: QueryOrchestrator;
    public Model: Model<T>; // <--- Añade esta línea

    constructor(private readonly config: RepositoryContextOptions<T>) {
        // Asignamos todo el objeto config directamente a 'this'
        // Esto mantiene la compatibilidad con tu código existente (ej: this.gateway funciona)
        Object.assign(this, config);
    }
}




