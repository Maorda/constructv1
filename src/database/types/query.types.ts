// Tipos base para simular Mongoose
// En tu archivo de tipos/interfaces
export type Projection<T = any> = {
    [P in keyof T]?: boolean | number;
} | Record<string, any>; // Permite strings arbitrarios si no hay T
// En tu archivo de interfaces o tipos
export type ClassType<T = any> = new (...args: any[]) => T;

// Un registro simple donde las llaves son campos de tu Entidad T
export type UpdateQuery<T> = { $set?: Partial<T>; $push?: Record<string, any> } | Partial<T>;
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
export type EntityFilterQuery<T = any> = {
    [P in keyof T]?: T[P] | ComparisonOperators<T[P]>;
} & Record<string, any>; // Permite filtrar por columnas dinámicas de Sheets