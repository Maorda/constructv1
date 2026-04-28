import { Injectable, NotFoundException } from '@nestjs/common';
import { BaseSheetsCrudService, RepositoryContext, SheetsRepository } from '@database';
import { AdelantoEntity } from '../entities/adelanto.entity';
import { ObreroEntity } from '../entities/obrero.entity';
import { AsistenciaEntity } from '../entities/asistencia.entity';
import { BalanceEntity } from '../entities/balance.entity';
@Injectable()
export class LiquidacionService extends BaseSheetsCrudService<ObreroEntity> {
    private readonly META_DIARIA = 8.5;
    private readonly HORAS_SEMANALES_LEY = 48;

    constructor(
        private readonly repositoryContext: RepositoryContext,
        private readonly obrerosRepo: SheetsRepository<ObreroEntity>,
    ) {
        super(repositoryContext, ObreroEntity)
    }

}