import { Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class ObreroEntity {
    @PrimaryKey()
    @Column({ name: 'DNI' }) dni: string;
    @Column({ name: 'NOMBRES' }) nombres: string;
    @Column({ name: 'APELLIDOS' }) apellidos: string;
    @Column({ name: 'JORNAL_DIARIO', type: 'number' }) jornalDiario: number;
    @Column({ isDeleteControl: true })
    activo: boolean = true
}