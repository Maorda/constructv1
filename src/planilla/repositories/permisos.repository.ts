import { BaseSheetsRepository } from "@database";
import { Injectable } from "@nestjs/common";
import { PermisoEntity } from "../entities/permiso.entity";

@Injectable()
export class PermisosRepository extends BaseSheetsRepository<PermisoEntity> {
    protected readonly EntityClass = PermisoEntity;
}