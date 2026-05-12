import { Module } from '@nestjs/common';
import { LiquidacionController } from './controllers/liquidacion.controller';
import { LiquidacionService } from './services/liquidacion.service';
import { DatabaseModule } from '@database/database.module';
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
  providers: [LiquidacionService,],
})
export class PlanillaModule { }
