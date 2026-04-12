import { Column } from "@database";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class AdelantoEntity {
    @Column({ name: 'DNI' }) dni: string;
    @Column({ name: 'FECHA' }) fecha: string;
    @Column({ name: 'MONTO', type: 'number' }) monto: number;
    @Column({ name: 'MOTIVO' }) motivo: string;
}