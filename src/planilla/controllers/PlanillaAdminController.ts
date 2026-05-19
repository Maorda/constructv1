import { Body, Controller, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { PlanillaTareoService } from "../services/PlanillaTareoService";

@Controller('admin-planilla')
export class PlanillaAdminController {
    constructor(private readonly planillaService: PlanillaTareoService) { }

    @Post('categorias')
    @HttpCode(HttpStatus.CREATED)
    async crearCategoria(@Body() body: any) {
        return await this.planillaService.crearCategoria(body);
    }

    @Post('obreros')
    async crearObrero(@Body() body: any) {
        return await this.planillaService.crearObrero(body);
    }

    @Post('adelantos')
    async registrarAdelanto(@Body() body: { idPlanilla: string, idObrero: string, fecha: string, monto: number, motivo: string }) {
        return await this.planillaService.registrarAdelanto(body);
    }

    @Post('planillas/:idPlanilla/obreros/:idObrero/pagar')
    async pagarEnMesa(
        @Param('idPlanilla') idPlanilla: string,
        @Param('idObrero') idObrero: string,
        @Body('efectivoEntregado') efectivoEntregado: number
    ) {
        return await this.planillaService.registrarPagoEfectivoEnMesa(idPlanilla, idObrero, efectivoEntregado);
    }
}