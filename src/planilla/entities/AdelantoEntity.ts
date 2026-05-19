import { Table, Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";

@Table('ADELANTOS_DIARIOS')
export class AdelantoEntity {
    @PrimaryKey()
    @Column({ name: 'ID_ADELANTO', generated: 'uuid' })
    id: string;

    @Column({ name: 'ID_PLANILLA', required: true })
    idPlanilla: string;

    @Column({ name: 'ID_OBRERO', required: true })
    idObrero: string;

    @Column({ name: 'FECHA', type: 'date', required: true })
    fecha: string;

    @Column({ name: 'MONTO', type: 'number', required: true })
    monto: number;

    @Column({ name: 'MOTIVO', type: 'string', default: 'Adelanto regular' })
    motivo: string;
}