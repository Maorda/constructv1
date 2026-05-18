import { Injectable, Logger, ConflictException, InternalServerErrorException, Inject, NotFoundException } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { InjectModel, Model } from '@database/factory/model.factory';
import { AsistenciaEntity } from '../entities/asistencia.entity';

@Injectable()
export class ObrerosService {
    private readonly logger = new Logger(ObrerosService.name);

    constructor(
        // 1. Conservamos el modelo para tus consultas Active Record (.find)
        @InjectModel(ObreroEntity)
        private readonly obreroModel: Model<ObreroEntity>,
        @InjectModel(AsistenciaEntity) private readonly asistenciaModel: Model<AsistenciaEntity>,

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

    /**
     * 🛠️ MÉTODO ESTRELLA: Actualización reactiva utilizando findOneAndUpdate
     * Modifica filas existentes o inserta nuevas asistencias bajo el principio del Upsert NoSQL.
     */
    async actualizarAsistenciasObrero(dni: string, asistenciasPayload: Partial<AsistenciaEntity>[]) {
        const obreroExiste = await this.obreroModel.findOne({ dni, estadoEliminado: false });
        if (!obreroExiste) {
            throw new NotFoundException(`No se encontró ningún obrero activo con el DNI ${dni}`);
        }

        const registrosActualizados = [];

        for (const rawAsistencia of asistenciasPayload) {
            // 🚀 CLONACIÓN DEFENSIVA: Rompemos cualquier referencia oculta u herencia de prototipos
            const asistencia = { ...rawAsistencia };
            asistencia.dni = dni;

            // Limpieza explícita por seguridad antes de armar el filtro
            delete (asistencia as any).__row;

            const filtroBusqueda = asistencia.idAsistencia
                ? { idAsistencia: asistencia.idAsistencia }
                : { dni: asistencia.dni, fecha: asistencia.fecha };

            // Ejecución limpia del Upsert en la hoja correspondiente
            const documentoActualizado = await this.asistenciaModel.findOneAndUpdate(
                filtroBusqueda,
                { $set: asistencia },
                { upsert: true, new: true }
            );

            if (documentoActualizado) {
                registrosActualizados.push(documentoActualizado);
            }
        }

        return registrosActualizados;
    }
    async registrarMarcajeMomentoDia(dni: string, payload: { fecha: string; campo: 'ingresoM' | 'salidaM' | 'ingresoT' | 'salidaT'; hora: string }) {
        // 1. Validamos la existencia del obrero activo
        const obreroExiste = await this.obreroModel.findOne({ dni, estadoEliminado: false });
        if (!obreroExiste) {
            throw new NotFoundException(`No se encontró ningún obrero activo con el DNI ${dni}`);
        }

        // 2. Normalizar la fecha a medianoche (Ignoramos desfases de horas/minutos en el filtro)
        const fechaFiltro = new Date(payload.fecha);
        fechaFiltro.setUTCHours(0, 0, 0, 0);

        // 3. Buscar si el obrero ya pisó la obra hoy (Fila única por día)
        const registroExistente = await this.asistenciaModel.findOne({
            dni: dni,
            fecha: fechaFiltro
        });

        let datosActualizacion: any = {};

        if (registroExistente) {
            // 🛡️ CASO A: El registro YA EXISTE (ej: es el mediodía o la tarde)
            // Extraemos una copia limpia de la fila actual para no arrastrar referencias cruzadas
            const filaActual = { ...registroExistente };
            delete filaActual.__row;

            // Inyectamos dinámicamente SOLO la propiedad que está ocurriendo en este instante
            filaActual[payload.campo] = payload.hora;

            // Recalculamos las horas trabajadas en memoria si ya tenemos entradas y salidas completas
            if (filaActual.ingresoM && filaActual.salidaM && filaActual.ingresoT && filaActual.salidaT) {
                filaActual.horas_trabajadas_del_dia = this.calcularHorasAsistencia(
                    filaActual.ingresoM, filaActual.salidaM, filaActual.ingresoT, filaActual.salidaT
                );
            }

            datosActualizacion = { $set: filaActual };
        } else {
            // Si no existe el registro (es la primera marca del día, 7:30 a. m.), inicializamos todo el documento
            camposAActualizar = {
                idAsistencia: crypto.randomUUID(), // Generamos su identificador único
                dni: dni,
                fecha: fechaFiltro,
                ingresoM: datosNuevos.ingresoM || null,
                salidaM: datosNuevos.salidaM || null,
                ingresoT: datosNuevos.ingresoT || null,
                salidaT: datosNuevos.salidaT || null,
                horas_trabajadas_del_dia: datosNuevos.horas_trabajadas_del_dia || 0,
                bono_sabado: datosNuevos.bono_sabado || 0,
                ext_deuda: datosNuevos.ext_deuda || 0
            };
        }

        // 5. Ejecutamos la persistencia atómica en la sub-hoja
        return await this.asistenciaModel.findOneAndUpdate(
            { dni: dni, fecha: fechaFiltro },
            { $set: camposAActualizar },
            { upsert: true, new: true }
        );
    }
}