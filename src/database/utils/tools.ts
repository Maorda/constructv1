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