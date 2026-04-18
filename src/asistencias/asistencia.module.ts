import { Module } from '@nestjs/common';
import { AsistenciasService } from './services/asistencias.service';
import { AsistenciasRepository } from './repository/asistencias.repository';
import { AsistenciaController } from './asistencia.controller';

@Module({
    providers: [AsistenciasService, AsistenciasRepository],
    exports: [AsistenciasService],
    controllers: [AsistenciaController],
})
export class AsistenciaModule { }
