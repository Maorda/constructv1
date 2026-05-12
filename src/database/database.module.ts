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

    static forFeature<T extends object>(entities: ClassType[]): DynamicModule {
        const providers: Provider[] = entities.flatMap(Entity => {
            const CONTEXT_TOKEN = `CONTEXT_${Entity.name.toUpperCase()}`;

            return [
                {
                    provide: `${Entity.name}Model`, // El token para @InjectModel(Obra.name)
                    useFactory: (repositoryFactory: SheetsRepositoryFactory<T>) => {
                        // 1. El Factory crea el Repositorio inyectando todos los motores
                        const repository = repositoryFactory.create(Entity);
                        // 2. Usamos tu createModel para devolver el "Mongoose-like" Model
                        return createModel(Entity, repository);
                    },
                    inject: [SheetsRepositoryFactory<T>],
                },
                {
                    provide: CONTEXT_TOKEN,
                    useFactory: (gateway, options, cache, moduleRef) => {
                        // LLAMADA LIMPIA: Delegamos todo al método estático
                        return this.createRepositoryContext(Entity, { gateway, options, cache, moduleRef });
                    },
                    inject: [SheetsDataGateway, 'DATABASE_OPTIONS', CACHE_MANAGER, ModuleRef],
                },
                {
                    provide: Entity, // El token es la clase misma (ej: ObreroEntity)
                    useFactory: (ctx: RepositoryContext<T>) => {
                        // Retornamos el Modelo del contexto. 
                        // ¡Esto permite hacer: new ObreroEntity().save()!
                        return ctx.Model;
                    },
                    inject: [CONTEXT_TOKEN],
                },
                {
                    provide: `${Entity.name}Repository`,
                    useFactory: (ctx: RepositoryContext<T>) => {
                        // 1. Extraemos los metadatos de los "virtuals" (si los usas con decoradores)
                        // Si no tienes lógica de virtuals aún, pasamos un objeto vacío.
                        const virtuals = Reflect.getMetadata('virtuals', Entity) || {};

                        // 2. Instanciamos el ProjectionService
                        // IMPORTANTE: Asegúrate de importar ProjectionService al inicio del archivo
                        const projectionService = new ProjectionService<T>();

                        // 3. Ahora que las variables existen, instanciamos el repositorio
                        // Pasamos los 4 parámetros que definiste en tu clase
                        return new SheetsRepository<T>(
                            Entity,             // 1. entityClass
                            ctx,                // 2. ctx (RepositoryContext)
                            virtuals,           // 3. virtuals
                            projectionService   // 4. projectionService
                        );
                    },
                    inject: [CONTEXT_TOKEN],
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
    static createRepositoryContext<T extends object>(Entity: ClassType, container: any): RepositoryContext<T> {
        // 1. INFRAESTRUCTURA Y REGISTROS (Nivel 0)
        // Estos no dependen de otros motores
        const metadataRegistry = new MetadataRegistry();
        const sheetMapper = new SheetMapper<T>(
            container.options,           // 1. @Inject('DATABASE_OPTIONS')                      // 1. Clase de la entidad
            Entity,            // 2. Registro de metadatos
            container.options,           // 3. Opciones de base de datos (formatos, etc)
            container.cache,              // 4. Cache (si el mapper guarda esquemas)
            container.googleAuthService   // 5. Auth (si el mapper valida tipos dinámicos)
        );

        const expressionEngine = new ExpressionEngine(Entity);
        const manipulateEngine = new ManipulateEngine<T>(Entity, metadataRegistry);

        // 2. COMUNICACIÓN (Nivel 1)
        // El Gateway es la base, pero ahora requiere el Mapper y Auth
        const gateway = new SheetsDataGateway<T>(
            container.googleAuthService,
            container.cache,
            container.options,
            Entity,
            metadataRegistry,
            sheetMapper
        );

        // 3. LÓGICA DE COMPARACIÓN Y CONSULTA (Nivel 2)
        const compareEngine = new CompareEngine();

        // 4. MOTORES DE LECTURA Y AGREGACIÓN (Nivel 3)
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

        // 5. MOTOR DE ESCRITURA (Nivel 4 - El más complejo)
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

        // 6. OTROS MOTORES (Relaciones y Queries)
        const queryEngine = new QueryEngine(compareEngine);
        const relationEngine = new RelationEngine<T>(Entity, container.moduleRef);
        const relationalEngine = new RelationalEngine<T>(container.moduleRef);

        // 7. EXTRACCIÓN DE PROPIEDADES EXTRA
        const sheetName = Reflect.getMetadata('sheetName', Entity) || Entity.name;
        const primaryKeyProp = metadataRegistry.getPrimaryKeyField(Entity);

        // 8. ENSAMBLAJE DEL CONTEXTO
        // (Asegúrate de que el constructor de RepositoryContext reciba este orden)
        return new RepositoryContext<T>(
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
            primaryKeyProp
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