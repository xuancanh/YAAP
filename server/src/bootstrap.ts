/**
 * bootstrap.ts — app factory shared by main.ts and integration tests, so
 * tests boot the exact same configuration (prefix, validation, CORS) as
 * production.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: true });
  app.enableShutdownHooks();
  return app;
}

export async function startApp(): Promise<void> {
  const app = await createApp();
  const port = app.get(ConfigService).get<number>('port')!;
  await app.listen(port);
  new Logger('Bootstrap').log(`yaam-chat API listening on http://localhost:${port}/api`);
}
