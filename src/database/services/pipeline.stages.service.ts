export interface LookupConfig {
    from: string;          // Nombre de la hoja/entidad destino
    localField: string;    // Campo en la hoja actual
    foreignField: string;  // Campo en la hoja destino
    as: string;            // Nombre del campo resultante
}
export type PipelineStage =
    | { $match: Record<string, any> }
    | { $lookup: LookupConfig }
    | { $unwind: string | { path: string; preserveNullAndEmptyArrays?: boolean } }
    | { $project: Record<string, any> }
    | { $addFields: Record<string, any> }
    | { $group: GroupConfig }
    | { $sort: Record<string, 1 | -1> }
    | { $limit: number }
    | { $skip: number };

/**
 * Configuración para la etapa de agrupación.
 */
export interface GroupConfig {
    /** Campo por el cual agrupar. Debe empezar con "$" (ej: "$id_obra") o ser null para agrupar todo */
    _id: string | null;

    /** Campos acumuladores dinámicos */
    [key: string]: GroupAccumulator | string | null;
}
/**
 * Configuración para la etapa de cruce de hojas (Join).
 */
export interface LookupConfig {
    /** Nombre de la entidad/hoja destino (ej: 'Peon') */
    from: string;

    /** Campo en la entidad actual que sirve de llave (ej: 'especialistaId') */
    localField: string;

    /** Campo en la entidad destino que coincide con localField (ej: 'id') */
    foreignField: string;

    /** Nombre del nuevo campo donde se guardará el resultado (normalmente un arreglo) */
    as: string;
}

/**
 * Operadores permitidos dentro de una etapa $group.
 */
export interface GroupAccumulator {
    $sum?: string | number | any;   // Puede ser "$campo" o una expresión recursiva
    $avg?: string | any;
    $min?: string | any;
    $max?: string | any;
    $count?: Record<string, never>; // Objeto vacío {}
    $push?: string | any;
}

