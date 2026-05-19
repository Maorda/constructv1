import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CategoriaEntity } from '../entities/CategoriaEntity';
import { DetallePlanillaEntity } from '../entities/DetallePlanillaEntity';
import { ObreroEntity } from '../entities/ObreroEntity';
import { AdelantoEntity } from '../entities/AdelantoEntity';
import { AsistenciaDiariaEntity } from '../entities/AsistenciaDiariaEntity';
import { InjectModel } from '@database/factory/model.factory';
import { SheetsRepository } from '@database/repositories/sheets.repository';

@Injectable()
export class PlanillaTareoService {
    private readonly logger = new Logger(PlanillaTareoService.name);

    constructor(
        @InjectModel(ObreroEntity) private readonly obreroRepo: SheetsRepository<ObreroEntity>,
        @InjectModel(AsistenciaDiariaEntity) private readonly asistenciaRepo: SheetsRepository<AsistenciaDiariaEntity>,
        @InjectModel(DetallePlanillaEntity) private readonly detalleRepo: SheetsRepository<DetallePlanillaEntity>,
        @InjectModel(CategoriaEntity) private readonly categoriaRepo: SheetsRepository<CategoriaEntity>,
        @InjectModel(AdelantoEntity) private readonly adelantosRepo: SheetsRepository<AdelantoEntity>,
    ) { }

    /**
     * 1. Crear Categoría Tarifaria (Maestro)
     */
    async crearCategoria(dto: Partial<CategoriaEntity>): Promise<CategoriaEntity> {
        const doc = await this.categoriaRepo.findOneAndUpdate(
            { id: dto.id },
            { $set: dto },
            { upsert: true, new: true }
        );
        return doc as unknown as CategoriaEntity;
    }

    /**
     * 2. Crear Obrero Base
     */
    async crearObrero(dto: Partial<ObreroEntity>): Promise<ObreroEntity> {
        const categoriaExists = await this.categoriaRepo.findOne({ id: dto.idCategoriaActual });
        if (!categoriaExists) throw new NotFoundException('La categoría tarifaria especificada no existe.');

        const doc = await this.obreroRepo.findOneAndUpdate(
            { id: dto.id },
            { $set: dto },
            { upsert: true, new: true }
        );
        return doc as unknown as ObreroEntity;
    }

    /**
     * 3. Registrar Ficha Completa del Obrero (Operación Relacional Anidada)
     */
    async registrarObreroConAsistencias(payload: any): Promise<ObreroEntity> {
        if (!payload.idCategoriaActual) {
            throw new BadRequestException('Es requerido especificar el campo idCategoriaActual.');
        }
        const categoriaExists = await this.categoriaRepo.findOne({ id: payload.idCategoriaActual });
        if (!categoriaExists) throw new NotFoundException('La categoría tarifaria especificada no existe.');

        this.logger.log(`[Servicio] Ejecutando saveWithRelations para la persistencia en cascada de: ${payload.nombre}`);
        return await (this.obreroRepo as any).saveWithRelations(ObreroEntity, payload);
    }

    /**
     * 4. Actualización de Tareo Masivo Diario (Lotes)
     */
    async actualizarAsistenciasObrero(dni: string, asistencias: any[]): Promise<AsistenciaDiariaEntity[]> {
        const obrero = await this.obreroRepo.findOne({ dni });
        if (!obrero) throw new NotFoundException(`No se encontró ningún obrero con el DNI: ${dni}`);

        if (!Array.isArray(asistencias) || asistencias.length === 0) {
            throw new BadRequestException('El lote de asistencias no es válido.');
        }

        const resultados: AsistenciaDiariaEntity[] = [];
        for (const asistenciaDto of asistencias) {
            if (!asistenciaDto.fecha) continue;

            const doc = await this.asistenciaRepo.findOneAndUpdate(
                { idObrero: (obrero as any).id, fecha: asistenciaDto.fecha },
                {
                    $set: {
                        ingresoManana: asistenciaDto.ingresoManana || '',
                        salidaManana: asistenciaDto.salidaManana || '',
                        ingresoTarde: asistenciaDto.ingresoTarde || '',
                        salidaTarde: asistenciaDto.salidaTarde || '',
                        estado: asistenciaDto.estado || 'ASISTIO'
                    }
                },
                { upsert: true, new: true }
            );
            resultados.push(doc as unknown as AsistenciaDiariaEntity);
        }
        return resultados;
    }

    /**
     * 5. Registrar Adelantos Semanales de Forma Acumulativa
     */
    async registrarAdelanto(dto: { idPlanilla: string, idObrero: string, fecha: string, monto: number, motivo: string }): Promise<AdelantoEntity> {
        const obrero = await this.obreroRepo.findOne({ id: dto.idObrero });
        if (!obrero) throw new NotFoundException('Obrero no registrado.');

        const nuevoAdelanto = await this.adelantosRepo.create(dto as any);

        const detalleExistente = await this.detalleRepo.findOne({ idPlanilla: dto.idPlanilla, idObrero: dto.idObrero });

        // Corrección de acceso mediante .entity según la estructura de tu proxy SheetDocument
        const acumuladoAdelantos = detalleExistente
            ? (Number(detalleExistente.entity.totalAdelantosSemana) + dto.monto)
            : dto.monto;

        await this.detalleRepo.findOneAndUpdate(
            { idPlanilla: dto.idPlanilla, idObrero: dto.idObrero },
            { $set: { totalAdelantosSemana: acumuladoAdelantos } },
            { upsert: true }
        );

        return nuevoAdelanto as unknown as AdelantoEntity;
    }

    async registrarMarcacionInstante(dto: {
        idPlanilla: string,
        mesCalendario: string,
        idObrero: string,
        fecha: string,
        campoMarca: 'ingresoManana' | 'salidaManana' | 'ingresoTarde' | 'salidaTarde',
        hora: string,
        estado?: 'ASISTIO' | 'FALTA_JUSTIFICADA' | 'FALTA_INJUSTIFICADA' | 'PERMISO_JUSTIFICADO' | 'PERMISO_INJUSTIFICADO'
    }): Promise<DetallePlanillaEntity> {

        this.logger.log(`========== [DEBUG START: registrarMarcacionInstante] ==========`);
        this.logger.log(`[1] Payload recibido del controlador: ${JSON.stringify(dto)}`);

        const obrero = await this.obreroRepo.findOne({ id: dto.idObrero });
        this.logger.log(`[2] Resultado búsqueda Obrero (ID: ${dto.idObrero}): ${obrero ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
        if (!obrero) throw new NotFoundException('Trabajador no registrado en la base de datos de la obra.');

        const categoria = await this.categoriaRepo.findOne({ id: (obrero as any).idCategoriaActual });
        this.logger.log(`[3] Resultado búsqueda Categoría (ID: ${(obrero as any).idCategoriaActual}): ${categoria ? 'ENCONTRADA' : 'NO ENCONTRADA'}`);
        if (!categoria) throw new NotFoundException('El obrero no cuenta con tarifas asignadas.');

        // 1. Guardar la marca diaria
        this.logger.log(`[4] Invocando findOneAndUpdate en asistenciaRepo para fecha: ${dto.fecha}`);
        const asistenciaDiaria = await this.asistenciaRepo.findOneAndUpdate(
            { idObrero: dto.idObrero, fecha: dto.fecha },
            { $set: { [dto.campoMarca]: dto.hora, estado: dto.estado || 'ASISTIO' } },
            { upsert: true, new: true }
        ) as any;
        this.logger.log(`[5] Asistencia Diaria devuelta por repositorio: ${JSON.stringify(asistenciaDiaria)}`);

        // 2. Cálculos de horas
        let horasTrabajadasHoy = 0;
        if (asistenciaDiaria && asistenciaDiaria.estado === 'ASISTIO') {
            const m1 = this.calcularDiferenciaHoras(asistenciaDiaria.ingresoManana, asistenciaDiaria.salidaManana);
            const m2 = this.calcularDiferenciaHoras(asistenciaDiaria.ingresoTarde, asistenciaDiaria.salidaTarde);
            horasTrabajadasHoy = Number((m1 + m2).toFixed(2));
        }
        this.logger.log(`[6] Horas calculadas hoy: ${horasTrabajadasHoy}`);

        const diaSemana = new Date(dto.fecha).getUTCDay();
        const limiteNormado = (diaSemana >= 1 && diaSemana <= 5) ? 8.5 : 5.5;

        let jornadaNormalDelDia = 0;
        let extrasPurasDelDia = 0;
        let incompletasABolsaDelDia = 0;
        const conteoAusencia = (asistenciaDiaria && asistenciaDiaria.estado !== 'ASISTIO') ? 1 : 0;

        if (asistenciaDiaria && asistenciaDiaria.estado === 'ASISTIO') {
            if (horasTrabajadasHoy >= limiteNormado) {
                jornadaNormalDelDia = limiteNormado;
                extrasPurasDelDia = Number((horasTrabajadasHoy - limiteNormado).toFixed(2));
            } else {
                incompletasABolsaDelDia = horasTrabajadasHoy;
            }
        }

        // 3. Acumulados históricos
        this.logger.log(`[7] Buscando Detalle Planilla Semanal existente...`);
        const detalleExistente = await this.detalleRepo.findOne({ idPlanilla: dto.idPlanilla, idObrero: dto.idObrero });
        this.logger.log(`[8] Detalle Planilla existente encontrado: ${detalleExistente ? 'SÍ' : 'NO (Es registro nuevo)'}`);

        const arrastreEfectivo = detalleExistente ? detalleExistente.entity.arrastreEfectivoAnterior : ((obrero as any).saldoEfectivoArrastrado || 0);
        const arrastreHoras = detalleExistente ? detalleExistente.entity.arrastreHorasExtraAnterior : ((obrero as any).saldoHorasExtraArrastrado || 0);

        const nuevoHorasJornada = Number(((detalleExistente?.entity.horasJornadaCompletaAcumuladas || 0) + jornadaNormalDelDia).toFixed(2));
        const nuevoHorasExtras = Number(((detalleExistente?.entity.horasExtrasPuraAcumuladas || 0) + extrasPurasDelDia).toFixed(2));
        const nuevoHorasBolsa = Number(((detalleExistente?.entity.horasIncompletasABolsa || 0) + incompletasABolsaDelDia).toFixed(2));
        const nuevoAusencias = (detalleExistente?.entity.contadorAusencias || 0) + conteoAusencia;

        const updatePayload = {
            idPlanilla: dto.idPlanilla,
            idObrero: dto.idObrero,
            mesCalendario: dto.mesCalendario,
            costoHN: (categoria as any).costoHoraNormal,
            costoHE: (categoria as any).costoHoraExtra,
            arrastreEfectivoAnterior: arrastreEfectivo,
            arrastreHorasExtraAnterior: arrastreHoras,
            horasJornadaCompletaAcumuladas: nuevoHorasJornada,
            horasExtrasPuraAcumuladas: nuevoHorasExtras,
            horasIncompletasABolsa: nuevoHorasBolsa,
            contadorAusencias: nuevoAusencias
        };

        this.logger.log(`[9] Payload preparado para $set en detalleRepo: ${JSON.stringify(updatePayload)}`);

        // 4. Invocación transaccional al repositorio crítico
        this.logger.log(`[10] Lanzando this.detalleRepo.findOneAndUpdate...`);

        const detalleGuardado = await this.detalleRepo.findOneAndUpdate(
            { idPlanilla: dto.idPlanilla, idObrero: dto.idObrero },
            { $set: updatePayload },
            { upsert: true, new: true }
        );

        this.logger.log(`[11] Resultado directo devuelto por detalleRepo: ${JSON.stringify(detalleGuardado)}`);
        this.logger.log(`========== [DEBUG END: registrarMarcacionInstante] ==========`);

        return detalleGuardado as unknown as DetallePlanillaEntity;
    }

    /**
     * 7. CIERRE DE SEMANA (Liquidación y Arrastre automático a la ficha del Maestro Obreros)
     */
    async registrarPagoEfectivoEnMesa(idPlanilla: string, idObrero: string, efectivoEntregado: number): Promise<any> {
        const detalle = await this.detalleRepo.findOne({ idPlanilla, idObrero });
        if (!detalle) throw new NotFoundException('No existe registro de tareo para este obrero en la semana indicada.');

        const detalleActualizado = await this.detalleRepo.findOneAndUpdate(
            { idPlanilla, idObrero },
            { $set: { efectivoPagadoEnMano: efectivoEntregado } },
            { new: true }
        ) as any;

        // Consumo de los Getters Virtuales vivos inyectados por el Hydrator a través de los Proxies
        const proxSaldoEfectivo = detalleActualizado.saldoEfectivoPendienteProximaSemana;
        const proxDeudaHoras = detalleActualizado.deudaHorasProximaSemana;

        await this.obreroRepo.findOneAndUpdate(
            { id: idObrero },
            {
                $set: {
                    saldoEfectivoArrastrado: proxSaldoEfectivo,
                    saldoHorasExtraArrastrado: proxDeudaHoras
                }
            }
        );

        return {
            status: 'success',
            mensaje: 'Cierre semanal procesado con éxito. Los saldos remanentes calculados por la entidad han sido heredados al Maestro de Obreros.',
            data: {
                idPlanilla,
                idObrero,
                efectivoEntregadoEnMesa: efectivoEntregado,
                saldoFinancieroProximaSemana: proxSaldoEfectivo,
                deudaHorasProximaSemana: proxDeudaHoras
            }
        };
    }

    /**
     * Helper Utilidad: Parsea cadenas de texto (HH:MM) para calcular diferencias decimales exactas de horas
     */
    private calcularDiferenciaHoras(entrada: string, salida: string): number {
        if (!entrada || !salida || entrada.trim() === '' || salida.trim() === '') return 0;

        const [hEntrada, mEntrada] = entrada.split(':').map(Number);
        const [hSalida, mSalida] = salida.split(':').map(Number);

        if (isNaN(hEntrada) || isNaN(hSalida)) return 0;

        const minutosEntrada = hEntrada * 60 + mEntrada;
        const minutosSalida = hSalida * 60 + mSalida;

        const diferenciaMinutos = minutosSalida - minutosEntrada;
        return diferenciaMinutos > 0 ? diferenciaMinutos / 60 : 0;
    }
}