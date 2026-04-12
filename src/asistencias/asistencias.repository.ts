import { Injectable } from '@nestjs/common';
import { BaseSheetsRepository } from '@database';
import { AsistenciaEntity } from './asistencia.entity';


@Injectable()
export class AsistenciasRepository extends BaseSheetsRepository<AsistenciaEntity> {
    protected readonly EntityClass = AsistenciaEntity;
}