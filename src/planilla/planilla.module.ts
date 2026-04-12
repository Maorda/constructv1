import { Module } from '@nestjs/common';
import { LiquidacionController } from './controllers/liquidacion.controller';
import { LiquidacionService } from './services/liquidacion.service';
import { BalanceRepository } from './repositories/balance.repository';
import { AdelantosRepository } from './repositories/adelantos.repository';
import { AsistenciasRepository } from './repositories/asistencias.repository';
import { ObrerosRepository } from './repositories/obreros.repository';

@Module({
  controllers: [LiquidacionController],
  providers: [LiquidacionService, BalanceRepository, AdelantosRepository, AsistenciasRepository, ObrerosRepository],
})
export class PlanillaModule { }
