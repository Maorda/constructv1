import { Column } from "@database";
import { Table } from "@database/decorators/table.decorator";

@Table()
export class BalanceEntity {
    @Column({ name: 'DNI' }) dni: string;
    @Column({ name: 'FECHA_CORTE' }) fechaCorte: string;
    @Column({ name: 'SALDO_HORAS_ANTERIOR', type: 'number' }) saldoAnterior: number;
    @Column({ name: 'HORAS_EXTRAS_SEMANA', type: 'number' }) horasExtrasSemana: number;
    @Column({ name: 'HORAS_CANJEADAS', type: 'number' }) horasCanjeadas: number;
    @Column({ name: 'SALDO_NETO_PENDIENTE', type: 'number' }) saldoNeto: number;
}