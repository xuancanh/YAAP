/** Optional bearer-token guard (YAAM_API_TOKEN): unset = everything passes
 *  (single-user localhost default); set = every /api route requires the token
 *  except GET /api/status, which must stay open for liveness probes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../server/src/common/auth.guard';
import { TokenAuthStrategy } from '../server/src/common/token-auth.strategy';
import { AuthStrategy, SINGLE_USER } from '../server/src/common/auth-strategy.interface';

const guardWith = (apiToken: string) =>
  new AuthGuard(new TokenAuthStrategy(
    { get: (key: string) => (key === 'apiToken' ? apiToken : undefined) } as unknown as ConfigService,
  ));

const ctx = (method: string, path: string, authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, path, headers: authorization ? { authorization } : {} }),
    }),
  }) as unknown as ExecutionContext;

test('no token configured: every request is allowed', () => {
  const guard = guardWith('');
  assert.equal(guard.canActivate(ctx('GET', '/api/chats')), true);
  assert.equal(guard.canActivate(ctx('POST', '/api/chats/s1/turns')), true);
});

test('token configured: requests without/with a wrong bearer get 401', () => {
  const guard = guardWith('secret');
  assert.throws(() => guard.canActivate(ctx('GET', '/api/chats')), UnauthorizedException);
  assert.throws(() => guard.canActivate(ctx('GET', '/api/chats', 'Bearer wrong')), UnauthorizedException);
  assert.throws(() => guard.canActivate(ctx('POST', '/api/chats/s1/turns', 'secret')), UnauthorizedException);
});

test('token configured: correct bearer is allowed', () => {
  const guard = guardWith('secret');
  assert.equal(guard.canActivate(ctx('GET', '/api/chats', 'Bearer secret')), true);
  assert.equal(guard.canActivate(ctx('POST', '/api/workspaces/w1/files', 'Bearer secret')), true);
});

test('token configured: GET /api/status stays open, other methods do not', () => {
  const guard = guardWith('secret');
  assert.equal(guard.canActivate(ctx('GET', '/api/status')), true);
  assert.throws(() => guard.canActivate(ctx('POST', '/api/status')), UnauthorizedException);
  assert.throws(() => guard.canActivate(ctx('GET', '/api/status/anything')), UnauthorizedException);
});

// ---- the strategy seam (docs/shared-accounts.md, phase 5) ----

test('the guard delegates: swapping the strategy replaces the auth model', () => {
  // A stand-in for the kind of strategy the rest of the suite binds (a JWT
  // verifier). Nothing in the guard knows what identity means.
  const jwtish: AuthStrategy = {
    authenticate: (req) => {
      const header = (req.headers as Record<string, string>).authorization ?? '';
      if (!header.startsWith('Bearer tok-')) throw new UnauthorizedException('bad token');
      return header.slice('Bearer tok-'.length);
    },
    isPublic: (req) => req.path === '/api/status',
  };
  const guard = new AuthGuard(jwtish);

  const req = { method: 'GET', path: '/api/chats', headers: { authorization: 'Bearer tok-alice' } };
  assert.equal(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext), true);
  assert.equal((req as { userId?: string }).userId, 'alice', 'the resolved identity lands on the request');

  assert.throws(
    () => guard.canActivate(ctx('GET', '/api/chats', 'Bearer nope')),
    UnauthorizedException,
  );
});

test('the default strategy resolves every caller to the single local user', () => {
  const guard = guardWith('secret');
  const req = { method: 'GET', path: '/api/chats', headers: { authorization: 'Bearer secret' } };
  guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  // Not per-user by design: every table here is workspace-scoped with no user
  // column, so per-user subjects would authenticate people into shared data.
  assert.equal((req as { userId?: string }).userId, SINGLE_USER);
});
