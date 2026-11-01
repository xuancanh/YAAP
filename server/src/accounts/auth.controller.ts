/**
 * AuthController — the magic-link flow (docs/accounts.md §2). All four routes
 * are public (isPublicRoute); each decides for itself.
 *
 *  POST /api/auth/request-link  { email }      → { ok, sent }   (429 when rate-limited)
 *  GET  /api/auth/callback?token=…             → Set-Cookie + 302 to the app
 *  GET  /api/auth/me                           → { mode, authenticated, account? }
 *  POST /api/auth/logout                       → clears the cookie
 *
 * In AUTH_MODE=single `me` says so and the others answer 403: the SPA renders
 * no sign-in and the Account pane reads "Single-user mode".
 */
import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { AccountsService, SESSION_COOKIE } from './accounts.service';
import { readCookie } from './session-auth.strategy';
import { SINGLE_ACCOUNT, runWithAccount } from './account-context';

class RequestLinkDto {
  @IsString() email!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly accounts: AccountsService, private readonly config: ConfigService) {}

  private cookieAttrs(maxAgeSeconds: number): string {
    const appUrl = this.config.get<string>('publicAppUrl') ?? '';
    const secure = appUrl.startsWith('https://') ? '; Secure' : '';
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  @Post('request-link')
  @HttpCode(200)
  requestLink(@Body() dto: RequestLinkDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip || '';
    return this.accounts.requestLink(dto.email, { ip });
  }

  @Get('callback')
  async callback(@Query('token') token: string | undefined, @Req() req: Request, @Res() res: Response) {
    const appUrl = (this.config.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
    try {
      const session = await this.accounts.consumeLink(token ?? '', String(req.headers['user-agent'] ?? ''));
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(session.sessionToken)}; ${this.cookieAttrs(Math.floor(this.accounts.sessionTtlMs() / 1000))}`);
      res.redirect(302, `${appUrl}/`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'sign-in failed';
      res.status(401).type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>Sign-in link</title><body style="font-family:system-ui;padding:40px;text-align:center"><h3>That link did not work</h3><p>${message.replace(/[<>&]/g, '')}</p><p><a href="${appUrl}/">Request a new one</a></p></body>`,
      );
    }
  }

  @Get('me')
  async me(@Req() req: Request) {
    if (this.accounts.mode === 'single') {
      const account = await runWithAccount(SINGLE_ACCOUNT, () => this.accounts.summary());
      return { mode: 'single' as const, authenticated: true, account };
    }
    const session = await this.accounts.resolveSession(readCookie(req, SESSION_COOKIE));
    if (!session) return { mode: 'accounts' as const, authenticated: false };
    const account = await runWithAccount(session.id, () => this.accounts.summary());
    return { mode: 'accounts' as const, authenticated: true, account };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (this.accounts.mode === 'single') throw new ForbiddenException('AUTH_MODE=single: nothing to sign out of');
    await this.accounts.revokeSession(readCookie(req, SESSION_COOKIE));
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${this.cookieAttrs(0)}`);
    return { ok: true };
  }
}
