// src/database/utils/naming-strategy.ts

export class NamingStrategy {
    static formatSheetName(className: string): string {
        // 1. Limpieza inicial: Quita sufijos de arquitectura
        let name = className.replace(/(Entity|Repository|Service)$/, '');

        // 2. Insertar guion bajo antes de cada mayúscula (excepto la primera)
        // Ejemplo: DetallePlanilla -> Detalle_Planilla
        name = name.replace(/([a-z])([A-Z])/g, '$1_$2');

        // 3. Normalización a minúsculas para procesar pluralización
        name = name.toLowerCase().trim();

        // 4. Si ya termina en 's', solo convertimos a mayúsculas y salimos
        if (name.endsWith('s')) {
            return name.toUpperCase().replace(/\s+/g, '_');
        }

        const lastChar = name.slice(-1);
        const vowels = ['a', 'e', 'i', 'o', 'u', 'á', 'é', 'í', 'ó', 'ú'];

        // 5. Reglas gramaticales del español
        if (vowels.includes(lastChar)) {
            // Ejemplo: Obrero -> obreros
            name = `${name}s`;
        } else if (lastChar === 'z') {
            // Ejemplo: Capataz -> capataces
            name = `${name.slice(0, -1)}ces`;
        } else if (['r', 'l', 'd', 'j', 'n'].includes(lastChar)) {
            // Ejemplo: Trabajador -> trabajadores, Material -> materiales
            name = `${name}es`;
        } else {
            // Caso general
            name = `${name}s`;
        }

        // 6. Retorno en MAYÚSCULAS y limpieza final de espacios
        // Usamos "_" para asegurar compatibilidad total con nombres de rangos en Google
        return name.toUpperCase().replace(/[-\s]+/g, '_').substring(0, 100);
    }
}