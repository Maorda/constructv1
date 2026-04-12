import 'reflect-metadata';
export const TABLE_NAME_KEY = 'table:name';
// Hacemos que el parámetro 'name' sea opcional
export function Table(name?: string): ClassDecorator {
    return (target: Function) => {
        // 1. Si el usuario provee un nombre, usamos ese.
        // 2. Si no, tomamos el nombre de la clase y le quitamos "Entity" o "Model".
        const className = target.name;
        const autoName = className.replace(/(Entity|Model|Repository)$/, '');

        const tableName = name || autoName;

        Reflect.defineMetadata(TABLE_NAME_KEY, tableName, target);
    };
}