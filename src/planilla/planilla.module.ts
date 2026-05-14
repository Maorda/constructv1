import { Module } from '@nestjs/common';
import { ObrerosController } from './controllers/liquidacion.controller';
import { DatabaseModule } from '@database/database.module';
import { AdelantoEntity } from './entities/adelanto.entity';
import { PermisoEntity } from './entities/permiso.entity';
import { AsistenciaEntity } from './entities/asistencia.entity';
import { BalanceEntity } from './entities/balance.entity';
import { ObreroEntity } from './entities/obrero.entity';
import { ObrerosService } from './services/planilla.service';


@Module({
  imports: [
    // ¡Igual que MongooseModule.forFeature!
    DatabaseModule.forFeature([AdelantoEntity, PermisoEntity, AsistenciaEntity, BalanceEntity, ObreroEntity]),

  ],
  controllers: [ObrerosController],
  providers: [ObrerosService],
})
export class PlanillaModule { }
