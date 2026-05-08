export function normalizeForMath(val: any): any {
    if (val instanceof Date) return val;
    if (val === null || val === undefined) return 0;

    // Si es un número o string numérico, forzamos Number
    const clean = typeof val === 'string' ? val.trim() : val;
    if (clean !== '' && !isNaN(Number(clean)) && typeof clean !== 'boolean') {
        return Number(clean);
    }
    return clean;
}
export const asDate = <T extends object>(p: any, record: T) => {
    const v = getValue(p, record); return v instanceof Date ? v : new Date(v);
};
export const getValue = <T extends object>(p: any, record: T) => record[p as keyof T] !== undefined ? record[p as keyof T] : p;

/**
 * Convierte un índice de columna (0-based) a letras (A, B, C... Z, AA, AB...).
 * @example 0 -> A, 25 -> Z, 26 -> AA
*/
export const getColumnLetter = (index: number): string => {
    let letter = '';
    while (index >= 0) {
        // 65 es el código ASCII para 'A'
        letter = String.fromCharCode((index % 26) + 65) + letter;
        index = Math.floor(index / 26) - 1;
    }
    return letter;
}

/**
 * Ejecuta una función asíncrona con lógica de reintento y backoff exponencial.
 * @param fn Función a ejecutar
 * @param retries Número máximo de reintentos (defecto 3)
 * @param delay Tiempo de espera inicial en ms (defecto 1000ms)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries = 3,
    delay = 1000
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        // Solo reintentamos si es un error de red o de cuota (500, 503, 429)
        // No reintentamos si es un error de usuario (400, 404)
        const status = error?.status || error?.response?.status;
        const isTransientError = !status || status === 429 || status >= 500;

        if (retries <= 0 || !isTransientError) {
            throw error;
        }

        console.warn(`[Retry] Error detectado. Reintentando en ${delay}ms... (Quedan ${retries} intentos)`);

        await new Promise(resolve => setTimeout(resolve, delay));

        // Llamada recursiva aumentando el delay (Backoff exponencial)
        return withRetry(fn, retries - 1, delay * 2);
    }
}