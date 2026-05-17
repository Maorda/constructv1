import { Injectable, Logger, ConflictException, InternalServerErrorException, Inject } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { InjectModel, Model } from '@database/factory/model.factory';

@Injectable()
export class ObrerosService {
    private readonly logger = new Logger(ObrerosService.name);

    constructor(
        // 1. Conservamos el modelo para tus consultas Active Record (.find)
        @InjectModel(ObreroEntity)
        private readonly obreroModel: Model<ObreroEntity>,

        // 2. Inyectamos directamente el repositorio nativo generado por tu fábrica
        @Inject('ObreroEntityRepository')
        private readonly obreroRepository: any
    ) { }

    async registrarObreroConAsistencias(payload: any): Promise<any> {
        this.logger.log(`[Servicio] Iniciando persistencia compuesta para DNI: ${payload.dni}`);

        try {
            if (!payload.dni) {
                throw new ConflictException('El campo DNI es obligatorio.');
            }

            // A. Control de duplicados usando el modelo (Funciona perfecto)
            const registros = await this.obreroModel.find({ dni: payload.dni });
            if (registros && registros.length > 0) {
                throw new ConflictException(`El obrero con DNI ${payload.dni} ya existe.`);
            }

            // B. EXTRAEMOS EL MOTOR RELACIONAL DIRECTAMENTE DEL REPOSITORIO
            // Tu SheetsRepositoryFactory añade el persistenceEngine al contexto, 
            // y mediante el método getPersistenceEngine() que agregamos, lo recuperamos en caliente.
            const persistenceEngine = this.obreroRepository.getPersistenceEngine();

            this.logger.log(`[Servicio] Ejecutando guardado relacional en cascada (Google Sheets)...`);
            this.logger.debug(`[1. DEBUG SERVICIO] Payload crudo recibido de Insomnia: ${JSON.stringify(payload)}`);

            // C. Despachamos la operación compuesta
            const resultadoRaw = await persistenceEngine.saveWithRelations(ObreroEntity, payload);

            return this.proyectarSalida(resultadoRaw);

        } catch (error) {
            if (error instanceof ConflictException) throw error;
            this.logger.error(`❌ Fallo en el flujo unificado: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Error al escribir la estructura compuesta en Google Sheets.');
        }
    }

    /**
     * Limpia metadatos técnicos de las filas antes de responder
     */
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