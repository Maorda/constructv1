import { BaseSheetsRepository } from "@database";
import { Injectable } from "@nestjs/common";
import { AdelantoEntity } from "../entities/adelanto.entity";

@Injectable()
export class AdelantosRepository extends BaseSheetsRepository<AdelantoEntity> {
    protected readonly EntityClass = AdelantoEntity;
}