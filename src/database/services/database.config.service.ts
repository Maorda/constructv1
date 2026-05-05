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
    ) { }


    async onModuleInit() {
        this.logger.log('🚀 Descubriendo repositorios por estructura...');

        const providers = this.discoveryService.getProviders();

        for (const wrapper of providers) {
            const { instance } = wrapper;

            // 1. Verificación por el tag inyectado en forFeature
            if (instance && (instance as any).__isSheetsRepository) {
                const repository = instance;

                // 2. Acceso a la clase (asegúrate que en SheetsRepository sea pública 
                // o usa la propiedad 'entityClass' inyectada en forFeature)
                const entityClass = (repository as any).entityClass;

                if (!entityClass) {
                    this.logger.warn(`⚠️ Se encontró un repositorio sin entityClass definida.`);
                    continue;
                }

                // 3. Resolución del nombre de la pestaña
                const decoratedName = Reflect.getMetadata(TABLE_NAME_KEY, entityClass);
                const finalName = (typeof decoratedName === 'string' && decoratedName.trim().length > 0)
                    ? decoratedName.trim().toUpperCase()
                    : NamingStrategy.formatSheetName(entityClass.name);

                try {
                    this.logger.log(`📡 Preparando infraestructura: [${entityClass.name}] -> "${finalName}"`);

                    // 4. Llamada al puente de inicialización en el repositorio
                    // Esto activará el Gateway con sus reintentos y el respiro de 5s
                    await repository.initialize(finalName);

                } catch (error) {
                    this.logger.error(`❌ Error crítico al inicializar [${entityClass.name}]: ${error.message}`);
                    // Opcional: En Huaraz, si la conexión muere aquí, podrías querer lanzar el error
                    // para que el proceso se detenga y no arranque un servidor "roto".
                    // throw error; 
                }
            }
        }
        this.logger.log('✅ Todos los repositorios y pestañas han sido sincronizados.');
    }

}