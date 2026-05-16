import {
    ConflictException,
    Injectable,
    InternalServerErrorException,
    Logger
} from '@nestjs/common';
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
     * Registra un nuevo obrero aplicando el patrón Active Record puro.
     */
    async registrarObrero(data: Partial<ObreroEntity>): Promise<ObreroEntity> {
        this.logger.log(`Iniciando flujo Active Record para DNI: ${data.dni}`);

        try {
            if (!data.dni) {
                throw new ConflictException('El campo DNI es mandatorio para registrar un obrero.');
            }

            // 1. Control de duplicados usando el método estático legítimo .find()
            const registrosExistentes = await this.obreroModel.find({ dni: data.dni });
            if (registrosExistentes && registrosExistentes.length > 0) {
                throw new ConflictException(`El obrero con DNI ${data.dni} ya está registrado.`);
            }

            // 2. ACTIVE RECORD EN ACCIÓN:
            // Instanciamos el modelo usando el constructor 'new' que expone tu interfaz Model<T>
            const nuevoObreroInstance = new this.obreroModel(data);

            this.logger.log('[Servicio] Instancia del documento creada. Ejecutando .save()...');

            // 3. Guardado físico en Google Sheets a través del método de instancia heredado de SheetDocument
            const obreroGuardado = await nuevoObreroInstance.save();

            this.logger.log(`✨ Obrero con DNI ${data.dni} persistido con éxito.`);

            // Retornamos el documento vivo (que gracias a tu toJSON() se serializará limpio en Insomnia)
            return obreroGuardado;

        } catch (error) {
            if (error instanceof ConflictException) throw error;

            this.logger.error(`❌ Fallo crítico en el proceso de persistencia: ${error.message}`, error.stack);
            throw new InternalServerErrorException('Error interno al escribir en la base de datos de Google Sheets.');
        }
    }

    /**
     * Recupera la colección de obreros que se encuentran activos.
     */
    async listarActivos(): Promise<Partial<ObreroEntity>[]> {
        this.logger.log('Buscando obreros activos en Google Sheets...');
        try {
            // Uso del Query Engine estático mapeado hacia repo.find()
            return await this.obreroModel.find({ activo: true });
        } catch (error) {
            this.logger.error(`❌ Error al recuperar listado: ${error.message}`);
            throw new InternalServerErrorException('No se pudo obtener la lista de obreros activos.');
        }
    }
}