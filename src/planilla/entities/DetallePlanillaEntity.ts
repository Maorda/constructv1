import { Table, Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";

@Table('DETALLES_PLANILLA')
export class DetallePlanillaEntity {
    @PrimaryKey()
    @Column({ name: 'ID_DETALLE', generated: 'uuid' })
    id: string;

    @Column({ name: 'ID_OBRERO', required: true })
    idObrero: string;

    // 1. ACUMULADORES FÍSICOS (Soportados por el findOneAndUpdate con $inc o $set)
    @Column({ name: 'HORAS_JORNADA_COMPLETA_ACUM', type: 'number', default: 0 })
    horasJornadaCompletaAcumuladas: number; // Solo suma si el día llegó a las 8.5 horas exactas o más

    @Column({ name: 'HORAS_EXTRAS_PURA_ACUM', type: 'number', default: 0 })
    horasExtrasPuraAcumuladas: number; // Excedentes diarios y horas del sábado/madrugada

    @Column({ name: 'HORAS_INCOMPLETAS_A_BOLSA', type: 'number', default: 0 })
    horasIncompletasABolsa: number; // 💡 REGLA 5: Si trabajó 7.5h (menos de 8.5h), se almacena aquí.

    @Column({ name: 'MINUTOS_TARDANZA_TOTAL', type: 'number', default: 0 })
    minutosTardanzaTotal: number;

    @Column({ name: 'CONTADOR_FALTAS_PERMISOS', type: 'number', default: 0 })
    contadorAusencias: number; // Sumatoria de faltas o permisos que rompen la cuota del sábado

    // 2. SNAPSHOTS INMUTABLES DE LA SEMANA
    @Column({ name: 'SNAPSHOT_COSTO_HN', type: 'number', required: true })
    costoHN: number;

    @Column({ name: 'SNAPSHOT_COSTO_HE', type: 'number', required: true })
    costoHE: number;

    // 3. ARRASTRES TRAÍDOS DEL MODELO DEL OBRERO AL INICIAR LA SEMANA
    @Column({ name: 'ARR_EFECTIVO_ANTERIOR', type: 'number', default: 0 })
    arrastreEfectivoAnterior: number;

    @Column({ name: 'ARR_HORAS_EXTRA_ANTERIOR', type: 'number', default: 0 })
    arrastreHorasExtraAnterior: number;

    // 4. TOTAL TRANSACCIONAL DE ADELANTOS DE LA SEMANA (Setteado por tubería/agregación)
    @Column({ name: 'TOTAL_ADELANTOS_SEMANA', type: 'number', default: 0 })
    totalAdelantosSemana: number;

    // 5. EFECTIVO REALMENTE ENTREGADO EN MESA (Falta de sencillo)
    @Column({ name: 'EFECTIVO_PAGADO_EN_MANO', type: 'number', default: 0 })
    efectivoPagadoEnMano: number;

    // Dentro de DETALLES_PLANILLA
    @Column({ name: 'CODIGO_SEMANA', required: true })
    idPlanilla: string; // ✨ Ahora seguirá tu estándar: "18_AL_23_05_DEL_26"

    @Column({ name: 'MES_CALENDARIO', required: true })
    mesCalendario: string; // ✨ Nuevo campo de agrupación automática: "2026-05"


    // =========================================================================
    // ✨ VIRTUAL GETTERS: Lógica Pura en Memoria (Estilo Bolsa de Horas y Saldos)
    // =========================================================================

    /**
     * 💡 Bolsa de Horas Extras Consolidada (Regla 5 y Regla 8)
     * Une las extras de la semana + las horas de días incompletos + el arrastre anterior
     */
    get bolsaTotalHorasExtras(): number {
        return Number(
            (this.horasExtrasPuraAcumuladas + this.horasIncompletasABolsa + this.arrastreHorasExtraAnterior).toFixed(2)
        );
    }

    /**
     * Descuento monetario por tardanzas (Mapeado a valor de Hora Normal)
     */
    get descuentoPorTardanzas(): number {
        const horasTardanza = this.minutosTardanzaTotal / 60;
        return Number((horasTardanza * this.costoHN).toFixed(2));
    }

    /**
     * Cálculo de Ingresos Brutos por la Jornada Completa Normada
     */
    get montoJornadaNormal(): number {
        return Number((this.horasJornadaCompletaAcumuladas * this.costoHN).toFixed(2));
    }

    /**
     * Cálculo de Ingresos Brutos por la Bolsa de Horas Extras
     */
    get montoHorasExtrasBolsa(): number {
        // Si el saldo de la bolsa es positivo, se liquida económicamente
        if (this.bolsaTotalHorasExtras > 0) {
            return Number((this.bolsaTotalHorasExtras * this.costoHE).toFixed(2));
        }
        return 0; // Si es negativo, es una deuda de horas que pasa a la otra semana
    }

    /**
     * Líquido Neto Teórico que le corresponde ganar al Obrero en la semana
     */
    get salarioNetoCalculado(): number {
        const ingresos = this.montoJornadaNormal + this.montoHorasExtrasBolsa + this.arrastreEfectivoAnterior;
        const egresos = this.descuentoPorTardanzas + this.totalAdelantosSemana;
        const neto = ingresos - egresos;
        return neto > 0 ? Number(neto.toFixed(2)) : neto;
    }

    /**
     * 💡 REGLA 6 y 7: Saldo Financiero Remanente que se va a heredar a la próxima semana
     * Si no hubo sencillo de baja denominación o si el obrero pidió saldo adelantado.
     */
    get saldoEfectivoPendienteProximaSemana(): number {
        // Lo que debió ganar menos lo que efectivamente se le pudo pagar físicamente en la mesa de la obra
        return Number((this.salarioNetoCalculado - this.efectivoPagadoEnMano).toFixed(2));
    }

    /**
     * 💡 REGLA 8: Deuda de Horas que pasa a la siguiente semana
     * Si la bolsa consolidada quedó en negativo, se arrastra como deuda de tiempo.
     */
    get deudaHorasProximaSemana(): number {
        return this.bolsaTotalHorasExtras < 0 ? Number(this.bolsaTotalHorasExtras.toFixed(2)) : 0;
    }
}