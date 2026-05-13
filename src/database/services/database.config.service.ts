// src/database/services/database-config.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { TABLE_NAME_KEY } from '../decorators/table.decorator';
import { NamingStrategy } from '@database/strategy/naming.strategy';
import { SheetsDataGateway } from './sheetDataGateway';


@Injectable()
export class DatabaseConfigService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseConfigService.name);

    constructor(
        private readonly discoveryService: DiscoveryService,
    ) {


    }


    async onModuleInit() {
        this.logger.log('🚀 Descubriendo repositorios por estructura...');

        const providers = this.discoveryService.getProviders();

        for (const wrapper of providers) {
            const { instance } = wrapper;

            if (instance && (instance as any).__isSheetsRepository) {
                const repository = instance;
                const entityClass = (repository as any).entityClass;

                if (!entityClass) {
                    this.logger.warn(`⚠️ Se encontró un repositorio sin entityClass definida.`);
                    continue;
                }

                // 1. Resolución del nombre (esto está perfecto en tu script)
                const decoratedName = Reflect.getMetadata(TABLE_NAME_KEY, entityClass);
                const finalName = (typeof decoratedName === 'string' && decoratedName.trim().length > 0)
                    ? decoratedName.trim().toUpperCase()
                    : NamingStrategy.formatSheetName(entityClass.name);

                try {
                    this.logger.log(`📡 Preparando infraestructura: [${entityClass.name}] -> "${finalName}"`);

                    /**
                     * 2. CAMBIO CLAVE:
                     * En lugar de confiar en un método genérico del repositorio, 
                     * vamos a forzar la inicialización del Gateway asociado a ese repositorio.
                     * * Si tu repositorio tiene una propiedad pública 'gateway', úsala directamente.
                     * Si no, asegúrate de que el método repository.initialize(name) 
                     * haga internamente: return await this.gateway.initialize(name);
                     */
                    if (repository.gateway && typeof repository.gateway.initialize === 'function') {
                        await repository.gateway.initialize(finalName);
                    } else if (typeof repository.initialize === 'function') {
                        // Si el repositorio envuelve al gateway:
                        await repository.initialize(finalName);
                    } else {
                        throw new Error(`El repositorio para ${entityClass.name} no tiene un método de inicialización válido.`);
                    }

                } catch (error) {
                    this.logger.error(`❌ Error crítico al inicializar [${entityClass.name}]: ${error.message}`);
                    // En producción/entorno crítico (Huaraz), es mejor detener el arranque si falla la DB
                    process.exit(1);
                }
            }
        }
        this.logger.log('✅ Todos los repositorios y pestañas han sido sincronizados.');
    }

}