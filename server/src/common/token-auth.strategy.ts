/**
 * TokenAuthStrategy — the shared-bearer-token identity this app has always
 * had, now behind the AuthStrategy seam.
 *
 * A pragmatic trust boundary for a single-user self-hosted app: the API has
 * no users, but any website open in the user's browser could otherwise call
 * it cross-origin and spend LLM keys. When YAAM_API_TOKEN is unset every
 * request passes (single-user localhost default; AppModule logs a boot
 * warning). GET /api/status stays open so liveness probes work without
 * credentials.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthStrategy, SINGLE_USER } from './auth-strategy.interface';

@Injectable()
export class TokenAuthStrategy implements AuthStrategy {
  constructor(private readonly config: ConfigService) {}

  isPublic(request: Request): boolean {
    return request.method === 'GET' && request.path === '/api/status';
  }

  authenticate(request: Request): string {
    const token = this.config.get<string>('apiToken');
    if (!token) return SINGLE_USER;
    if (request.headers.authorization === `Bearer ${token}`) return SINGLE_USER;
    throw new UnauthorizedException('missing or invalid bearer token');
  }
}
