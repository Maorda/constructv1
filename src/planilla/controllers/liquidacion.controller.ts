// src/payroll/controllers/liquidacion.controller.ts
import { Controller, Get, Post, Body, Query, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
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


    @Get('planilla')
    async obtenerPlanillaCalculada() {
        return "await this.liquidacionService.obtenerPlanillaCalculada(dni, diasTrabajados);"
    }
}