// src/database/utils/naming-strategy.ts

export class NamingStrategy {
    static formatSheetName(className: string): string {
        // Quita "Entity" (ej: ObreroEntity -> Obrero)
        let name = className.replace(/(Entity|Repository)$/, '');

        // Convertir a minúsculas para procesar gramática
        name = name.toLowerCase();

        const lastChar = name.slice(-1);
        const vowels = ['a', 'e', 'i', 'o', 'u'];

        if (vowels.includes(lastChar)) {
            name = `${name}s`; // vocal + s
        } else if (lastChar === 'z') {
            name = `${name.slice(0, -1)}ces`; // z -> ces
        } else {
            name = `${name}es`; // consonante + es
        }

        return name.toUpperCase(); // Retorna "OBREROS", "BALANCES", etc.
    }
}