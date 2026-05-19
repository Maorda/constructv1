import { PlanillaTareoService } from "../services/PlanillaTareoService";
import { Body, Controller, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";

@Controller('tareo')
export class TareoRelojController {
    constructor(private readonly planillaService: PlanillaTareoService) { }

    /**
     * Endpoint reactivo que consume las ráfagas del reloj marcador
     */
    @Post('marcar-instante')
    @HttpCode(HttpStatus.OK)
    async registrarMarcacion(
        @Body() body: {
            idPlanilla: string,
            mesCalendario: string, // Ej: "2026-05"
            idObrero: string,
            fecha: string, // YYYY-MM-DD
            campoMarca: 'ingresoManana' | 'salidaManana' | 'ingresoTarde' | 'salidaTarde',
            hora: string, // HH:MM
            estado?: 'ASISTIO' | 'FALTA_JUSTIFICADA' | 'FALTA_INJUSTIFICADA' | 'PERMISO_JUSTIFICADO' | 'PERMISO_INJUSTIFICADO'
        }
    ) {
        // Ejecuta el findOneAndUpdate y retorna el JSON hidratado con los Getters en memoria
        return await this.planillaService.registrarMarcacionInstante(body);
    }
}