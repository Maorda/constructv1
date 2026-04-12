import { Injectable } from '@nestjs/common';
import { BaseSheetsRepository } from '@database';
import { AsistenciaEntity } from '../entities/asistencia.entity';


@Injectable()
export class AsistenciasRepository extends BaseSheetsRepository<AsistenciaEntity> {
    protected readonly EntityClass = AsistenciaEntity;
}