// 1. Definimos un tipo para cualquier clase de entidad
type ClassType = new () => any;

// 2. Todos los engines heredan de aquí
export abstract class BaseEngine {
    constructor(protected readonly EntityClass: ClassType) { }
}
