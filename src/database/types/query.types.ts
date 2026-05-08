// Tipos base para simular Mongoose
// En tu archivo de tipos/interfaces
export type Projection<T = any> = {
    [P in keyof T]?: boolean | number;
} | Record<string, any>; // Permite strings arbitrarios si no hay T
// En tu archivo de interfaces o tipos
export type ClassType<T = any> = new (...args: any[]) => T;

// Un registro simple donde las llaves son campos de tu Entidad T
// FilterQuery: Permite filtrar por cualquier propiedad de la Entidad T

// UpdateQuery: Permite actualizar propiedades de T (excluyendo las que tú decidas)
export type UpdateQuery<T> = {
    [P in keyof T]?: T[P];
} & {
    $set?: Partial<T>;
    $inc?: Partial<Record<keyof T, number>>; // Para contadores
    $push?: Record<string, any>;
} | Partial<T>;

export type ComparisonOperators<T> = {
    $eq?: T;
    $gt?: T;
    $gte?: T;
    $lt?: T;
    $lte?: T;
    $in?: T[];
    $nin?: T[];
    $ne?: T;
    $exists?: boolean;
    $regex?: string;
};

// En tu archivo de tipos
export type FilterQuery<T = any> = {
    [P in keyof T]?: T[P] | ComparisonOperators<T[P]>;
} & Record<string, any>; // Permite filtrar por columnas dinámicas de Sheets