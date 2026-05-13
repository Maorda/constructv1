import 'reflect-metadata';
export const TABLE_NAME_KEY = 'sheets:table_name';

export function Table(name?: string): ClassDecorator {
    return (target: any) => {
        let finalName: string;

        if (name) {
            // Si el usuario pone @Table('mis_obreros'), lo respetamos pero en MAYÚSCULAS
            finalName = name.toUpperCase();
        } else {
            // Si el usuario pone @Table(), aplicamos la lógica automática
            // 1. Limpiar sufijos (ObreroEntity -> Obrero)
            let baseName = target.name.replace(/(Entity|Model|Schema)$/i, '');

            // 2. Pluralización básica
            if (['a', 'e', 'i', 'o', 'u'].includes(baseName.slice(-1).toLowerCase())) {
                finalName = `${baseName}S`.toUpperCase();
            } else {
                finalName = `${baseName}ES`.toUpperCase();
            }
        }

        Reflect.defineMetadata(TABLE_NAME_KEY, finalName, target);
    };
}