// src/database/services/database-config.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { TABLE_NAME_KEY } from '../decorators/table.decorator';
import { BaseSheetsRepository } from '../repositories/base.sheets.repository';
import { NamingStrategy } from '@database/strategy/naming.strategy';

@Injectable()
export class DatabaseConfigService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseConfigService.name);

    constructor(
        private readonly discoveryService: DiscoveryService,
    ) { }

    async onModuleInit() {
        this.logger.log('🚀 Iniciando descubrimiento de repositorios...');
        const providers = this.discoveryService.getProviders();
        for (const wrapper of providers) {
            const { instance } = wrapper;
            if (instance && instance instanceof BaseSheetsRepository) {
                const repository = instance as BaseSheetsRepository<any>;
                const entityClass = (repository as any).EntityClass;
                if (!entityClass) continue;
                // 1. Obtenemos el nombre del decorador
                const decoratedName = Reflect.getMetadata(TABLE_NAME_KEY, entityClass);
                // 2. Aplicamos la regla: Si no hay decorador manual, usamos plural + mayúsculas
                const finalName = decoratedName
                    ? decoratedName.trim().toUpperCase()
                    : NamingStrategy.formatSheetName(entityClass.name);
                try {
                    // 3. IMPORTANTE: Una sola llamada a initialize
                    await repository.initialize(finalName);
                    this.logger.log(`✅ ${repository.constructor.name} -> Pestaña: "${finalName}"`);
                } catch (error) {
                    this.logger.error(`❌ Error al inicializar ${repository.constructor.name}: ${error.message}`);
                }
            }
        }
    }

}