import { Table, Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";

@Table('ASISTENCIAS_DIARIAS')
export class AsistenciaDiariaEntity {
    @PrimaryKey()
    @Column({ name: 'ID_ASISTENCIA', generated: 'uuid' })
    id: string;

    @Column({ name: 'ID_OBRERO', required: true })
    idObrero: string;

    @Column({ name: 'FECHA', type: 'date', required: true })
    fecha: string; // YYYY-MM-DD

    @Column({ name: 'INGRESO_MANANA', default: '' })
    ingresoManana: string; // Ej: "06:00" o "07:00"

    @Column({ name: 'SALIDA_MANANA', default: '' })
    salidaManana: string; // Ej: "13:00"

    @Column({ name: 'INGRESO_TARDE', default: '' })
    ingresoTarde: string; // Ej: "14:00"

    @Column({ name: 'SALIDA_TARDE', default: '' })
    salidaTarde: string; // Ej: "17:30"

    @Column({ name: 'ESTADO', default: 'ASISTIO' })
    estado: 'ASISTIO' | 'FALTA_JUSTIFICADA' | 'FALTA_INJUSTIFICADA' | 'PERMISO_JUSTIFICADO' | 'PERMISO_INJUSTIFICADO';
}