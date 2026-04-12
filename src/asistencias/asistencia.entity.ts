import { Column } from '@database';

export class AsistenciaEntity {
    @Column({ name: 'DNI', required: true })
    dni: string;

    @Column({ name: 'FECHA', type: 'date' })
    fecha: Date;

    @Column({ name: 'INGRESO_MANANA' }) // Guardamos como string "HH:mm"
    ingresoManana: string;

    @Column({ name: 'SALIDA_MANANA' })
    salidaManana: string;

    @Column({ name: 'INGRESO_TARDE' })
    ingresoTarde: string;

    @Column({ name: 'SALIDA_TARDE' })
    salidaTarde: string;

    @Column({ name: 'HORAS_EXTRA_SABADO', type: 'number', default: 0 })
    horasAcumuladasSabado: number;

    @Column({ name: 'CUMPLIO_META', type: 'boolean', default: false })
    isJornadaCumplida: boolean;

    @Column({ name: 'MOTIVO' })
    motivo: string;

    @Column({ name: 'HORAS_EXTRAS', type: 'number', default: 0 })
    horasExtras: number;
}