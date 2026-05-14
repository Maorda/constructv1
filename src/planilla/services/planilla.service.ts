import { ConflictException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { InjectModel, Model } from '@database/factory/model.factory';
@Injectable()
export class ObrerosService {
    private readonly logger = new Logger(ObrerosService.name);
    constructor(
        @InjectModel(ObreroEntity)
        private readonly obreroModel: Model<ObreroEntity>
    ) { }
    /**
 * Registro usando el patrón Active Record
 */
    async registrarObrero(datos: Partial<ObreroEntity>): Promise<ObreroEntity> {
        try {
            // 1. Verificación usando método estático (Query Engine)
            const existe = await this.obreroModel.findOne({ dni: datos.dni });

            if (existe) {
                this.logger.warn(`DNI duplicado detectado: ${datos.dni}`);
                throw new ConflictException(`El obrero con DNI ${datos.dni} ya existe.`);
            }

            // 2. Inserción usando Active Record (Instancia)
            // Esto utiliza el 'new' de tu ModelClass y el método .save()
            const nuevoObrero = new this.obreroModel(datos);

            this.logger.log(`Guardando nuevo obrero en Google Sheets...`);
            return await nuevoObrero.save();

        } catch (error) {
            this.logger.error(`Error en persistencia: ${error.message}`);
            if (error instanceof ConflictException) throw error;
            throw new InternalServerErrorException('Error al conectar con la base de datos de Sheets.');
        }
    }

    /**
     * Listado usando método estático
     */
    async listarActivos(): Promise<Partial<ObreroEntity>[]> {
        return await this.obreroModel.find({ activo: true });
    }

}



