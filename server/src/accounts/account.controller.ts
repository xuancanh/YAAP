/**
 * AccountController — the signed-in account's view of itself, and the admin
 * routes behind ADMIN_EMAILS (docs/accounts.md §4–5).
 *
 *  GET   /api/account              plan, this month's usage, ceilings, keys
 *  PUT   /api/account/keys         { provider, apiKey } — BYO key for a provider
 *  GET   /api/admin/accounts       every account (admins)
 *  PATCH /api/admin/accounts/:id   { plan?, status? } (admins; the manual
 *                                  BillingProvider)
 *
 * BYO keys live on the account's own agent types (agent_types.apiKey,
 * sealed): one key store, one sealing path, and the turn loop's key
 * resolution is unchanged. `PUT /keys` sets the key on every type of that
 * provider the account has, creating a default type when it has none.
 */
import { Body, Controller, ForbiddenException, Get, Param, Patch, Put, Req } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { AccountsService } from './accounts.service';
import { AgentTypesService } from '../agent-types/agent-types.service';
import type { AuthenticatedRequest } from '../common/auth.guard';

class PutKeyDto {
  @IsString() provider!: string;
  /** Empty string removes the key. */
  @IsString() apiKey!: string;
}

class PatchAccountDto {
  @IsOptional() @IsString() plan?: string;
  @IsOptional() @IsString() status?: string;
}

/** Default model when a key arrives for a provider with no agent type yet. */
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
  deepseek: 'deepseek-chat',
  kimi: 'kimi-k2',
  glm: 'glm-4.5',
};
const PROVIDER_RE = /^[a-z][a-z0-9-]{1,30}$/;

@Controller()
export class AccountController {
  constructor(private readonly accounts: AccountsService, private readonly types: AgentTypesService) {}

  @Get('account')
  async account() {
    const summary = await this.accounts.summary();
    const types = await this.types.list();
    const providers = new Map<string, { provider: string; hasKey: boolean; types: number }>();
    for (const t of types) {
      const cur = providers.get(t.provider) ?? { provider: t.provider, hasKey: false, types: 0 };
      cur.types += 1;
      cur.hasKey = cur.hasKey || t.hasApiKey;
      providers.set(t.provider, cur);
    }
    for (const p of Object.keys(DEFAULT_MODEL)) if (!providers.has(p)) providers.set(p, { provider: p, hasKey: false, types: 0 });
    return { ...summary, keys: [...providers.values()].sort((a, b) => a.provider.localeCompare(b.provider)) };
  }

  @Put('account/keys')
  async putKey(@Body() dto: PutKeyDto) {
    if (!PROVIDER_RE.test(dto.provider) || dto.provider === 'echo') throw new ForbiddenException('unknown provider');
    const mine = (await this.types.list()).filter((t) => t.provider === dto.provider);
    if (mine.length === 0) {
      if (!dto.apiKey) return this.account();
      await this.types.create({ name: dto.provider[0].toUpperCase() + dto.provider.slice(1), provider: dto.provider, model: DEFAULT_MODEL[dto.provider] ?? '', apiKey: dto.apiKey });
    } else {
      for (const t of mine) await this.types.update(t.id, { apiKey: dto.apiKey });
    }
    return this.account();
  }

  // ---- admin ----

  private async assertAdmin() {
    const me = await this.accounts.current();
    if (!this.accounts.isAdmin(me)) throw new ForbiddenException('admin only (ADMIN_EMAILS)');
    return me;
  }

  @Get('admin/accounts')
  async list() {
    await this.assertAdmin();
    const rows = await this.accounts.listAccounts();
    return Promise.all(rows.map(async (a) => ({ ...a, usage: await this.accounts.usageThisMonth(a.id) })));
  }

  @Patch('admin/accounts/:id')
  async patch(@Param('id') id: string, @Body() dto: PatchAccountDto, @Req() req: AuthenticatedRequest) {
    const me = await this.assertAdmin();
    let row = await this.accounts.get(id);
    if (dto.plan !== undefined) row = await this.accounts.setPlan(id, dto.plan, me.email || req.userId);
    if (dto.status !== undefined) row = await this.accounts.setStatus(id, dto.status);
    return row;
  }
}
