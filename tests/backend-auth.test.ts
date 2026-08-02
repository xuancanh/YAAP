/** Optional bearer-token guard (YAAM_API_TOKEN): unset = everything passes
 *  (single-user localhost default); set = every /api route requires the token
 *  except GET /api/status, which must stay open for liveness probes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthGuard } from '../server/src/common/auth.guard';

const guardWith = (apiToken: string) =>
  new AuthGuard({ get: (key: string) => (key === 'apiToken' ? apiToken : undefined) } as unknown as ConfigService);

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
