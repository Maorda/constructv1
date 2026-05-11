import { BaseServiceInterface } from "@database/interfaces/base.service.interface";
import { Projection } from "@database/types/query.types";
import { Injectable } from "@nestjs/common";

/**
 * ejemplo
 * const obra = await repo.findById('OBRA-01');

// Solo queremos el nombre y el presupuesto disponible (un virtual)
const vistaSimplificada = obra.select({
    nombre: true,
    presupuestoDisponible: true
});

console.log(vistaSimplificada); 
// Resultado: { id: 'OBRA-01', nombre: 'Pistas Huaraz', presupuestoDisponible: 50000 }
 */

@Injectable()
export class ProjectionService<T> implements BaseServiceInterface<T> {

    // Una versión mejorada que entiende rutas con puntos (.)
    // En tu ProjectionService mejorado
    applyProjection(data: any, projection: Projection): any {
        if (!projection || Object.keys(projection).length === 0) return data;

        let projectedData: any = {};
        const isInclusion = Object.values(projection).some(v => v === true || v === 1);

        if (isInclusion) {
            // Siempre incluimos el ID para mantener la identidad del documento
            if (data.id) projectedData.id = data.id;

            Object.keys(projection).forEach(path => {
                if (projection[path]) {
                    // Navegamos hasta el valor (Nivel 1, 2 o 3)
                    const value = this.getDeepValue(data, path);
                    if (value !== undefined) {
                        // Reconstruimos la estructura en el objeto de salida
                        this.setDeepValue(projectedData, path, value);
                    }
                }
            });
        } else {
            // Lógica de exclusión profunda (Clonar y eliminar rutas específicas)
            projectedData = JSON.parse(JSON.stringify(data)); // Clonación rápida
            Object.keys(projection).forEach(path => {
                if (projection[path] === false || projection[path] === 0) {
                    this.deleteDeepValue(projectedData, path);
                }
            });
        }

        return projectedData;
    }

    // 1. OBTENER VALOR: "cuadrilla.obra.nombre" -> data['cuadrilla']['obra']['nombre']
    private getDeepValue(obj: any, path: string): any {
        return path.split('.').reduce((acc, part) => acc && acc[part], obj);
    }

    // 2. SETEAR VALOR: Crea la estructura necesaria para asignar el valor
    private setDeepValue(obj: any, path: string, value: any): void {
        const parts = path.split('.');
        const last = parts.pop();
        const deepRef = parts.reduce((acc, part) => {
            if (!acc[part]) acc[part] = {};
            return acc[part];
        }, obj);
        if (last) deepRef[last] = value;
    }

    // 3. ELIMINAR VALOR (El que te faltaba): Borra la propiedad en la ruta profunda
    private deleteDeepValue(obj: any, path: string): void {
        const parts = path.split('.');
        const last = parts.pop();
        // Navegamos hasta el penúltimo nivel
        const deepRef = parts.reduce((acc, part) => acc && acc[part], obj);

        if (deepRef && last && last in deepRef) {
            delete deepRef[last];

            // Opcional: Limpiar objetos padres si quedaron vacíos
            if (Object.keys(deepRef).length === 0 && parts.length > 0) {
                this.deleteDeepValue(obj, parts.join('.'));
            }
        }
    }

    async executePopulate(data: any, path: string): Promise<any> {
        // Aquí irá la lógica para cargar relaciones dinámicamente
        // Ejemplo: si path es 'inspector', buscar en el repo de inspectores
        return data;
    }
}