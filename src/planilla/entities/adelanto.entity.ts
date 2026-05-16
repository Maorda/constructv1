import { Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class AdelantoEntity {
    @PrimaryKey()
    @Column({ name: 'DNI', generated: 'short-id' }) dni: string = "";
    @Column({ name: 'FECHA' }) fecha: string = "";
    @Column({ name: 'MONTO', type: 'number' }) monto: number = 0;
    @Column({ name: 'MOTIVO' }) motivo: string = "";
}