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
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Composer attachments upload base64-in-JSON, one file per request: ≤5MB
  // for files, ≤25MB for voice notes (docs/voice.md) ≈ 34MB on the wire —
  // the 100kb default would reject them; 40mb leaves headroom without
  // opening the door to unbounded bodies.
  // `verify` keeps the raw bytes on the request: the inbound-mail webhook
  // checks an HMAC over the body as sent, not over a re-serialisation.
  app.use(json({ limit: '40mb', verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf); } }));
  app.use(urlencoded({ limit: '40mb', extended: true }));
  const config = app.get(ConfigService);
  // Only browser cross-origin calls need CORS: requests without an Origin
  // header (curl, server-to-server, same-origin) always pass; production
  // serves the SPA same-origin so the allowlist is the Vite dev origin.
  const allowlist = (config.get<string>('corsOrigins') ?? '')
    .split(',')
    .map((o: string) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) =>
      cb(null, !origin || allowlist.includes(origin)),
  });
  app.enableShutdownHooks();
  return app;
}

export async function startApp(): Promise<void> {
  const app = await createApp();
  const port = app.get(ConfigService).get<number>('port')!;
  await app.listen(port);
  new Logger('Bootstrap').log(`yaam-chat API listening on http://localhost:${port}/api`);
}
