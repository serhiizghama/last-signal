import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { parseCorsOrigins } from './cors-origins';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  const configService = app.get(ConfigService);
  const port = Number(configService.get<string>('PORT', String(DEFAULT_PORT)));
  const host = configService.get<string>('HOST', DEFAULT_HOST);
  const corsOrigins = parseCorsOrigins(configService.get<string>('CORS_ORIGINS'));

  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // `credentials: true`: the session cookie (§13) is httpOnly and cross-origin (the web
  // app's Vite dev server is a different origin from the API) — without this, the browser
  // never sends or accepts the cookie regardless of what the client's own fetch call asks for.
  app.enableCors({ origin: corsOrigins, credentials: true });

  await app.listen(port, host);

  // Logged because a CORS misconfiguration is otherwise invisible from the server side —
  // it surfaces only as the browser silently dropping the session cookie.
  logger.log(`CORS origins: ${corsOrigins.join(', ')}`);
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
