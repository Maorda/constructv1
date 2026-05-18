// src/payroll/controllers/liquidacion.controller.ts
import { Controller, Get, Post, Body, Query, ParseIntPipe, HttpCode, HttpStatus, Put, Param } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { ObrerosService } from '../services/planilla.service';

@Controller('obreros')
export class ObrerosController {
    constructor(private readonly obrerosService: ObrerosService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    async registrarPlanillaCompleta(@Body() payload: any) {
        const data = await this.obrerosService.registrarObreroConAsistencias(payload);

        return {
            status: 'success',
            message: 'Obrero y desglose de asistencias guardados exitosamente en Google Sheets.',
            data
        };
    }
    /**
     * 🚀 NUEVO: Endpoint para actualizar masivamente el tareo/asistencias de un obrero
     */
    @Put(':dni/asistencias')
    @HttpCode(HttpStatus.OK)
    async actualizarAsistencias(
        @Param('dni') dni: string,
        @Body() payload: { asistencias: any[] }
    ) {
        const data = await this.obrerosService.actualizarAsistenciasObrero(dni, payload.asistencias);
        return {
            status: 'success',
            message: `Hojas de tareo/asistencias del DNI ${dni} actualizadas correctamente empleando findOneAndUpdate.`,
            data
        };
    }


}