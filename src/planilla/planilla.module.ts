import { Module } from '@nestjs/common';
import { DatabaseModule } from '@database/database.module';
import { CategoriaEntity } from './entities/CategoriaEntity';
import { DetallePlanillaEntity } from './entities/DetallePlanillaEntity';
import { ObreroEntity } from './entities/ObreroEntity';
import { PlanillaAdminController } from './controllers/PlanillaAdminController';
import { TareoRelojController } from './controllers/TareoRelojController';
import { PlanillaTareoService } from './services/PlanillaTareoService';
import { AsistenciaDiariaEntity } from './entities/AsistenciaDiariaEntity';
import { AdelantoEntity } from './entities/AdelantoEntity';

@Module({
  imports: [
    // ¡Igual que MongooseModule.forFeature!
    DatabaseModule.forFeature([
      ObreroEntity,
      AsistenciaDiariaEntity,
      DetallePlanillaEntity,
      CategoriaEntity,
      AdelantoEntity]),

  ],
  controllers: [PlanillaAdminController, TareoRelojController],
  providers: [PlanillaTareoService],
  exports: [PlanillaTareoService],
})
export class PlanillaModule { }
