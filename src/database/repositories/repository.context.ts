import { Cache } from 'cache-manager';
// Ajusta ruta
import { PersistenceEngine } from '../engine/persistence.engine'; // Ajusta ruta
import { SheetsDataGateway } from '../services/sheetDataGateway';
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
export class RepositoryContext {
    constructor(
        public readonly gateway: SheetsDataGateway,//Proveer la conexión física a Google Sheets.
        @Inject('DATABASE_OPTIONS') public readonly options: DatabaseModuleOptions,
        public readonly persistenceEngine: PersistenceEngine,//Encargado de la escritura (Save, Update, Delete).
        public readonly compareEngine: CompareEngine,//Realiza las comparaciones (>, <, ==).
        public readonly manipulateEngine: ManipulateEngine,//Realiza operaciones matemáticas y transformaciones.
        public readonly gettersEngine: GettersEngine,//Encargado de la lectura y gestión de caché.
        public readonly relationalEngine: RelationalEngine,
        public readonly aggregationEngine: AggregationEngine,
        public readonly expressionEngine: ExpressionEngine,
        public readonly queryEngine: QueryEngine,//Procesa la lógica de filtrado y ordenamiento.
        public readonly mapper: SheetMapper,//Traducir entre filas de Excel y objetos TypeScript.
        private readonly logger: Logger,


    ) { }
}




