/**
 * TokenAuthStrategy — the shared-bearer-token identity this app has always
 * had, now behind the AuthStrategy seam. Bound when AUTH_MODE=single.
 *
 * A pragmatic trust boundary for a single-user self-hosted app: the API has
 * no users, but any website open in the user's browser could otherwise call
 * it cross-origin and spend LLM keys. When YAAM_API_TOKEN is unset every
 * request passes (single-user localhost default; AppModule logs a boot
 * warning). The open routes are listed in isPublicRoute (auth-strategy
 * .interface.ts), shared with every strategy: liveness, the security policy,
 * the public registry feed, the HMAC-signed inbound mail webhook, the
 * secret-bearing loop webhooks, the sign-in routes (which answer "single
 * mode" here), and the desktop companion's four routes.
 *
 * That last set is a second bearer kind for exactly four paths: the companion
 * (docs/computer-control.md) redeems a pairing code on POST /api/computer/pair
 * and then speaks its own token to /work, /result/:id and /heartbeat, checked
 * by `computer/companion.guard.ts`. Those paths — and only those — are public
 * to the app token so the companion guard can take over; the user routes
 * under /api/computer stay behind the app token.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthStrategy, SINGLE_USER, isPublicRoute } from './auth-strategy.interface';

export { isCompanionRoute } from './auth-strategy.interface';

@Injectable()
export class TokenAuthStrategy implements AuthStrategy {
  constructor(private readonly config: ConfigService) {}

  isPublic(request: Request): boolean {
    return isPublicRoute(request);
  }

  authenticate(request: Request): string {
    const token = this.config.get<string>('apiToken');
    if (!token) return SINGLE_USER;
    if (request.headers.authorization === `Bearer ${token}`) return SINGLE_USER;
    throw new UnauthorizedException('missing or invalid bearer token');
  }
}
