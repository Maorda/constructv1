import 'reflect-metadata';
export const TABLE_NAME_KEY = 'sheets:table_name';
// Hacemos que el parámetro 'name' sea opcional
export function Table(name?: string): ClassDecorator {

    return (target: any) => {
        // Si name es undefined, guardamos null explícitamente para evitar "ruido"
        const finalName = name || target.name.replace(/(Entity|Model|Schema)$/, '');
        Reflect.defineMetadata(TABLE_NAME_KEY, finalName, target);
    };
}
