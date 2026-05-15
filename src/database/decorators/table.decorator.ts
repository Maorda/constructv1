import 'reflect-metadata';


import { SHEETS_TABLE_NAME } from '../constants/metadata.constants';

export function Table(name?: string): ClassDecorator {
    return (target: any) => {
        let finalName: string;

        if (name) {
            // Respetamos el nombre manual pero normalizamos a MAYÚSCULAS
            finalName = name.toUpperCase();
        } else {
            // Lógica automática: ObreroEntity -> OBREROS

            // 1. Limpiar sufijos comunes
            let baseName = target.name.replace(/(Entity|Model|Schema)$/i, '');

            // 2. Pluralización básica en español
            const lastChar = baseName.slice(-1).toLowerCase();
            if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
                finalName = `${baseName}S`.toUpperCase();
            } else {
                finalName = `${baseName}ES`.toUpperCase();
            }
        }

        // Guardamos el nombre de la tabla en los metadatos de la clase
        Reflect.defineMetadata(SHEETS_TABLE_NAME, finalName, target);
    };
}