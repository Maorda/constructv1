import { Injectable, Logger, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { InjectModel, Model } from '@database/factory/model.factory';

@Injectable()
export class ObrerosService {
    private readonly logger = new Logger(ObrerosService.name);

    constructor(
        @InjectModel(ObreroEntity)
        private readonly obreroModel: Model<ObreroEntity>
    ) { }

    async registrarObreroConAsistencias(payload: any): Promise<any> {
        this.logger.log(`[Servicio] Iniciando persistencia compuesta para DNI: ${payload.dni}`);

        try {
            if (!payload.dni) {
                throw new ConflictException('El campo DNI es obligatorio.');
            }

            // 1. Control de duplicados usando tu query estricto
            const registros = await this.obreroModel.find({ dni: payload.dni });
            if (registros && registros.length > 0) {
                throw new ConflictException(`El obrero con DNI ${payload.dni} ya existe.`);
            }

            // 2. EXTRAEMOS EL MOTOR NATIVAMENTE DESDE EL MODELO/REPOSITORIO
            // Accedemos al repositorio real que construyó tu SheetsRepositoryFactory
            const repository = (this.obreroModel as any).getRepository();
            const persistenceEngine = repository.getPersistenceEngine();

            this.logger.log(`[Servicio] Ejecutando persistencia relacional en Google Sheets...`);

            // 3. Despachamos la operación compuesta
            const resultadoRaw = await persistenceEngine.saveWithRelations(ObreroEntity, payload);

            return this.proyectarSalida(resultadoRaw);

        } catch (error) {
            if (error instanceof ConflictException) throw error;
            this.logger.error(`❌ Fallo en el flujo unificado: ${error.message}`);
            throw new InternalServerErrorException('Error al escribir la estructura compuesta en Google Sheets.');
        }
    }

    private proyectarSalida(data: any): any {
        const { __row, deletedAt, ...obreroLimpio } = data;
        if (Array.isArray(obreroLimpio.asistencias)) {
            obreroLimpio.asistencias = obreroLimpio.asistencias.map((a: any) => {
                const { __row: childRow, ...asistenciaLimpia } = a;
                return asistenciaLimpia;
            });
        }
        return obreroLimpio;
    }
}