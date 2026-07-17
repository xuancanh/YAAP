/**
 * SkillsService — local skills (§10): named instruction packs a chat can load.
 * Skills are offered to the model as tools named skill_<name> (FR-10.2);
 * invoking one returns its instruction body for the model to follow. Global
 * skills (workspaceId null) are visible everywhere; workspace skills only in
 * their workspace (FR-10.1). Built-ins are seeded on boot: recreated when
 * missing, but user edits to them stick (matched by name).
 */
import { Injectable, Inject, NotFoundException, OnModuleInit, ConflictException } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { skills } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { AiToolSpec } from '../ai/ai-provider.interface';
import { BUILTIN_SKILLS } from './builtin-skills';

export type SkillRow = typeof skills.$inferSelect;

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SKILL_TOOL_PREFIX = 'skill_';

@Injectable()
export class SkillsService implements OnModuleInit {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async onModuleInit(): Promise<void> {
    await this.seedBuiltins();
  }

  async seedBuiltins(): Promise<void> {
    for (const b of BUILTIN_SKILLS) {
      const existing = await this.db.select({ id: skills.id }).from(skills)
        .where(and(isNull(skills.workspaceId), eq(skills.name, b.name))).limit(1);
      if (existing.length > 0) continue;
      await this.db.insert(skills).values({
        id: newId(), workspaceId: null, name: b.name, description: b.description,
        instructions: b.instructions, enabled: 1, builtin: 1, createdAt: nowIso(),
      });
    }
  }

  /** All skills visible to a workspace (global + workspace-scoped). */
  async list(workspaceId?: string): Promise<SkillRow[]> {
    const scope = workspaceId
      ? or(isNull(skills.workspaceId), eq(skills.workspaceId, workspaceId))
      : isNull(skills.workspaceId);
    return this.db.select().from(skills).where(scope);
  }

  async get(id: string): Promise<SkillRow> {
    const rows = await this.db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`skill ${id}`);
    return rows[0];
  }

  async create(input: { name: string; description?: string; instructions: string; workspaceId?: string }): Promise<SkillRow> {
    if (!NAME_RE.test(input.name)) {
      throw new ConflictException('skill name must be a lowercase slug (a-z, 0-9, dashes)');
    }
    const row: SkillRow = {
      id: newId(),
      workspaceId: input.workspaceId ?? null,
      name: input.name,
      description: input.description ?? '',
      instructions: input.instructions,
      enabled: 1,
      builtin: 0,
      createdAt: nowIso(),
    };
    await this.db.insert(skills).values(row);
    return row;
  }

  async update(id: string, patch: Partial<{ description: string; instructions: string; enabled: boolean }>): Promise<SkillRow> {
    await this.get(id);
    const set: Record<string, unknown> = { ...patch };
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    await this.db.update(skills).set(set).where(eq(skills.id, id));
    return this.get(id);
  }

  async remove(id: string): Promise<{ ok: boolean }> {
    await this.db.delete(skills).where(eq(skills.id, id));
    return { ok: true };
  }

  // ---- turn-loop integration (FR-10.2) ----

  /** Enabled skills of a workspace as tool specs for the provider request. */
  async toolSpecs(workspaceId: string): Promise<AiToolSpec[]> {
    const rows = await this.list(workspaceId);
    return rows.filter((s) => s.enabled === 1).map((s) => ({
      name: SKILL_TOOL_PREFIX + s.name.replace(/-/g, '_'),
      description: `Skill: ${s.description || s.name}. Call with no arguments to load its step-by-step instructions, then follow them.`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  /** True when a tool name addresses a skill visible to the workspace. */
  async resolveTool(workspaceId: string, toolName: string): Promise<SkillRow | undefined> {
    if (!toolName.startsWith(SKILL_TOOL_PREFIX)) return undefined;
    const slug = toolName.slice(SKILL_TOOL_PREFIX.length).replace(/_/g, '-');
    const rows = await this.list(workspaceId);
    return rows.find((s) => s.name === slug && s.enabled === 1);
  }

  /** Invoking a skill returns its instruction body to the model. */
  invocation(skill: SkillRow): string {
    return `Skill "${skill.name}" loaded. Follow these instructions now:\n\n${skill.instructions}`;
  }
}
