import { RepositoryContext } from "@database/repositories/repository.context";

// 1. Definimos un tipo para cualquier clase de entidad
type ClassType = new () => any;

// 2. Todos los engines heredan de aquí
export abstract class BaseEngine {
    constructor(protected readonly ctx: RepositoryContext) { }
}
