/** GET /api/security publishes the disclosure contact and the threat-model
 *  summary (docs/security.md). It must be readable without a bearer token —
 *  like GET /api/status — and must say exactly what the config says. The
 *  summary lines are checked against the document so the page and the API
 *  cannot drift apart silently. */
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Module, UnauthorizedException, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { AddressInfo } from 'node:net';
import { AuthGuard } from '../server/src/common/auth.guard';
import { TokenAuthStrategy } from '../server/src/common/token-auth.strategy';
import { SecurityController, SECURITY_POLICY_URL, SECURITY_SUMMARY } from '../server/src/security/security.controller';
import configurationDefault from '../server/src/config/configuration';

// tsx under the tests tsconfig hands the default export back wrapped in
// `{ default }` for some module shapes; accept either so the test is about
// the config key, not the loader.
type ConfigFactory = () => { securityContact: string };
const configuration: ConfigFactory =
  typeof configurationDefault === 'function'
    ? (configurationDefault as ConfigFactory)
    : (configurationDefault as unknown as { default: ConfigFactory }).default;

function testModule(env: { apiToken: string; securityContact: string }) {
  @Module({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => env] })],
    controllers: [SecurityController],
    providers: [
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

async function boot(env: { apiToken: string; securityContact: string }): Promise<{ app: INestApplication; base: string }> {
  const app = await NestFactory.create(testModule(env), { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  const { port } = (app.getHttpServer() as { address: () => AddressInfo }).address();
  return { app, base: `http://127.0.0.1:${port}` };
}

type Policy = { contact: string; policyUrl: string; summary: string[] };

test('GET /api/security is open without a token and returns contact, policyUrl and summary', async (t) => {
  const { app, base } = await boot({ apiToken: 'secret', securityContact: 'security@example.test' });
  t.after(() => app.close());

  const res = await fetch(`${base}/api/security`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Policy;
  assert.equal(body.contact, 'security@example.test');
  assert.equal(body.policyUrl, SECURITY_POLICY_URL);
  assert.deepEqual(body.summary, [...SECURITY_SUMMARY]);
  assert.ok(body.summary.length >= 5, 'the summary is a real list, not a placeholder');
});

test('unset SECURITY_CONTACT publishes an empty contact, never a made-up one', async (t) => {
  const { app, base } = await boot({ apiToken: '', securityContact: '' });
  t.after(() => app.close());
  const body = (await (await fetch(`${base}/api/security`)).json()) as Policy;
  assert.equal(body.contact, '');
});

test('the allowlist is exact: only GET /api/security bypasses the guard', () => {
  const guard = new AuthGuard(new TokenAuthStrategy(
    { get: (key: string) => (key === 'apiToken' ? 'secret' : undefined) } as unknown as ConfigService,
  ));
  const ctx = (method: string, path: string): ExecutionContext =>
    ({ switchToHttp: () => ({ getRequest: () => ({ method, path, headers: {} }) }) }) as unknown as ExecutionContext;
  assert.equal(guard.canActivate(ctx('GET', '/api/security')), true);
  assert.throws(() => guard.canActivate(ctx('POST', '/api/security')), UnauthorizedException);
  assert.throws(() => guard.canActivate(ctx('GET', '/api/security/anything')), UnauthorizedException);
});

test('securityContact comes from SECURITY_CONTACT and defaults to empty', () => {
  const prev = process.env.SECURITY_CONTACT;
  try {
    delete process.env.SECURITY_CONTACT;
    assert.equal(configuration().securityContact, '');
    process.env.SECURITY_CONTACT = 'security@example.test';
    assert.equal(configuration().securityContact, 'security@example.test');
  } finally {
    if (prev === undefined) delete process.env.SECURITY_CONTACT; else process.env.SECURITY_CONTACT = prev;
  }
});

test('docs/security.md exists, carries every section the plan asked for, and names the API route', () => {
  const doc = readFileSync(new URL('../docs/security.md', import.meta.url), 'utf8');
  for (const heading of [
    'Scope', 'Assets and trust tiers', 'Isolation model', 'Approval taxonomy',
    'Prompt-injection posture', 'Memory and learning', 'Proactive work',
    'What we never do', 'Known gaps', 'Reporting a vulnerability', 'Changelog',
  ]) {
    assert.match(doc, new RegExp(`^## .*${heading}`, 'mi'), `missing section: ${heading}`);
  }
  assert.match(doc, /SECURITY_CONTACT/);
  assert.match(doc, /GET \/api\/security/);
  const root = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
  assert.match(root, /docs\/security\.md/);
});
