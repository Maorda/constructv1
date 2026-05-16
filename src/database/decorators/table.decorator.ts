import 'reflect-metadata';


import { SHEETS_TABLE_NAME } from '../constants/metadata.constants';

export function Table(name?: string): ClassDecorator {
    return (target: any) => {
        let finalName: string;

        if (name) {
            finalName = name.toUpperCase();
        } else {
            // Lógica predictiva limpia: ObreroEntity -> OBREROS
            let baseName = target.name.replace(/(Entity|Model|Schema)$/i, '');
            const lastChar = baseName.slice(-1).toLowerCase();

            if (['a', 'e', 'i', 'o', 'u'].includes(lastChar)) {
                finalName = `${baseName}S`.toUpperCase();
            } else if (lastChar === 'z') {
                finalName = `${baseName.slice(0, -1)}CES`.toUpperCase(); // Capataz -> CAPATACES
            } else {
                finalName = `${baseName}ES`.toUpperCase();
            }
        }

        // Definimos la metadata en la clase constructora
        Reflect.defineMetadata(SHEETS_TABLE_NAME, finalName, target);
    };
}