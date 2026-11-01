/**
 * SuiteJwtStrategy — EXPERIMENTAL. The shape of the suite front door
 * (docs/shared-accounts.md phase 3) from this app's side: the accounts SPA
 * at SUITE_ACCOUNTS_URL signs the user in and hands the browser a JWT; this
 * strategy verifies it with the shared SUITE_ACCOUNTS_SECRET and treats
 * `sub` as the account id.
 *
 * Deliberately minimal: HS256 only, `exp` required, `sub` + `email`
 * required, no key rotation, no JWKS. It exists so the interface and the
 * token check are real and tested before the front door is built — the
 * production version will replace the verifier, not the seam. Bound in
 * AppModule when both SUITE_* variables are set.
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AuthStrategy, isPublicRoute } from '../common/auth-strategy.interface';
import { AccountsService } from './accounts.service';

export interface SuiteClaims { sub: string; email: string; exp: number; iat?: number; iss?: string }

/** Verify an HS256 JWT. Exported for tests and for minting fixtures. */
export function verifySuiteJwt(token: string, secret: string, now: Date = new Date()): SuiteClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('malformed token');
  const [h, p, s] = parts;
  let header: { alg?: string; typ?: string };
  let claims: Partial<SuiteClaims>;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Partial<SuiteClaims>;
  } catch {
    throw new UnauthorizedException('malformed token');
  }
  if (header.alg !== 'HS256') throw new UnauthorizedException('unsupported token algorithm');
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedException('bad token signature');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) throw new UnauthorizedException('token expired');
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string') throw new UnauthorizedException('token lacks sub/email');
  return claims as SuiteClaims;
}

/** Mint a token the strategy accepts (tests; the real issuer is the suite). */
export function signSuiteJwt(claims: SuiteClaims, secret: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

@Injectable()
export class SuiteJwtStrategy implements AuthStrategy {
  constructor(private readonly accounts: AccountsService, private readonly config: ConfigService) {}

  isPublic(request: Request): boolean {
    return isPublicRoute(request);
  }

  async authenticate(request: Request): Promise<string> {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException('suite token required');
    const secret = this.config.get<string>('suiteAccountsSecret') ?? '';
    if (!secret) throw new UnauthorizedException('suite auth is not configured');
    const claims = verifySuiteJwt(header.slice(7), secret);
    const account = await this.accounts.ensureFromSuite(claims.sub, claims.email);
    return account.id;
  }
}
