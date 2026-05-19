import { Table, Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";

@Table('CATEGORIAS')
export class CategoriaEntity {
    @PrimaryKey()
    @Column({ name: 'ID_CATEGORIA' })
    id: string; // MAESTRO, OPERARIO, OFICIAL, PEON

    @Column({ name: 'DESCRIPCION', required: true })
    descripcion: string;

    @Column({ name: 'COSTO_HORA_NORMAL', type: 'number', required: true })
    costoHoraNormal: number;

    @Column({ name: 'COSTO_HORA_EXTRA', type: 'number', required: true })
    costoHoraExtra: number;
}