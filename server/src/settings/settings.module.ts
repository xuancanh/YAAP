/**
 * SettingsModule — app-wide key/value settings used by the UI: default
 * permission mode for new chats, default agent type, default token ceiling,
 * and the compaction threshold display value.
 */
import { Module } from '@nestjs/common';
import { Body, Controller, Get, Inject, Injectable, Put } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { appSettings } from '../database/schema';

const ALLOWED_KEYS = new Set([
  'defaultPermissionMode', 'defaultAgentTypeId', 'defaultTokenCeiling', 'compactionThresholdTokens', 'compactionThresholdPct', 'autoCompact', 'theme',
  // Telegram channel (roadmap phase 4): the paired chat and its target agent
  'telegramChatId', 'telegramDefaultAgentId',
  // Email channel (docs/channels.md): paired owner addresses (JSON array),
  // the inbox digest mode immediate | daily | off, its hour (0-23) and the
  // last day a daily digest went out
  'emailOwnerAddresses', 'emailDigest', 'emailDigestHour', 'emailDigestLastDate',
  // Cost dashboard (roadmap phase 2.5): JSON { "<model>": { input, output } } USD/M tokens over ai/pricing.ts
  'pricingOverrides',
  // Independent action reviewer (docs/permissions.md §6): 'on' | 'off', and a model override
  'actionReview', 'reviewModel',
  // Voice notes (docs/voice.md): read replies aloud ('on' | 'off', default off) and the TTS voice name
  'ttsEnabled', 'ttsVoice',
  // Group chat (docs/group-chat.md §2): the workspace default daily token
  // budget for agent replies per channel (a channel's own value overrides;
  // '0' = unlimited; unset = 200000).
  'channelDailyTokenBudget',
  // Blueprints (docs/blueprints.md §4): share anonymous outcome milestones of
  // companies imported from a registry blueprint ('on' | 'off', default off).
  'shareBlueprintOutcomes',
]);

/** Prefixes of internal rows (see SettingsService.getInternal). */
const INTERNAL_PREFIXES = ['harness.'];
function assertInternal(key: string): void {
  if (!INTERNAL_PREFIXES.some((p) => key.startsWith(p))) throw new Error(`not an internal settings key: ${key}`);
}

@Injectable()
export class SettingsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(appSettings);
    // `home.*` rows are per-person bookkeeping (Home's last visit, docs/home.md),
    // and `harness.*` rows hold sealed secrets served redacted by their own
    // API (docs/coding-harnesses.md) — neither is a plain setting.
    return Object.fromEntries(rows.filter((r) => !r.key.startsWith('home.') && !INTERNAL_PREFIXES.some((p) => r.key.startsWith(p))).map((r) => [r.key, r.value]));
  }

  /** An internal row (a module's own JSON, e.g. `harness.config`): never
   *  in `all()` or writable through PUT /settings. */
  async getInternal(key: string): Promise<string | null> {
    assertInternal(key);
    const row = (await this.db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1))[0];
    return row?.value ?? null;
  }

  async putInternal(key: string, value: string): Promise<void> {
    assertInternal(key);
    await this.upsert(key, value);
  }

  private async upsert(key: string, value: string): Promise<void> {
    const existing = await this.db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
    if (existing.length > 0) {
      await this.db.update(appSettings).set({ value }).where(eq(appSettings.key, key));
    } else {
      await this.db.insert(appSettings).values({ key, value });
    }
  }

  async put(patch: Record<string, string>): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.has(key) || typeof value !== 'string') continue;
      await this.upsert(key, value);
    }
    return this.all();
  }
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() all() { return this.settings.all(); }
  @Put() put(@Body() body: Record<string, string>) { return this.settings.put(body); }
}

@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
