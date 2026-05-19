// src/payroll/controllers/liquidacion.controller.ts
import { Controller, Post, Body, HttpCode, HttpStatus, Put, Param } from '@nestjs/common';
import { PlanillaTareoService } from '../services/PlanillaTareoService'; // Ajusta la ruta relativa según tu árbol

@Controller('obreros')
export class ObrerosController {
    // Sincronizado con el nombre real de tu servicio Core
    constructor(private readonly planillaTareoService: PlanillaTareoService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    async registrarPlanillaCompleta(@Body() payload: any) {
        // Ejecuta saveWithRelations internamente manejando la cascada en Google Sheets
        const data = await this.planillaTareoService.registrarObreroConAsistencias(payload);

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
        // Ejecuta el procesador dinámico por lotes
        const data = await this.planillaTareoService.actualizarAsistenciasObrero(dni, payload.asistencias);
        return {
            status: 'success',
            message: `Hojas de tareo/asistencias del DNI ${dni} actualizadas correctamente empleando findOneAndUpdate.`,
            data
        };
    }
}