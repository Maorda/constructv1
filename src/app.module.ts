import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { envValidationSchema } from 'env.validation';
import { DatabaseModule } from '@database';
import { PlanillaModule } from './planilla/planilla.module';
import { AsistenciaModule } from './asistencias/asistencia.module';



@Module({
  imports: [
    ConfigModule.forRoot({
      ///load: [configLoader],
      validationSchema: envValidationSchema,
      isGlobal: true
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
        defaultSpreadsheetId: config.get<string>('SPREADSHEET_ID'),
        checkConnectionOnBoot: true,
        timeout: 10000,
      }),
    }),

    PlanillaModule,

    AsistenciaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
