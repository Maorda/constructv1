import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { envValidationSchema } from 'env.validation';
import { DatabaseModule } from '@database';
import { PlanillaModule } from './planilla/planilla.module';
import { ModuleRef } from '@nestjs/core';
import { MetadataRegistry } from '@database/services/metadata.registry';
import { CONNECTION_STABILITY } from '@database/interfaces/database.options.interface';
import { ObreroEntity } from './planilla/entities/ObreroEntity';


@Module({
  imports: [
    ConfigModule.forRoot({
      ///load: [configLoader],
      validationSchema: envValidationSchema,
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        googleDriveConfig: {
          type: 'service_account',
          project_id: config.get<string>('GOOGLE_PROJECT_ID'),
          private_key_id: config.get<string>('GOOGLE_PRIVATE_KEY_ID'),
          private_key: config.get<string>('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n'),
          client_email: config.get<string>('GOOGLE_CLIENT_EMAIL'),
          client_id: config.get<string>('GOOGLE_CLIENT_ID'),
          auth_uri: config.get<string>('GOOGLE_AUTH_URI'),
          token_uri: config.get<string>('GOOGLE_TOKEN_URI'),
          auth_provider_x509_cert_url: config.get<string>('GOOGLE_AUTH_PROVIDER_X509_CERT_URL'),
          client_x509_cert_url: config.get<string>('GOOGLE_CLIENT_X509_CERT_URL'),
        },
        googleDriveBaseFolderId: config.get<string>('GOOGLE_FOLDER_ID'),
        SPREADSHEET_ID: config.get<string>('SPREADSHEET_ID'),
        checkConnectionOnBoot: true,
        timezone: config.get<string>('TIMEZONE') || 'UTC',//'America/Lima configurado en el .env',
        FORMAT_DATES: config.get<boolean>('FORMAT_DATES') || false, //configurado en el .env
        timeout: CONNECTION_STABILITY.UNSTABLE
      }),
    }),

    PlanillaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('DebugModuloPrincipal');

  constructor(private readonly moduleRef: ModuleRef) { }

  async onApplicationBootstrap() {
    this.logger.log('--- 🔍 INICIANDO AUDITORÍA DE CONTEXTO GLOBAL ---');

    try {
      // 1. Extraer el MetadataRegistry global para ver qué se registró en el arranque
      const metadataRegistry = this.moduleRef.get(MetadataRegistry, { strict: false });

      this.logger.log('¿MetadataRegistry está cargado?: ' + (!!metadataRegistry));

      if (metadataRegistry) {
        // Forzamos la lectura de la entidad problemática
        const columnasMapeadas = metadataRegistry.getColumnMap(ObreroEntity);
        const detallesColumnas = metadataRegistry.getColumnDetails(ObreroEntity);

        console.log('[DEBUG CORE] Índices posicionales de ObreroEntity:', columnasMapeadas);
        console.log('[DEBUG CORE] Claves detalladas encontradas:', Object.keys(detallesColumnas));
      }

      // 2. Verificar variables de entorno cruciales en caliente
      console.log('[DEBUG CORE] Spreadsheet ID en uso:', process.env.SPREADSHEET_ID || '❌ NO DEFINIDO');
      console.log('[DEBUG CORE] Client Email de Cuenta de Servicio:', process.env.GOOGLE_CLIENT_EMAIL ? '✅ CARGADO' : '❌ NO DEFINIDO');

    } catch (error) {
      this.logger.error('❌ Error al inspeccionar el core del sistema:', error.message);
    }

    this.logger.log('--- 🔍 FIN DE LA AUDITORÍA ---');
  }
}
