import { Global, Module, DynamicModule, Provider } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';

// Servicios Técnicos
import { GoogleAutenticarService } from './services/auth.google.service';
import { GoogleHealthService } from './services/google.health.service';
import { DatabaseConfigService } from './services/database.config.service';
import { NamingStrategy } from './strategy/naming.strategy';
import { SheetsRepositoryFactory } from './repositories/sheets.repository.factory';
import { MetadataRegistry } from './services/metadata.registry';
import { ProjectionService } from './services/projection.seervice';

// Motores (Singletons compartidos)
import { CompareEngine } from './engines/compare.engine';
import { AggregationEngine } from './engines/aggregation.engine';
import { ExpressionEngine } from './engines/expressionEngine';
import { QueryEngine } from './engine/query.engine';

import {
    DatabaseModuleAsyncOptions,
    DatabaseModuleOptions,
    GoogleDriveConfig
} from './interfaces/database.options.interface';
import { ClassType } from './types/query.types';
import { createModel } from './factory/model.factory';

// 1. Proveedores centrales que se instancian una sola vez (Singletons)
const CORE_PROVIDERS: Provider[] = [
    GoogleAutenticarService,
    GoogleHealthService,
    DatabaseConfigService,
    NamingStrategy,
    MetadataRegistry,
    SheetsRepositoryFactory,
    ProjectionService,
    QueryEngine,
    CompareEngine,
    AggregationEngine,
    ExpressionEngine,
];

@Global()
@Module({
    imports: [
        HttpModule,
        DiscoveryModule,
        CacheModule.register({
            isGlobal: true,
            ttl: 60 * 60 * 1000,
            max: 100,
        }),
    ],
})
export class DatabaseModule {

    /**
     * registerAsync: Configuración global asíncrona (se llama en AppModule)
     */
    static registerAsync(options: DatabaseModuleAsyncOptions): DynamicModule {
        const spreadsheetIdProvider: Provider = {
            provide: 'SPREADSHEET_ID',
            // ⚡ AHORA LEE DIRECTAMENTE LA PROPIEDAD QUE PASAS EN TU USEFACTORY
            useFactory: (opts: DatabaseModuleOptions) => opts.SPREADSHEET_ID,
            inject: ['DATABASE_OPTIONS'],
        };
        const optionsProvider: Provider = {
            provide: 'DATABASE_OPTIONS',
            useFactory: options.useFactory,
            inject: options.inject || [],
        };

        const configProvider: Provider = {
            provide: 'CONFIG',
            useFactory: (opts: DatabaseModuleOptions): GoogleDriveConfig => opts.googleDriveConfig,
            inject: ['DATABASE_OPTIONS'],
        };

        const folderIdProvider: Provider = {
            provide: 'FOLDERID',
            useFactory: (opts: DatabaseModuleOptions) => opts.googleDriveBaseFolderId,
            inject: ['DATABASE_OPTIONS'],
        };

        return {
            module: DatabaseModule,
            providers: [
                optionsProvider,
                configProvider,
                folderIdProvider,
                spreadsheetIdProvider,
                ...CORE_PROVIDERS,
                {
                    provide: APP_INTERCEPTOR,
                    useClass: CacheInterceptor,
                },
            ],
            exports: ['DATABASE_OPTIONS', 'CONFIG', 'FOLDERID', ...CORE_PROVIDERS],
        };
    }

    /**
     * forFeature: Crea los repositorios específicos para cada entidad.
     * Delegamos la complejidad de creación a la Factory.
     */
    static forFeature(entities: ClassType[]): DynamicModule {
        const providers: Provider[] = entities.flatMap(Entity => {
            const MODEL_TOKEN = `${Entity.name}Model`;
            const REPO_TOKEN = `${Entity.name}Repository`;

            return [
                // 1. EL REPOSITORIO: Delegamos el "new" a la fábrica inyectada
                {
                    provide: REPO_TOKEN,
                    useFactory: (factory: SheetsRepositoryFactory<any>) => factory.create(Entity),
                    inject: [SheetsRepositoryFactory],
                },
                // 2. EL MODELO: Se construye a partir del repositorio anterior
                {
                    provide: MODEL_TOKEN,
                    useFactory: (repo: any) => createModel(Entity, repo),
                    inject: [REPO_TOKEN],
                },
                // 3. LA CLASE: Alias para inyectar directamente por Nombre de Clase
                {
                    provide: Entity,
                    useFactory: (model: any) => model,
                    inject: [MODEL_TOKEN],
                }
            ];
        });

        return {
            module: DatabaseModule,
            providers: [...providers],
            exports: [...providers],
        };
    }
}