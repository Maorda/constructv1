import { Column } from "@database";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class AsistenciaEntity {
    @Column({ name: 'DNI' }) dni: string;
    @Column({ name: 'FECHA' }) fecha: string;
    @Column({ name: 'INGRESO_M' }) ingresoM: string;
    @Column({ name: 'SALIDA_M' }) salidaM: string;
    @Column({ name: 'INGRESO_T' }) ingresoT: string;
    @Column({ name: 'SALIDA_T' }) salidaT: string;
    @Column({ name: 'HORAS_TRABAJADAS', type: 'number' }) horasTrabajadas: number;
    @Column({ name: 'BONO_SABADO', type: 'number' }) bonoSabado: number; // El 0.50h
    @Column({ name: 'EXT_DEUDA', type: 'number' }) extDeuda: number; // Lo que falta o sobra vs 8.5h
}