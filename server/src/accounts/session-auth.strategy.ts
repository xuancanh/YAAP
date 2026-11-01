/**
 * SessionAuthStrategy — AUTH_MODE=accounts. The caller is whoever holds a
 * live session cookie (`yaam_session`, HttpOnly, SameSite=Lax), minted by
 * the magic-link callback (auth.controller.ts) and looked up by hash in
 * `account_sessions`. The identity returned is the account id, which the
 * guard binds as the tenant for the request.
 *
 * Why a cookie and not a bearer: the browser carries it on the OAuth
 * callback redirects (connections) and on SSE fetches without any client
 * code, and HttpOnly keeps it out of reach of anything injected into a mini
 * app or preview. YAAM_API_TOKEN is still honoured as a bearer for scripts,
 * resolving to the single account's data (an operator escape hatch, not a
 * user credential).
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthStrategy, SINGLE_USER, isPublicRoute } from '../common/auth-strategy.interface';
import { AccountsService, SESSION_COOKIE } from './accounts.service';

/** Minimal cookie read — one header, no dependency. */
export function readCookie(request: Pick<Request, 'headers'>, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

@Injectable()
export class SessionAuthStrategy implements AuthStrategy {
  constructor(private readonly accounts: AccountsService, private readonly config: ConfigService) {}

  isPublic(request: Request): boolean {
    return isPublicRoute(request);
  }

  async authenticate(request: Request): Promise<string> {
    const account = await this.accounts.resolveSession(readCookie(request, SESSION_COOKIE));
    if (account) return account.id;
    const token = this.config.get<string>('apiToken');
    if (token && request.headers.authorization === `Bearer ${token}`) return SINGLE_USER;
    throw new UnauthorizedException('sign in required');
  }
}
