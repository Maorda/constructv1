// src/database/services/database-config.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import { NamingStrategy } from '@database/strategy/naming.strategy';
import { SHEETS_TABLE_NAME } from '@database/constants/metadata.constants';


@Injectable()
export class DatabaseConfigService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseConfigService.name);

    constructor(
        private readonly discoveryService: DiscoveryService,
    ) {


    }


    async onModuleInit() {
        this.logger.log('🚀 Iniciando sincronización de infraestructura ODM...');

        // 1. Obtener todos los providers registrados en NestJS
        const providers = this.discoveryService.getProviders();

        // 2. Filtrar solo aquellos que marcamos como Repositorios de Sheets
        const sheetRepositories = providers.filter(wrapper =>
            wrapper.instance && (wrapper.instance as any).__isSheetsRepository
        );

        for (const wrapper of sheetRepositories) {
            const repository = wrapper.instance;
            const entityClass = (repository as any).entityClass;

            if (!entityClass) {
                this.logger.warn(`⚠️ Repositorio [${wrapper.name}] ignorado: Falta 'entityClass'.`);
                continue;
            }

            // 3. Resolución del nombre usando la constante unificada SHEETS_TABLE_NAME
            const decoratedName = Reflect.getMetadata(SHEETS_TABLE_NAME, entityClass);

            const finalName = (typeof decoratedName === 'string' && decoratedName.trim().length > 0)
                ? decoratedName.trim().toUpperCase()
                : NamingStrategy.formatSheetName(entityClass.name);

            try {
                this.logger.log(`📡 Configurando: [${entityClass.name}] -> "${finalName}"`);

                // 4. Inicialización del Gateway o Repositorio
                // Priorizamos la inicialización del gateway si está expuesto, sino el método del repo
                if (repository.gateway && typeof repository.gateway.initialize === 'function') {
                    await repository.gateway.initialize(finalName);
                } else if (typeof repository.initialize === 'function') {
                    await repository.initialize(finalName);
                } else {
                    throw new Error(`Interfaz de inicialización no encontrada.`);
                }

                this.logger.log(`✅ Infraestructura lista para: ${finalName}`);

            } catch (error) {
                this.logger.error(`❌ Error crítico en [${entityClass.name}]: ${error.message}`);

                // En un entorno de producción, si la base de datos (Sheets) no responde, 
                // es mejor no levantar el servicio para evitar inconsistencias.
                process.exit(1);
            }
        }

        this.logger.log('✨ Sincronización completa. Todos los repositorios están operativos.');
    }
}