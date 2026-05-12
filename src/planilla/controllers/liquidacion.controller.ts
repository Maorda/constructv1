// src/payroll/controllers/liquidacion.controller.ts
import { Controller, Get, Post, Body, Query, ParseIntPipe } from '@nestjs/common';
import { LiquidacionService } from '../services/liquidacion.service';

@Controller('payroll')
export class LiquidacionController {
    constructor(private readonly liquidacionService: LiquidacionService) { }

    /**
     * Obtiene el resumen semanal de un obrero (lo que vemos en el Excel)
     * GET /payroll/resumen?dni=12345678&lunes=2026-04-06&sabado=2026-04-11
     */
    @Get('resumen')
    async getResumenSemanal(
        @Query('dni') dni: string,
        @Query('lunes') lunes: string,
        @Query('sabado') sabado: string,
    ) {
        return { dni, lunes, sabado }
    }

    /**
     * Registra el canje de horas del sábado
     * POST /payroll/canje
     */
    @Post('canje')
    async registrarCanje(
        @Body('dni') dni: string,
        @Body('horas', ParseIntPipe) horas: number,
    ) {
        return { dni, horas };
    }
}