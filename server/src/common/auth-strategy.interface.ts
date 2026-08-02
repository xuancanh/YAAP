/**
 * AuthStrategy — the seam that lets this app's identity model be replaced
 * without touching a controller (docs/shared-accounts.md, phase 5).
 *
 * Intentionally the same shape as `@knowledge-loom/server`'s AuthStrategy, so
 * that if yaam-chat ever joins that suite the strategy written there drops in
 * here unchanged. Today the only implementation is the shared-token guard
 * this app has always had.
 *
 * What this seam does NOT do is make the app multi-tenant. Every table here is
 * workspace-scoped with no user column, so a strategy returning per-user
 * subjects would authenticate people into the same shared data. Tenancy is a
 * migration across every table, deliberately deferred until there is a product
 * reason to pay for it — this is the cheap half: the boundary exists, is
 * swappable, and is tested, so the expensive half stays optional.
 */
import type { Request } from 'express';

export interface AuthStrategy {
  /**
   * Authenticates the request and returns the caller's id, or throws
   * UnauthorizedException. Never returns a falsy value on success.
   *
   * The returned value is the identity the app trusts. Today it is always
   * `SINGLE_USER` — see the note above on why it is not yet a per-user
   * subject.
   */
  authenticate(request: Request): string;

  /** Requests that bypass authentication entirely (liveness probes). */
  isPublic?(request: Request): boolean;
}

/** Injection token for the active strategy. */
export const AUTH_STRATEGY = 'AUTH_STRATEGY';

/** The identity every request resolves to while the app is single-user. */
export const SINGLE_USER = 'local';
