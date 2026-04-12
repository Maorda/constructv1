import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { useContainer } from 'class-validator';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
// Asegúrate de que la ruta de importación coincida con tu estructura
import { GoogleHealthService } from './database/services/google.health.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { cors: true });

  // --- CONFIGURACIÓN DE VALIDACIÓN ---
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // --- CONFIGURACIÓN DE CORS ---
  const writelist = ["https://localhost:3000"];
  const corsOptions: CorsOptions = {
    origin: function (origin, callback) {
      if (writelist.indexOf(origin) !== -1 || !origin) {
        callback(null, true);
      } else {
        callback(new Error("not allow by corsw"));
      }
    },
    methods: '*',
    credentials: true,
    optionsSuccessStatus: 204,
  };
  app.enableCors(corsOptions);

  // Permite que class-validator use el contenedor de NestJS para inyectar dependencias
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // --- VERIFICACIÓN DE SALUD DE GOOGLE (FAIL-FAST) ---
  const healthService = app.get(GoogleHealthService);

  logger.log('Validando conectividad crítica con Google Sheets...');

  const health = await healthService.checkConnection();

  if (health.status !== 'up') {
    logger.error('---------------------------------------------------------');
    logger.error('ERROR CRÍTICO: No se pudo conectar con Google Sheets.');
    logger.error(`Detalle: ${health.details?.error || 'Error desconocido'}`);
    logger.error('El sistema no puede arrancar sin acceso a la base de datos.');
    logger.error('---------------------------------------------------------');

    // Cerramos la aplicación inmediatamente para evitar inconsistencias
    await app.close();
    process.exit(1);
  }

  logger.log('Conexión con Google Sheets exitosa. Iniciando servidor...');


  // --- ARRANQUE DEL SERVIDOR ---
  const port = process.env.PORT || 3000;
  await app.listen(port, () => {
    console.log(`sistema corriendo en el puerto: ${port}`);
  });
}
bootstrap();