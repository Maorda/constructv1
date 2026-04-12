// src/database/repositories/balance.repository.ts
import { Injectable } from '@nestjs/common';
import { BalanceEntity } from '../entities/balance.entity';
import { BaseSheetsRepository } from '@database';

@Injectable()
export class BalanceRepository extends BaseSheetsRepository<BalanceEntity> {
    protected readonly EntityClass = BalanceEntity;

    /**
     * Obtiene el último registro de balance para un obrero específico
     * para conocer su saldo de horas actual (acarreo).
     */
    async findUltimoSaldo(dni: string): Promise<BalanceEntity | null> {
        // 1. Obtenemos todos los registros de la pestaña 'Balance'
        const todosLosSaldos = await this.findAll();

        // 2. Filtramos por DNI y revertimos el orden para obtener el último primero
        const registrosObrero = todosLosSaldos
            .filter(registro => registro.dni === dni)
            .reverse();

        // 3. Retornamos el primero (que es el último cronológicamente) o null si no hay
        return registrosObrero.length > 0 ? registrosObrero[0] : null;
    }
}