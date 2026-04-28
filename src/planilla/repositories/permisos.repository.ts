import { Injectable } from "@nestjs/common";
import { PermisoEntity } from "../entities/permiso.entity";

@Injectable()
export class PermisosRepository {
    protected readonly EntityClass = PermisoEntity;
}