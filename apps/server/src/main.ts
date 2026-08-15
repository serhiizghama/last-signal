import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';
// Vite's default dev-server origin; the web app (a later step) will run here.
const DEV_WEB_ORIGIN = 'http://localhost:5173';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: DEV_WEB_ORIGIN });

  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT', String(DEFAULT_PORT)));
  const host = configService.get<string>('HOST', DEFAULT_HOST);

  await app.listen(port, host);

  logger.log(`Server listening on http://${host}:${port}/api`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    'Failed to bootstrap application',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
