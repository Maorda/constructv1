// src/payroll/controllers/liquidacion.controller.ts
import { Controller, Get, Post, Body, Query, ParseIntPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ObreroEntity } from '../entities/obrero.entity';
import { ObrerosService } from '../services/planilla.service';

@Controller('obreros')
export class ObrerosController {
    constructor(private readonly obrerosService: ObrerosService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    async crear(@Body() data: Partial<ObreroEntity>) {
        // El body debe ser: { "dni": "70001122", "nombres": "JUAN", "apellidos": "RAMOS", "jornalDiario": 90 }
        return await this.obrerosService.registrarObrero(data);
    }

    @Get()
    async listar() {
        return await this.obrerosService.listarActivos();
    }
    @Get('planilla')
    async obtenerPlanillaCalculada() {
        return "await this.liquidacionService.obtenerPlanillaCalculada(dni, diasTrabajados);"
    }
}