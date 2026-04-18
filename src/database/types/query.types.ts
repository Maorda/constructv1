// Tipos base para simular Mongoose
export type Projection<T> = { [P in keyof T]?: number | boolean };
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

export type EntityFilterQuery<T> = {
    [P in keyof T]?: T[P] | ComparisonOperators<T[P]>;
};
