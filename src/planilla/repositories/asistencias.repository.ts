import { BaseSheetsRepository } from "@database";
import { Injectable } from "@nestjs/common";
import { AsistenciaEntity } from "../entities/asistencia.entity";


@Injectable()
export class AsistenciasRepository extends BaseSheetsRepository<AsistenciaEntity> {
    protected readonly EntityClass = AsistenciaEntity;
}