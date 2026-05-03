import { Global, Module, DynamicModule, Provider } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { APP_INTERCEPTOR, DiscoveryModule, DiscoveryService, ModuleRef } from '@nestjs/core';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

// Servicios Técnicos
import { GoogleAutenticarService } from './services/auth.google.service';
import { SheetsDataGateway } from './services/sheetDataGateway';
import { GoogleHealthService } from './services/google.health.service';
import { DatabaseConfigService } from './services/database.config.service';

// Motores (Engines)
import { ManipulateEngine } from './engine/manipulateEngine';
import { RelationalEngine } from './engines/relational.engine';
import { CompareEngine } from './engines/compare.engine';
import { SheetsQuery } from './engines/sheet.query';
import { DocumentQuery } from './engines/document.query';
import { GettersEngine } from './engine/getters.engine';
import { PersistenceEngine } from './engine/persistence.engine';

// Infraestructura de Repositorios
import { RepositoryContext } from './repositories/repository.context';
import { NamingStrategy } from './strategy/naming.strategy';
import { SheetsRepository } from './repositories/sheets.repository';
import { DatabaseModuleAsyncOptions, DatabaseModuleOptions } from './interfaces/database.options.interface';
import { ClassType } from './types/query.types';
import { AggregationEngine } from './engines/aggregation.engine';
import { ExpressionEngine } from './engines/expressionEngine';
import { SheetMapper } from './engines/shereUtilsEngine/sheet.mapper';
import { QueryEngine } from './engine/query.engine';

// Lista centralizada de proveedores técnicos para evitar duplicidad
const TECHNICAL_PROVIDERS: Provider[] = [
    GoogleAutenticarService,
    SheetsDataGateway,
    GoogleHealthService,
    DatabaseConfigService,
    SheetsQuery,
    DocumentQuery,
    NamingStrategy,
    RepositoryContext, // El corazón de tus repositorios
    SheetMapper,
    PersistenceEngine,
    GettersEngine,
    QueryEngine,
    CompareEngine,
    ManipulateEngine,
    RelationalEngine,
    AggregationEngine,
    ExpressionEngine,
];
// 2. Exportamos solo lo que los otros módulos NECESITAN tocar
const TECHNICAL_EXPORTS = [
    RepositoryContext,     // Fundamental para forFeature
    SheetsQuery,           // Para armar filtros complejos
    DocumentQuery,         // Para lógica de documentos
    PersistenceEngine,     // Para operaciones de guardado manual
    SheetsDataGateway, // Acceso directo a la API de Google
    GoogleHealthService,   // Monitoreo de conexión
    NamingStrategy,        // Para consistencia en nombres de tablas
];



@Global()
@Module({
    imports: [HttpModule, DiscoveryModule,
        CacheModule.register({
            isGlobal: true, // Para no tener que importarlo en cada módulo
            ttl: 60 * 60 * 1000, // Tiempo de vida: 1 hora (en milisegundos)
            max: 100, // Máximo de 100 elementos en caché
        }),
    ],
    // providers: [DatabaseConfigService, DiscoveryService, GoogleAutenticarService, GoogleSpreedsheetService, GoogleHealthService]
})
export class DatabaseModule {
    // CONFIGURACIÓN GLOBAL
    static forRoot(options: DatabaseModuleOptions): DynamicModule {
        return this.register(options)
    }
    /**
     * MÉTODO MÁGICO: forFeature
     * Crea repositorios y contextos únicos por cada entidad.
     */

    static forFeature(entities: ClassType[]): DynamicModule {
        const providers: Provider[] = entities.flatMap(Entity => {
            const CONTEXT_TOKEN = `CONTEXT_${Entity.name.toUpperCase()}`;

            return [
                {
                    provide: CONTEXT_TOKEN,
                    useFactory: (gateway: SheetsDataGateway, options: DatabaseModuleOptions, cache: Cache, moduleRef: ModuleRef) => {
                        // LLAMADA LIMPIA: Delegamos todo al método estático
                        return this.createRepositoryContext(Entity, { gateway, options, cache, moduleRef });
                    },
                    inject: [SheetsDataGateway, 'DATABASE_OPTIONS', CACHE_MANAGER, ModuleRef],
                },
                {
                    provide: Entity,
                    useFactory: (ctx: RepositoryContext) => new SheetsRepository(Entity, ctx),
                    inject: [CONTEXT_TOKEN],
                },
                {
                    provide: `${Entity.name}Repository`,
                    useFactory: (context: RepositoryContext) => {
                        // Creamos el repo y le pasamos el contexto con los superpoderes
                        return new SheetsRepository(Entity, context);
                    },
                    inject: [RepositoryContext],
                }
            ];
        });

        return {
            module: DatabaseModule,
            providers,
            exports: providers,
        };
    }
    /**
 * FABRICA DE CONTEXTOS: Centraliza la creación para evitar discrepancias.
 */
    static createRepositoryContext(entity: ClassType, container: any): RepositoryContext {
        // 1. Instanciamos Motores Puros (Sin dependencias externas)
        const expression = new ExpressionEngine(entity);
        const manipulate = new ManipulateEngine(entity);
        const getters = new GettersEngine(entity, container.gateway, container.cache);
        const compare = new CompareEngine(entity, container.gateway);
        const queryEngine = new QueryEngine(entity, container.gateway, container.cache);
        // 2. Instanciamos Motores Complejos (Con dependencias de NestJS o Motores hermanos)
        const persistence = new PersistenceEngine(entity, container.gateway, container.cache, container.options);
        const relational = new RelationalEngine(entity, container.moduleRef);
        const aggregation = new AggregationEngine(entity, expression, container.moduleRef);

        // 3. Retornamos el maletín ensamblado siguiendo el orden exacto de tu constructor de RepositoryContext
        return new RepositoryContext(
            container.gateway,
            container.options,
            container.cache,
            container.moduleRef, // Importante: Verifica que este sea el orden en tu RepositoryContext
            persistence,
            compare,
            manipulate,
            getters,
            relational,
            aggregation,
            expression
        );
    }


    private static createAsyncOptionsProvider(options: DatabaseModuleAsyncOptions): Provider[] {
        // Si usas useFactory (el que ya teníamos)
        if (options.useFactory) {
            return [{
                provide: 'DATABASE_OPTIONS',
                useFactory: options.useFactory,
                inject: options.inject || [],
            }];
        }
    }
    //constructor(private readonly discoveryService: DiscoveryService) { }
    static registerAsync(options: DatabaseModuleAsyncOptions): DynamicModule {
        return {
            module: DatabaseModule,
            imports: [
                ...(options.imports || []),
                HttpModule,
                DiscoveryModule,
                CacheModule.register({ isGlobal: true }),
            ],
            providers: [
                ...DatabaseModule.createAsyncOptionsProvider(options),
                ...TECHNICAL_PROVIDERS,
                {
                    provide: 'DATABASE_OPTIONS',
                    useFactory: options.useFactory,
                    inject: options.inject,
                },
                {
                    provide: APP_INTERCEPTOR,
                    useClass: CacheInterceptor, // Activa la caché para todos los GET
                },


            ],
            exports: ['DATABASE_OPTIONS', "CONFIG", "FOLDERID", ...TECHNICAL_EXPORTS],

        };
    }
    /**
   * @param googleDriveConfig your config file/all config fields
   * @param googleDriveFolderId your Google Drive folder id
   */
    static register(options: DatabaseModuleOptions): DynamicModule {
        // Valores por defecto para opciones opcionales
        const finalOptions = {
            checkConnectionOnBoot: true,
            timeout: 10000,
            ...options
        };
        return {
            module: DatabaseModule,
            global: true,
            providers: [
                {
                    provide: 'DATABASE_OPTIONS', // Token para inyectar las opciones completas
                    useValue: finalOptions,
                },
                // Mapeamos los tokens antiguos que ya usas para no romper compatibilidad
                {
                    provide: "CONFIG",
                    useValue: finalOptions.googleDriveConfig,
                },
                {
                    provide: "FOLDERID",
                    useValue: finalOptions.googleDriveBaseFolderId,
                },
                ...TECHNICAL_PROVIDERS

            ],
            exports: ['DATABASE_OPTIONS', 'CONFIG', 'FOLDERID', ...TECHNICAL_EXPORTS],
        };
    }
}