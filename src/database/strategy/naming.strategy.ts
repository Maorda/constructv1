// src/database/utils/naming-strategy.ts

export class NamingStrategy {
    /**
     * Transforma "ObreroEntity" en "OBREROS"
     */
    static formatSheetName(className: string): string {
        // 1. Limpieza de sufijos
        let name = className.replace(/(Entity|Model|Repository|Service)$/, '');

        // 2. Lógica de Pluralización (Español)
        const lastChar = name.slice(-1).toLowerCase();
        const vowels = ['a', 'e', 'i', 'o', 'u'];

        if (vowels.includes(lastChar)) {
            name = `${name}s`; // Obrero -> Obreros
        } else {
            // Para palabras que terminan en consonante (ej. Red -> Redes)
            name = `${name}es`;
        }

        return name.trim().toUpperCase();
    }

    /**
     * Normalización para comparación de cabeceras
     */
    static normalize(text: any): string {
        return String(text || '').trim().toUpperCase();
    }
}