import { Injectable, NotFoundException } from '@nestjs/common';
import { AsistenciasRepository } from '../repository/asistencias.repository';
import { AsistenciaEntity } from '../entities/asistencia.entity';
import dayjs from 'dayjs';
import { BaseCrudService } from '@database/adapters/crud.service';

@Injectable()
export class AsistenciasService extends BaseCrudService<AsistenciaEntity> {
    // Constantes de Ley y Acuerdo
    private readonly JORNADA_LEY = 8;
    private readonly AHORRO_SABADO = 0.5; // Los 30 min diarios
    private readonly META_DIARIA = 8.5;   // 8h + 30min

    constructor(repository: AsistenciasRepository, private readonly repo: AsistenciasRepository) {
        super(repository)
    }

    /**
     * Procesa el marcado de salida y calcula cuánto tiempo se va al "banco" del sábado.
     */
    async procesarSalidaFinal(dni: string, horaSalida: string): Promise<AsistenciaEntity> {
        // 1. Buscamos el registro previo del día (ingreso)
        const registro = await this.repo.findOneByColumn('DNI', dni);
        if (!registro) throw new NotFoundException('No se encontró el registro de hoy');
        // 2. Calculamos el tiempo total trabajado en el día
        const horasTotales = this.calcularHorasEfectivas(registro, horaSalida);

        let ahorroAcumulado = 0;
        let horasExtrasReales = 0;
        // 3. Lógica de Distribución (Ley vs Ahorro vs Extra)
        if (horasTotales >= this.META_DIARIA) {
            // Caso 1: Cumplió la meta (ej: 10.5 horas trabajadas)
            ahorroAcumulado = this.AHORRO_SABADO; // Se guarda su media hora para el sábado
            horasExtrasReales = horasTotales - this.META_DIARIA; // El resto (2h) es extra pura
        } else if (horasTotales > this.JORNADA_LEY) {
            // Caso 2: Trabajó algo más de 8h pero menos de 8.5h
            ahorroAcumulado = horasTotales - this.JORNADA_LEY; // Solo ahorra lo que excedió de 8
            horasExtrasReales = 0;
        }

        // CORRECCIÓN: Ahora pasamos los 3 parámetros requeridos
        return await this.repo.updateRow('DNI', dni, {
            salidaTarde: horaSalida,
            horasAcumuladasSabado: ahorroAcumulado,
            horasExtras: horasExtrasReales,
            isJornadaCumplida: horasTotales >= this.META_DIARIA
        });
    }

    /**
     * Calcula el saldo total acumulado en la semana para un empleado.
     */
    async consultarSaldoSemanal(dni: string): Promise<number> {
        const todas = await this.repo.findAll();
        // Filtramos por DNI y podrías filtrar por rango de fechas de la semana actual
        const asistenciasSemana = todas.filter(a => a.dni === dni);

        return asistenciasSemana.reduce((total, a) => total + (a.horasAcumuladasSabado || 0), 0);
    }

    /**
     * Realiza el canje de horas (usado típicamente los Sábados).
     * @param horasACanjear Cantidad de horas que el trabajador usará para salir temprano.
     */
    async canjearHorasSabado(dni: string, horasACanjear: number) {
        const saldoDisponible = await this.consultarSaldoSemanal(dni);

        if (horasACanjear > saldoDisponible) {
            throw new Error(`Saldo insuficiente. Disponible: ${saldoDisponible}h, Solicitado: ${horasACanjear}h`);
        }

        // Para el registro contable en Sheets, creamos o actualizamos el registro del sábado
        // restando el saldo o marcando el uso de las horas.
        return await this.repo.updateRow('DNI', dni, {
            motivo: `Canje de ${horasACanjear}h para salida temprana`,
            // Aquí podrías restar del registro actual o manejar una columna de 'Horas Canjeadas'
        });
    }

    private calcularHorasEfectivas(reg: AsistenciaEntity, salidaT: string): number {
        const fecha = dayjs().format('YYYY-MM-DD');

        const inicioM = dayjs(`${fecha} ${reg.ingresoManana}`);
        const finM = dayjs(`${fecha} ${reg.salidaManana}`);
        const inicioT = dayjs(`${fecha} ${reg.ingresoTarde}`);
        const finT = dayjs(`${fecha} ${salidaT}`);

        const minutosTrabajados = finM.diff(inicioM, 'minute') + finT.diff(inicioT, 'minute');

        return minutosTrabajados / 60;
    }

}