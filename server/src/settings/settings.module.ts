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
  'defaultPermissionMode', 'defaultAgentTypeId', 'defaultTokenCeiling', 'compactionThresholdTokens', 'theme',
  // Telegram channel (roadmap phase 4): the paired chat and its target agent
  'telegramChatId', 'telegramDefaultAgentId',
]);

@Injectable()
export class SettingsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async all(): Promise<Record<string, string>> {
    const rows = await this.db.select().from(appSettings);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async put(patch: Record<string, string>): Promise<Record<string, string>> {
    for (const [key, value] of Object.entries(patch)) {
      if (!ALLOWED_KEYS.has(key) || typeof value !== 'string') continue;
      const existing = await this.db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
      if (existing.length > 0) {
        await this.db.update(appSettings).set({ value }).where(eq(appSettings.key, key));
      } else {
        await this.db.insert(appSettings).values({ key, value });
      }
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
