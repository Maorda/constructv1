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
import { createModel } from './factory/model.factory';
import { SheetsRepositoryFactory } from './repositories/sheets.repository.factory';
import { RelationEngine } from './engine/relationEngine';
import { MetadataRegistry } from './services/metadata.registry';
import { ProjectionService } from './services/projection.seervice';

// Lista centralizada de proveedores técnicos para evitar duplicidad
const TECHNICAL_PROVIDERS: Provider[] = [
    GoogleAutenticarService,
    //SheetsDataGateway,
    GoogleHealthService,
    DatabaseConfigService,
    NamingStrategy,
    //RepositoryContext, // El corazón de tus repositorios
    //SheetMapper,
    //PersistenceEngine,
    //GettersEngine,
    QueryEngine,
    CompareEngine,
    ManipulateEngine,
    //RelationalEngine,
    AggregationEngine,
    ExpressionEngine,
    MetadataRegistry,
    SheetsRepositoryFactory,
    ProjectionService
];
// 2. Exportamos solo lo que los otros módulos NECESITAN tocar
const TECHNICAL_EXPORTS = [
    //RepositoryContext,     // Fundamental para forFeature
    //PersistenceEngine,     // Para operaciones de guardado manual
    //SheetsDataGateway, // Acceso directo a la API de Google
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

    static forFeature<T extends object>(entities: ClassType[]): DynamicModule {
        const providers: Provider[] = entities.flatMap(Entity => {
            const MODEL_TOKEN = `${Entity.name}Model`;
            const REPO_TOKEN = `${Entity.name}Repository`;

            return [
                // Proveedor del Modelo (Lo que usas en @InjectModel)
                {
                    provide: MODEL_TOKEN,
                    useFactory: (repositoryFactory: SheetsRepositoryFactory<T>) => {
                        const repository = repositoryFactory.create(Entity);
                        return createModel(Entity, repository);
                    },
                    inject: [SheetsRepositoryFactory],
                },

                // Proveedor del Repositorio (Lo que usas en el constructor del servicio)
                {
                    provide: REPO_TOKEN,
                    useFactory: (repositoryFactory: SheetsRepositoryFactory<T>) => {
                        return repositoryFactory.create(Entity);
                    },
                    inject: [SheetsRepositoryFactory],
                },

                // Permitir inyectar la clase directamente si es necesario
                {
                    provide: Entity,
                    useFactory: (model: any) => model,
                    inject: [MODEL_TOKEN],
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
    /**
       * FABRICA DE CONTEXTOS (createRepositoryContext)
       * He simplificado la creación para que use los Singletons del container
       */
    static createRepositoryContext<T extends object>(Entity: ClassType, container: any): RepositoryContext<T> {
        const metadataRegistry = new MetadataRegistry();

        // 1. Pre-instanciamos motores que no tienen dependencias circulares
        const expressionEngine = new ExpressionEngine(Entity);
        const manipulateEngine = new ManipulateEngine<T>(Entity, metadataRegistry);
        const compareEngine = container.compareEngine || new CompareEngine(container.moduleRef);

        // 2. EL PROBLEMA: SheetMapper pide Gateway y Gateway pide Mapper.
        // Creamos el Gateway primero con el Mapper como 'null' momentáneamente o viceversa.
        // Según tu constructor de SheetMapper, necesita el gateway:

        // Creamos una instancia parcial o "lazy" del Gateway si es necesario, 
        // pero intentaremos la instanciación lineal:

        // Primero el Gateway (asumiendo que su constructor acepta el mapper luego o es independiente)
        const gateway = new SheetsDataGateway<T>(
            container.googleAuthService,
            container.cache,
            container.options,
            Entity,
            metadataRegistry,
            null as any // Mapper se asignará después si hay circularidad
        );

        // 3. Ahora instanciamos el SheetMapper con el orden exacto de tu constructor:
        // [0] options, [1] Entity, [2] auth, [3] gateway, [4] cache
        const sheetMapper = new SheetMapper<T>(
            container.options,           // @Inject('DATABASE_OPTIONS')
            Entity as any,               // private readonly EntityClass
            container.googleAuthService, // private readonly googleAuthService
            gateway,                     // private readonly sheetService
            container.cache              // @Inject(CACHE_MANAGER)
        );

        // Si tu SheetsDataGateway necesitaba el mapper, se lo inyectamos manualmente ahora:
        (gateway as any).sheetMapper = sheetMapper;

        // 4. Continuamos con el resto de motores
        const gettersEngine = new GettersEngine<T>(
            Entity,
            container.cache,
            expressionEngine,
            compareEngine,
            container.options,
            gateway
        );

        const aggregationEngine = new AggregationEngine<T>(
            expressionEngine,
            container.moduleRef,
            gateway
        );

        const persistenceEngine = new PersistenceEngine<T>(
            Entity,
            gateway,
            container.options,
            gettersEngine,
            container.moduleRef,
            aggregationEngine,
            metadataRegistry,
            compareEngine
        );

        const contextProxy: any = {};
        const relationEngine = new RelationEngine<T>(Entity, () => contextProxy as RepositoryContext<T>, container.moduleRef);
        const relationalEngine = new RelationalEngine<T>(container.moduleRef);
        const queryEngine = new QueryEngine(compareEngine, relationEngine);

        const sheetName = Reflect.getMetadata('sheetName', Entity) || Entity.name;
        const primaryKeyProp = metadataRegistry.getPrimaryKeyField(Entity);
        const sheetsQuery = new SheetsQuery<T>(gettersEngine, {}, queryEngine);

        const finalContext = new RepositoryContext<T>(
            Entity,
            sheetName,
            gateway,
            container.options,
            persistenceEngine,
            compareEngine,
            manipulateEngine,
            gettersEngine,
            relationalEngine,
            aggregationEngine,
            expressionEngine,
            queryEngine,
            relationEngine,
            primaryKeyProp,
            sheetsQuery
        );

        Object.assign(contextProxy, finalContext);
        return finalContext;
    }

    // --- MÉTODOS DE REGISTRO ASYNC/SYNC ---

    private static createAsyncOptionsProvider(options: DatabaseModuleAsyncOptions): Provider[] {
        if (options.useFactory) {
            return [{
                provide: 'DATABASE_OPTIONS',
                useFactory: options.useFactory,
                inject: options.inject || [],
            }];
        }
        return [];
    }

    static registerAsync(options: DatabaseModuleAsyncOptions): DynamicModule {
        return {
            module: DatabaseModule,
            global: true,
            imports: [
                ...(options.imports || []),
                HttpModule,
                DiscoveryModule,
                CacheModule.register({ isGlobal: true }),
            ],
            providers: [
                ...this.createAsyncOptionsProvider(options),
                ...TECHNICAL_PROVIDERS,
                {
                    provide: 'CONFIG',
                    useFactory: (opts: DatabaseModuleOptions) => opts.googleDriveConfig,
                    inject: ['DATABASE_OPTIONS'],
                },
                {
                    provide: 'FOLDERID',
                    useFactory: (opts: DatabaseModuleOptions) => opts.googleDriveBaseFolderId,
                    inject: ['DATABASE_OPTIONS'],
                },
                {
                    provide: APP_INTERCEPTOR,
                    useClass: CacheInterceptor,
                },
            ],
            exports: ['DATABASE_OPTIONS', "CONFIG", "FOLDERID", ...TECHNICAL_EXPORTS],
        };
    }

    static register(options: DatabaseModuleOptions): DynamicModule {
        const finalOptions = {
            checkConnectionOnBoot: true,
            timeout: 10000,
            ...options
        };
        return {
            module: DatabaseModule,
            global: true,
            providers: [
                { provide: 'DATABASE_OPTIONS', useValue: finalOptions },
                { provide: "CONFIG", useValue: finalOptions.googleDriveConfig },
                { provide: "FOLDERID", useValue: finalOptions.googleDriveBaseFolderId },
                ...TECHNICAL_PROVIDERS
            ],
            exports: ['DATABASE_OPTIONS', 'CONFIG', 'FOLDERID', ...TECHNICAL_EXPORTS],
        };
    }
}