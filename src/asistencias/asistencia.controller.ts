import { Controller, Post, Body, Get, Param, Put, Delete } from '@nestjs/common';
import { AsistenciasService } from './services/asistencias.service';
import { AsistenciaEntity } from './entities/asistencia.entity';

@Controller('asistencias')
export class AsistenciaController {
    constructor(private readonly service: AsistenciasService) { }

    @Post()
    create(@Body() createDto: AsistenciaEntity) {
        return this.service.create(createDto);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(id);
    }

    @Put(':id')
    update(@Param('id') id: string, @Body() updateDto: AsistenciaEntity) {
        return this.service.update(id, updateDto);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.service.remove(id);
    }
}
