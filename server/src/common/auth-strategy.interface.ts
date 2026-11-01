/**
 * AuthStrategy — the seam that lets this app's identity model be replaced
 * without touching a controller (docs/shared-accounts.md, phase 5; shipped
 * as (b) in docs/accounts.md).
 *
 * Intentionally the same shape as `@knowledge-loom/server`'s AuthStrategy, so
 * that if yaam-chat joins that suite the strategy written there drops in here
 * unchanged. Three implementations exist:
 *
 *  - TokenAuthStrategy (AUTH_MODE=single): the optional shared bearer token;
 *    every caller is SINGLE_USER and works in the 'single' account.
 *  - SessionAuthStrategy (AUTH_MODE=accounts): the HttpOnly session cookie
 *    minted by the magic link; the caller is their account id.
 *  - SuiteJwtStrategy (AUTH_MODE=accounts + SUITE_ACCOUNTS_URL): a JWT from
 *    the suite's front door; experimental.
 *
 * The returned id is also the tenant: AuthGuard binds it as the current
 * account (accounts/account-context.ts) and every query is scoped to it.
 */
import type { Request } from 'express';

export interface AuthStrategy {
  /**
   * Authenticates the request and returns the caller's id, or throws
   * UnauthorizedException. Never returns a falsy value on success. May be
   * async when identity lives in the database (sessions).
   */
  authenticate(request: Request): string | Promise<string>;

  /** Requests that bypass authentication entirely (liveness probes, the
   *  sign-in routes, webhooks that carry their own credential). */
  isPublic?(request: Request): boolean;
}

/** Injection token for the active strategy. */
export const AUTH_STRATEGY = 'AUTH_STRATEGY';

/** The identity every request resolves to while the app is single-user. */
export const SINGLE_USER = 'local';

/**
 * Routes every strategy leaves open. Each carries its own credential or
 * none is needed:
 *  - GET /api/status (liveness), GET /api/security (disclosure policy);
 *  - POST /api/channels/email/inbound — HMAC over the body;
 *  - POST /api/hooks/:agentId/:loopName — the loop's own secret;
 *  - /api/auth/* — the sign-in flow itself (request-link, callback, me,
 *    logout); `me` answers "not signed in" rather than 401 so the SPA can
 *    decide what to render.
 */
export function isPublicRoute(request: Pick<Request, 'method' | 'path'>): boolean {
  // The desktop companion's four routes carry their own bearer kind
  // (computer/companion.guard.ts), which also binds the owning account.
  if (isCompanionRoute(request.method, request.path)) return true;
  if (request.method === 'GET') {
    if (request.path === '/api/status' || request.path === '/api/security') return true;
    if (request.path === '/api/auth/me' || request.path === '/api/auth/callback') return true;
    // The public registry feed (docs/registry.md): read-only, items with
    // published=1 and no personal data, so other instances can browse it.
    return /^\/api\/registry\/public(\/[^/]+)?\/?$/.test(request.path);
  }
  if (request.method !== 'POST') return false;
  if (request.path === '/api/channels/email/inbound') return true;
  if (request.path === '/api/auth/request-link' || request.path === '/api/auth/logout') return true;
  // Remote publish carries REGISTRY_PUBLISH_TOKEN as its own bearer
  // (RegistryService.acceptRemotePublish); the install/rate counters are
  // anonymous by design — they count, they never read or write anything else.
  if (/^\/api\/registry\/public(\/[^/]+\/(installed|rate|outcome))?\/?$/.test(request.path)) return true;
  return /^\/api\/hooks\/[^/]+\/[^/]+\/?$/.test(request.path);
}

/** The companion's routes: code-protected pairing, then companion-token
 *  routes guarded in the controller (docs/computer-control.md). */
export function isCompanionRoute(method: string, path: string): boolean {
  if (method === 'POST' && (path === '/api/computer/pair' || path === '/api/computer/heartbeat')) return true;
  if (method === 'GET' && path === '/api/computer/work') return true;
  return method === 'POST' && /^\/api\/computer\/result\/[A-Za-z0-9-]+$/.test(path);
}
