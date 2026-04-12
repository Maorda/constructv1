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

                // 1. Obtenemos el metadato
                const decoratedName = Reflect.getMetadata(TABLE_NAME_KEY, entityClass);

                // 2. Definimos el nombre final con seguridad total
                let finalName: string;

                if (typeof decoratedName === 'string' && decoratedName.trim().length > 0) {
                    // Si es un string real, lo usamos
                    finalName = decoratedName.trim().toUpperCase();
                } else {
                    // En cualquier otro caso (null, undefined, objeto), usamos la NamingStrategy
                    finalName = NamingStrategy.formatSheetName(entityClass.name);
                }

                // 3. Log informativo para confirmar el plural
                this.logger.log(`📡 [${entityClass.name}] -> Pestaña asignada: "${finalName}"`);

                try {
                    await repository.initialize(finalName);
                } catch (error) {
                    this.logger.error(`❌ Error al inicializar ${entityClass.name}: ${error.message}`);
                }
            }
        }
    }

}