/** HTTP smoke test: boots a minimal Nest app on an ephemeral port with the
 *  real AuthGuard (global) and the real StatusController/StatusService against
 *  a stubbed DRIZZLE_DB, then exercises the auth boundary and readiness over
 *  the wire with global fetch. The full AppModule isn't bootable here (it
 *  opens a real pg pool and S3 client), so the module is hand-assembled to
 *  mirror bootstrap.ts's prefix + guard wiring. */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { AddressInfo } from 'node:net';
import { AuthGuard } from '../server/src/common/auth.guard';
import { TokenAuthStrategy } from '../server/src/common/token-auth.strategy';
import { DRIZZLE_DB } from '../server/src/database/database.constants';
import { StatusController } from '../server/src/status/status.controller';
import { StatusService } from '../server/src/status/status.service';

@Controller()
class DummyController {
  @Get('protected')
  protected() {
    return { ok: true };
  }
}

function testModule(apiToken: string, db: { execute: () => Promise<unknown> }) {
  @Module({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ apiToken })] })],
    controllers: [StatusController, DummyController],
    providers: [
      StatusService,
      { provide: DRIZZLE_DB, useValue: db },
      // Factory instead of useClass: tsx doesn't emit design:paramtypes, so
      // the strategy's ConfigService wouldn't be injected by type; the factory
      // wires the real guard to the real strategy explicitly.
      {
        provide: APP_GUARD,
        useFactory: (config: ConfigService) => new AuthGuard(new TokenAuthStrategy(config)),
        inject: [ConfigService],
      },
    ],
  })
  class TestModule {}
  return TestModule;
}

const up = { execute: async () => [{ '?column?': 1 }] };
const down = {
  execute: async () => {
    throw new Error('connection refused');
  },
};

async function boot(apiToken: string, db = up): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(testModule(apiToken, db), { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  const { port } = (app.getHttpServer() as { address: () => AddressInfo }).address();
  return { app, base: `http://127.0.0.1:${port}` };
}

test('no token configured: status and protected routes are both open', async (t) => {
  const { app, base } = await boot('');
  t.after(() => app.close());

  const status = await fetch(`${base}/api/status`);
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { ok: boolean }).ok, true);

  const protectedRes = await fetch(`${base}/api/protected`);
  assert.equal(protectedRes.status, 200);
});

test('token configured: status stays open, protected 401s without bearer and passes with one', async (t) => {
  const { app, base } = await boot('secret');
  t.after(() => app.close());

  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/protected`)).status, 401);
  assert.equal((await fetch(`${base}/api/protected`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal(
    (await fetch(`${base}/api/protected`, { headers: { authorization: 'Bearer secret' } })).status,
    200,
  );
});

test('database down: status reports degraded with 503', async (t) => {
  const { app, base } = await boot('secret', down);
  t.after(() => app.close());

  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; db: string };
  assert.equal(body.ok, false);
  assert.equal(body.db, 'down');
});
