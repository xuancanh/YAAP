/**
 * TokenAuthStrategy — the shared-bearer-token identity this app has always
 * had, now behind the AuthStrategy seam.
 *
 * A pragmatic trust boundary for a single-user self-hosted app: the API has
 * no users, but any website open in the user's browser could otherwise call
 * it cross-origin and spend LLM keys. When YAAM_API_TOKEN is unset every
 * request passes (single-user localhost default; AppModule logs a boot
 * warning). GET /api/status stays open so liveness probes work without
 * credentials, GET /api/security so the disclosure policy is readable
 * without one, and POST /api/channels/email/inbound which carries its own
 * HMAC signature instead.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthStrategy, SINGLE_USER } from './auth-strategy.interface';

@Injectable()
export class TokenAuthStrategy implements AuthStrategy {
  constructor(private readonly config: ConfigService) {}

  isPublic(request: Request): boolean {
    if (request.method === 'GET') return request.path === '/api/status' || request.path === '/api/security';
    // The inbound-mail webhook authenticates itself with an HMAC over the
    // body (channels/email.service.ts verifySignature), not the bearer token
    // — the forwarder is a Cloudflare Worker, not the user's browser.
    return request.method === 'POST' && request.path === '/api/channels/email/inbound';
  }

  authenticate(request: Request): string {
    const token = this.config.get<string>('apiToken');
    if (!token) return SINGLE_USER;
    if (request.headers.authorization === `Bearer ${token}`) return SINGLE_USER;
    throw new UnauthorizedException('missing or invalid bearer token');
  }
}
