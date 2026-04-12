import { Global, Module, OnModuleInit } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DynamicModule } from '@nestjs/common';
import { GoogleAutenticarService } from './services/auth.google.service';
import { GoogleSpreedsheetService } from './services/google.spreedsheet.service';
import { DatabaseModuleOptions } from './interfaces/database.options.interface';
import { GoogleHealthService } from './services/google.health.service';
import { APP_INTERCEPTOR, DiscoveryModule, DiscoveryService, ModuleRef } from '@nestjs/core';
import { BaseSheetsRepository } from './repositories/base.sheets.repository';
import { DatabaseConfigService } from './services/database.config.service';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
@Global()
@Module({
    imports: [HttpModule, DiscoveryModule,
        CacheModule.register({
            isGlobal: true, // Para no tener que importarlo en cada módulo
            ttl: 60 * 60 * 1000, // Tiempo de vida: 1 hora (en milisegundos)
            max: 100, // Máximo de 100 elementos en caché
        }),
    ],
    providers: [DatabaseConfigService, DiscoveryService, GoogleAutenticarService, GoogleSpreedsheetService, GoogleHealthService]
})
export class DatabaseModule {
    //constructor(private readonly discoveryService: DiscoveryService) { }
    static registerAsync(options: {
        inject: any[];
        useFactory: (...args: any[]) => Promise<DatabaseModuleOptions> | DatabaseModuleOptions;
    }): DynamicModule {
        return {
            module: DatabaseModule,
            providers: [
                {
                    provide: 'DATABASE_OPTIONS',
                    useFactory: options.useFactory,
                    inject: options.inject,
                },
                // Mantenemos los tokens para compatibilidad con tus servicios actuales
                {
                    provide: "CONFIG",
                    useFactory: (opt: DatabaseModuleOptions) => opt.googleDriveConfig,
                    inject: ['DATABASE_OPTIONS'],
                },
                {
                    provide: "FOLDERID",
                    useFactory: (opt: DatabaseModuleOptions) => opt.googleDriveBaseFolderId,
                    inject: ['DATABASE_OPTIONS'],
                },
                {
                    provide: APP_INTERCEPTOR,
                    useClass: CacheInterceptor, // Activa la caché para todos los GET
                },
                GoogleAutenticarService,
                GoogleSpreedsheetService,
                GoogleHealthService,
            ],
            exports: ['DATABASE_OPTIONS', "CONFIG", "FOLDERID", GoogleSpreedsheetService, GoogleHealthService],
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
            providers: [{
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
                GoogleAutenticarService,
                GoogleSpreedsheetService,
                GoogleHealthService,
            ],
            exports: ['DATABASE_OPTIONS', GoogleSpreedsheetService, GoogleHealthService],
        };
    }
}