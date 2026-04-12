import { Column } from "@database";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class PermisoEntity {
    @Column({ name: 'DNI' }) dni: string;
    @Column({ name: 'FECHA' }) fecha: string;
    @Column({ name: 'HORAS_PERMISO', type: 'number' }) horas: number;
    @Column({ name: 'DIAS_PERMISO', type: 'number' }) dias: number;
    @Column({ name: 'MOTIVO' }) motivo: string;
}