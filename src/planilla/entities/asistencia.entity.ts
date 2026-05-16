import { Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";
import { Table } from "@database/decorators/table.decorator";
// ==========================================
// ENTIDAD HIJA: ASISTENCIA SEMANAL
// ==========================================
@Table() // Infiere automáticamente la hoja: "ASISTENCIASEMANALES"
export class AsistenciaEntity {
    @PrimaryKey()
    @Column({ name: 'ID_ASISTENCIA', generated: 'uuid' })
    idAsistencia: string;
    @Column({ name: 'DNI_OBRERO', required: true })
    obreroDni: string; // Actúa como nuestra Foreign Key
    @Column({ name: 'FECHA' }) fecha: Date;
    @Column({ name: 'INGRESO_M' }) ingresoM: string;
    @Column({ name: 'SALIDA_M' }) salidaM: string;
    @Column({ name: 'INGRESO_T' }) ingresoT: string;
    @Column({ name: 'SALIDA_T' }) salidaT: string;
    @Column({ name: 'HORAS_TRABAJADAS_DEL_DIA', type: 'number' }) horas_trabajadas_del_dia: number;
    @Column({ name: 'BONO_SABADO', type: 'number' }) bono_sabado: number; // El 0.50h
    @Column({ name: 'EXT_DEUDA', type: 'number' }) ext_deuda: number; // Lo que falta o sobra vs 8.5h
}