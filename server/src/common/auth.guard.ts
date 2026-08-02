/**
 * Optional bearer-token guard (YAAM_API_TOKEN). A pragmatic trust boundary for
 * a single-user self-hosted app: the API has no users, but any website open in
 * the user's browser could otherwise call it cross-origin and spend LLM keys.
 *
 * When the token is unset every request passes (single-user localhost default;
 * AppModule logs a boot warning). GET /api/status always stays open so
 * liveness probes work without credentials.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('apiToken');
    if (!token) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' && req.path === '/api/status') return true;
    if (req.headers.authorization === `Bearer ${token}`) return true;
    throw new UnauthorizedException('missing or invalid bearer token');
  }
}
