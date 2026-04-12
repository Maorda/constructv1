import { BaseSheetsRepository } from "@database";
import { Injectable } from "@nestjs/common";
import { ObreroEntity } from "../entities/obrero.entity";

@Injectable()
export class ObrerosRepository extends BaseSheetsRepository<ObreroEntity> {
    protected readonly EntityClass = ObreroEntity;
}