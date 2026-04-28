import { Module } from '@nestjs/common';
import { LiquidacionController } from './controllers/liquidacion.controller';
import { LiquidacionService } from './services/liquidacion.service';
import { BalanceRepository } from './repositories/balance.repository';
import { AdelantosRepository } from './repositories/adelantos.repository';
import { AsistenciasRepository } from './repositories/asistencias.repository';
import { ObrerosRepository } from './repositories/obreros.repository';
import { DatabaseModule } from '@database/database.module';
import { PermisosRepository } from './repositories/permisos.repository';
import { AdelantoEntity } from './entities/adelanto.entity';
import { PermisoEntity } from './entities/permiso.entity';
import { AsistenciaEntity } from './entities/asistencia.entity';
import { BalanceEntity } from './entities/balance.entity';
import { ObreroEntity } from './entities/obrero.entity';


@Module({
  imports: [
    // ¡Igual que MongooseModule.forFeature!
    DatabaseModule.forFeature([AdelantoEntity, PermisoEntity, AsistenciaEntity, BalanceEntity, ObreroEntity]),

  ],
  controllers: [LiquidacionController],
  providers: [LiquidacionService, BalanceRepository, AdelantosRepository, AsistenciasRepository, ObrerosRepository],
})
export class PlanillaModule { }
