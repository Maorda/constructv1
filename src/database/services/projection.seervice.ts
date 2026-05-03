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

    applyProjection(data: any, projection: Projection): any {
        if (!projection || Object.keys(projection).length === 0) return data;

        const projectedData: any = {};
        const keys = Object.keys(projection);

        // Determinamos si es una proyección de inclusión o exclusión
        const isInclusion = Object.values(projection).some(v => v === true || v === 1);

        if (isInclusion) {
            // Solo copiamos lo que está marcado como true
            keys.forEach(key => {
                if (projection[key]) {
                    projectedData[key] = data[key];
                }
            });
            // Siempre incluimos el ID por defecto si no se especifica lo contrario
            if (data.id && projection.id !== false) projectedData.id = data.id;
        } else {
            // Copiamos todo EXCEPTO lo que está marcado como false
            Object.keys(data).forEach(key => {
                if (projection[key] === false || projection[key] === 0) return;
                projectedData[key] = data[key];
            });
        }

        return projectedData;
    }

    async executePopulate(data: any, path: string): Promise<any> {
        // Aquí irá la lógica para cargar relaciones dinámicamente
        // Ejemplo: si path es 'inspector', buscar en el repo de inspectores
        return data;
    }
}