import { Table, Column } from "@database";
import { PrimaryKey } from "@database/decorators/primarykey.decorator";
import { SubCollection } from "@database/decorators/relation.sub.collections.decorator";
import { AdelantoEntity } from "./AdelantoEntity";

@Table('OBREROS')
export class ObreroEntity {
    @PrimaryKey()
    @Column({ name: 'ID_OBRERO', generated: 'short-id' })
    id: string;

    @Column({ name: 'NOMBRE', required: true })
    nombre: string;

    @Column({ name: 'DNI', required: true })
    dni: string;

    @Column({ name: 'ID_CATEGORIA_ACTUAL', required: true })
    idCategoriaActual: string;

    // Arrastres financieros de la semana anterior (por falta de sencillo/monedas o sueldo adelantado)
    @Column({ name: 'SALDO_EFECTIVO_ARRANGED', type: 'number', default: 0 })
    saldoEfectivoArrastrado: number; // Positivo si se le debe dinero, Negativo si pidió adelanto de sueldo mayor a su semana

    // Arrastre de banco de horas extras de la semana anterior
    @Column({ name: 'SALDO_HORAS_EXTRA_ARRANGED', type: 'number', default: 0 })
    saldoHorasExtraArrastrado: number; // Negativo si debe horas (Dinámica de Deuda de Horas)

    @SubCollection(() => AdelantoEntity)
    adelantos: AdelantoEntity[];
}