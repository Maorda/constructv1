import { Injectable, NotFoundException } from '@nestjs/common';
import { AdelantosRepository } from '../repositories/adelantos.repository';
import { AsistenciasRepository } from '../repositories/asistencias.repository';
import { BalanceRepository } from '../repositories/balance.repository';
import { ObrerosRepository } from '../repositories/obreros.repository';

@Injectable()
export class LiquidacionService {
    private readonly META_DIARIA = 8.5;
    private readonly HORAS_SEMANALES_LEY = 48;

    constructor(
        private readonly obrerosRepo: ObrerosRepository,
        private readonly asistenciasRepo: AsistenciasRepository,
        private readonly adelantosRepo: AdelantosRepository,
        private readonly balanceRepo: BalanceRepository,
    ) { }

    async procesarCierreSemanal(dni: string, fechaLunes: string, fechaSabado: string) {
        // 1. Obtener datos del Obrero y su saldo anterior
        const obrero = await this.obrerosRepo.findOneByColumn('DNI', dni);
        if (!obrero) throw new NotFoundException('Obrero no encontrado');

        const ultimoBalance = await this.balanceRepo.findUltimoSaldo(dni);
        const saldoAnterior = ultimoBalance?.saldoNeto || 0;

        // 2. Obtener Asistencias y Adelantos del rango de fechas
        const asistencias = await this.asistenciasRepo.findRange(dni, fechaLunes, fechaSabado);
        const adelantos = await this.adelantosRepo.findRange(dni, fechaLunes, fechaSabado);

        // 3. Cálculos de Horas (Siguiendo tu Excel)
        const totalHorasTrabajadas = asistencias.reduce((acc, curr) => acc + curr.horasTrabajadas, 0);
        const totalAdelantos = adelantos.reduce((acc, curr) => acc + curr.monto, 0);

        // Balance de la semana actual vs la Ley (48h)
        const balanceSemanal = totalHorasTrabajadas - this.HORAS_SEMANALES_LEY;

        // Saldo Neto Acumulado (Lo que el trabajador tiene a favor o en contra)
        const saldoNetoActual = balanceSemanal + saldoAnterior;

        // 4. Cálculo Económico
        const montoHorasExtras = saldoNetoActual > 0 ? saldoNetoActual * (obrero.jornalDiario / 8) : 0;
        const pagoSueldoBase = obrero.jornalDiario * 6; // Pago por los 6 días si cumplió su tiempo
        const pagoTotalFinal = pagoSueldoBase + montoHorasExtras - totalAdelantos;

        return {
            dni,
            nombreCompleto: `${obrero.nombres} ${obrero.apellidos}`,
            detalleHoras: {
                trabajadas: totalHorasTrabajadas,
                balanceSemanal: balanceSemanal,
                saldoAnterior: saldoAnterior,
                saldoNetoActual: saldoNetoActual,
            },
            economico: {
                jornalDiario: obrero.jornalDiario,
                totalAdelantos,
                pagoFinal: pagoTotalFinal,
            }
        };
    }
    async registrarCanje(dni: string, horasACanjear: number) {
        const ultimo = await this.balanceRepo.findUltimoSaldo(dni);

        if (!ultimo || ultimo.saldoNeto < horasACanjear) {
            throw new Error('Saldo insuficiente para canje');
        }

        return await this.balanceRepo.create({
            dni,
            fechaCorte: new Date().toISOString().split('T')[0],
            saldoAnterior: ultimo.saldoNeto,
            horasExtrasSemana: 0,
            horasCanjeadas: horasACanjear,
            saldoNeto: ultimo.saldoNeto - horasACanjear // Actualizamos el acarreo
        });
    }
}