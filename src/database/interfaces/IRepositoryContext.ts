import { DatabaseModuleOptions } from "./database.options.interface";
import { IGettersEngine } from "./engine/IGettersEngine";
import { IManipulateEngine } from "./engine/IManipulateEngine";
import { IQueryEngine } from "./engine/IQueryEngine";
import { IRelationEngine } from "./engine/IRelationEngine";

export interface RepositoryContext {
    getters: IGettersEngine;
    manipulate: IManipulateEngine;
    query: IQueryEngine;
    relations: IRelationEngine;
    // Otros servicios globales
    readonly options: DatabaseModuleOptions;
}