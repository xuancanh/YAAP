/**
 * SkillsService — local skills (§10): named instruction packs a chat can load.
 * Skills are offered to the model as tools named skill_<name> (FR-10.2);
 * invoking one returns its instruction body for the model to follow. Global
 * skills (workspaceId null) are visible everywhere; workspace skills only in
 * their workspace (FR-10.1). Built-ins are seeded on boot: recreated when
 * missing, but user edits to them stick (matched by name).
 */
import { Injectable, Inject, NotFoundException, OnModuleInit, ConflictException, BadRequestException, Optional } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { currentAccountId } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { skills, skillOutcomes } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { AiToolSpec } from '../ai/ai-provider.interface';
import { BUILTIN_SKILLS } from './builtin-skills';
import { parseSkillMd, renderSkillMd, scanSkillMd, ScanReport, SKILL_MD_SIZE_CAP } from '../portability/skill-md';

export type SkillRow = typeof skills.$inferSelect;

/** A revision the agent proposed after a 👎 on a turn that used the skill
 *  (revise_skill). Parked until the user accepts or rejects it on the Skills
 *  page, where it renders as a diff against the live instructions. */
export interface PendingRevision {
  instructions: string;
  reason: string;
  proposedAt: string;
  proposedBy: string;
}

export interface SkillHistoryEntry {
  instructions: string;
  replacedAt: string;
  reason: string;
}

const HISTORY_KEEP = 5;

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const SKILL_TOOL_PREFIX = 'skill_';

@Injectable()
export class SkillsService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    /** Optional so test constructors keep working. With it, every account
     *  gets its own built-ins the first time it signs in. */
    @Optional() accounts?: AccountsService,
  ) {
    accounts?.onAccountActivated(() => this.seedBuiltins());
  }

  /** Boot seeds the single account (the context default); other accounts
   *  are seeded by the activation hook under their own context. */
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
        scanReport: '', useCount: 0, upCount: 0, downCount: 0, lastUsedAt: null, pendingRevision: '', history: '[]',
      });
    }
  }

  /** Skills visible in a scope: global + workspace-scoped, plus one agent's
   *  private self-built skills when agentId is given. Agent-owned skills are
   *  never visible outside their agent. */
  async list(workspaceId?: string, agentId?: string): Promise<SkillRow[]> {
    const shared = workspaceId
      ? or(isNull(skills.workspaceId), eq(skills.workspaceId, workspaceId))
      : isNull(skills.workspaceId);
    const rows = await this.db.select().from(skills)
      .where(agentId ? or(and(shared, isNull(skills.agentId)), eq(skills.agentId, agentId)) : and(shared, isNull(skills.agentId)));
    return rows;
  }

  async get(id: string): Promise<SkillRow> {
    const rows = await this.db.select().from(skills).where(eq(skills.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`skill ${id}`);
    return rows[0];
  }

  async create(input: { name: string; description?: string; instructions: string; workspaceId?: string; draft?: boolean; proposedBy?: string; agentId?: string; scanReport?: ScanReport; audience?: string[]; source?: string }): Promise<SkillRow> {
    if (!NAME_RE.test(input.name)) {
      throw new ConflictException('skill name must be a lowercase slug (a-z, 0-9, dashes)');
    }
    if ((await this.list(input.workspaceId, input.agentId)).some((s) => s.name === input.name)) {
      throw new ConflictException(`a skill named "${input.name}" already exists`);
    }
    const row: SkillRow = {
      accountId: currentAccountId(),
      id: newId(),
      workspaceId: input.workspaceId ?? null,
      name: input.name,
      description: input.description ?? '',
      instructions: input.instructions,
      // drafts are parked until the user approves them (phase 3)
      enabled: input.draft ? 0 : 1,
      builtin: 0,
      draft: input.draft ? 1 : 0,
      proposedBy: input.proposedBy ?? '',
      agentId: input.agentId ?? null,
      scanReport: input.scanReport ? JSON.stringify(input.scanReport) : '',
      useCount: 0, upCount: 0, downCount: 0, lastUsedAt: null,
      pendingRevision: '', history: '[]',
      createdAt: nowIso(),
      audience: input.audience?.length ? JSON.stringify(input.audience) : '',
      source: input.source ?? '',
    };
    await this.db.insert(skills).values(row);
    return row;
  }

  // ---- contributed skills (docs/plugins.md §3.8): a plugin's or kit's skill files ----

  /** Who sees an audienced skill; set by the org module (chief, heads, members, function:<fn>). */
  private audienceFilter: ((workspaceId: string, agentId: string | undefined, audience: string[]) => Promise<boolean>) | null = null;
  setAudienceFilter(fn: (workspaceId: string, agentId: string | undefined, audience: string[]) => Promise<boolean>): void { this.audienceFilter = fn; }

  /** Whether a skill reaches this agent: no audience, `all`, or the filter says so (deny when it cannot tell). */
  private async reaches(s: SkillRow, workspaceId: string, agentId?: string): Promise<boolean> {
    const aud = parseAudience(s.audience);
    if (aud.length === 0 || aud.includes('all')) return true;
    if (!this.audienceFilter) return false;
    return this.audienceFilter(workspaceId, agentId, aud).catch(() => false);
  }

  /**
   * Write a contributed skill: a new workspace skill, or the same-named one
   * from an earlier install of the same source brought back with the new
   * text. Live unless `draft` (non-first-party sources land as drafts).
   */
  async contribute(input: { workspaceId: string; name: string; description: string; instructions: string; audience: string[]; source: string; draft: boolean }): Promise<SkillRow> {
    if (!NAME_RE.test(input.name)) throw new BadRequestException(`skill name ${input.name} must be a lowercase slug`);
    const existing = (await this.db.select().from(skills).where(and(eq(skills.workspaceId, input.workspaceId), eq(skills.name, input.name), isNull(skills.agentId)))).at(0);
    if (existing) {
      if (existing.source !== input.source) throw new ConflictException(`a skill named "${input.name}" already exists and was not contributed by ${input.source}`);
      await this.db.update(skills).set({ description: input.description, instructions: input.instructions, audience: JSON.stringify(input.audience), enabled: input.draft ? 0 : 1, draft: input.draft ? 1 : 0 }).where(eq(skills.id, existing.id));
      return this.get(existing.id);
    }
    return this.create({ name: input.name, description: input.description, instructions: input.instructions, workspaceId: input.workspaceId, draft: input.draft, proposedBy: input.source, audience: input.audience, source: input.source });
  }

  /** Archive (never delete) a contributed skill: it stops being offered; its history and outcomes stay. */
  async setContributedEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.update(skills).set({ enabled: enabled ? 1 : 0 }).where(eq(skills.id, id));
  }

  // ---- agentskills.io SKILL.md (execution-plan item 9.3) ----

  /**
   * Import one SKILL.md. Parse → scan → draft. A blocking flag (oversize,
   * invisible unicode, empty body) refuses the import outright; warnings
   * travel with the row as `scanReport` so the review card can show them
   * beside the body. Imported skills are always drafts: the open standard
   * says what a skill *is*, not whether this user wants it.
   */
  async importSkillMd(input: { content: string; workspaceId?: string; agentId?: string; proposedBy?: string }): Promise<{ skill: SkillRow; scan: ScanReport }> {
    if (typeof input.content !== 'string' || !input.content.trim()) throw new BadRequestException('SKILL.md content is required');
    if (Buffer.byteLength(input.content, 'utf8') > SKILL_MD_SIZE_CAP * 4) {
      // the scan reports the cap; this only stops a multi-megabyte paste from being parsed at all
      throw new BadRequestException(`SKILL.md exceeds ${SKILL_MD_SIZE_CAP} bytes`);
    }
    let parsed;
    try { parsed = parseSkillMd(input.content); } catch (err) {
      throw new BadRequestException(`invalid SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
    }
    const scan = scanSkillMd(input.content, parsed);
    if (!scan.ok) {
      throw new BadRequestException(`SKILL.md refused: ${scan.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}`);
    }
    const skill = await this.create({
      name: parsed.name,
      description: parsed.description.slice(0, 300),
      instructions: parsed.body.slice(0, 20_000),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      draft: true,
      proposedBy: input.proposedBy ?? (parsed.metadata.author ? `import: ${parsed.metadata.author}` : 'import'),
      scanReport: scan,
    });
    return { skill, scan };
  }

  /** Export one skill as a spec-conformant SKILL.md. */
  async exportSkillMd(id: string): Promise<string> {
    const s = await this.get(id);
    return renderSkillMd({ name: s.name, description: s.description, instructions: s.instructions, proposedBy: s.proposedBy, createdAt: s.createdAt });
  }

  // ---- outcome tracking (execution-plan item 10) ----

  /** A turn loaded these skills: bump useCount and lastUsedAt. */
  async recordUse(skillIds: string[]): Promise<void> {
    const ids = [...new Set(skillIds)];
    if (ids.length === 0) return;
    await this.db.update(skills)
      .set({ useCount: sql`${skills.useCount} + 1`, lastUsedAt: nowIso() })
      .where(inArray(skills.id, ids));
  }

  /**
   * A rated turn had loaded these skills: one outcome row per (skill, turn),
   * re-rating replaces instead of doubling, and the aggregate counters on the
   * skill follow. Returns the skills touched so the caller can name them in
   * the agent's pending feedback.
   */
  async recordOutcome(skillIds: string[], turnId: string, rating: 'up' | 'down', note?: string): Promise<SkillRow[]> {
    const ids = [...new Set(skillIds)];
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(skills).where(inArray(skills.id, ids));
    for (const s of rows) {
      const prev = (await this.db.select().from(skillOutcomes)
        .where(and(eq(skillOutcomes.skillId, s.id), eq(skillOutcomes.turnId, turnId))).limit(1))[0];
      if (prev && prev.rating === rating) {
        await this.db.update(skillOutcomes).set({ note: note ?? prev.note }).where(eq(skillOutcomes.id, prev.id));
        continue;
      }
      if (prev) {
        await this.db.update(skillOutcomes).set({ rating, note: note ?? '' }).where(eq(skillOutcomes.id, prev.id));
      } else {
        await this.db.insert(skillOutcomes).values({ id: newId(), skillId: s.id, turnId, rating, note: note ?? '', createdAt: nowIso() });
      }
      const up = (rating === 'up' ? 1 : 0) - (prev?.rating === 'up' ? 1 : 0);
      const down = (rating === 'down' ? 1 : 0) - (prev?.rating === 'down' ? 1 : 0);
      await this.db.update(skills).set({
        upCount: sql`GREATEST(0, ${skills.upCount} + ${up})`,
        downCount: sql`GREATEST(0, ${skills.downCount} + ${down})`,
      }).where(eq(skills.id, s.id));
    }
    return this.db.select().from(skills).where(inArray(skills.id, ids));
  }

  async outcomes(skillId: string) {
    return this.db.select().from(skillOutcomes).where(eq(skillOutcomes.skillId, skillId));
  }

  /**
   * revise_skill: the agent, told on its next turn that a 👎 landed on a
   * turn which used this skill, proposes new instructions. Parked as a
   * pending revision — the live text is untouched until the user accepts the
   * diff. One pending revision per skill; a newer proposal replaces it.
   * Scope is enforced here: an agent may only revise skills it can see.
   */
  async proposeRevision(input: { skillId: string; instructions: string; reason: string; workspaceId: string; agentId?: string; proposedBy: string }): Promise<string> {
    const visible = await this.list(input.workspaceId, input.agentId);
    const key = (input.skillId ?? '').trim();
    const skill = key ? visible.find((s) => s.id === key || s.name === key || (key.length >= 8 && s.id.startsWith(key))) : undefined;
    if (!skill) throw new Error(`unknown skill "${key}" — use the skill's name or id`);
    if (skill.draft === 1) throw new Error('that skill is still a draft; the user has not approved it yet');
    const instructions = (input.instructions ?? '').trim().slice(0, 20_000);
    if (!instructions) throw new Error('revised instructions are required');
    if (instructions === skill.instructions.trim()) return 'The proposed instructions are identical to the current ones; nothing to revise.';
    const rev: PendingRevision = {
      instructions,
      reason: (input.reason ?? '').trim().slice(0, 1_000),
      proposedAt: nowIso(),
      proposedBy: input.proposedBy,
    };
    await this.db.update(skills).set({ pendingRevision: JSON.stringify(rev) }).where(eq(skills.id, skill.id));
    return `Revision of "${skill.name}" proposed. The user sees it as a diff on the Skills page and decides; keep following the current instructions until they accept it.`;
  }

  /** Accept: the revision becomes the instructions and the old text goes to
   *  history (last 5). Reject: the revision is dropped. */
  async resolveRevision(id: string, accept: boolean): Promise<SkillRow> {
    const skill = await this.get(id);
    const rev = parseRevision(skill.pendingRevision);
    if (!rev) throw new ConflictException('no pending revision');
    if (!accept) {
      await this.db.update(skills).set({ pendingRevision: '' }).where(eq(skills.id, id));
      return this.get(id);
    }
    const history = parseHistory(skill.history);
    history.unshift({ instructions: skill.instructions, replacedAt: nowIso(), reason: rev.reason });
    await this.db.update(skills).set({
      instructions: rev.instructions,
      pendingRevision: '',
      history: JSON.stringify(history.slice(0, HISTORY_KEEP)),
    }).where(eq(skills.id, id));
    return this.get(id);
  }

  /** Agent-drafted skill from experience (draft_skill tool). The draft is
   *  invisible to the model until the user approves it. */
  async draftSkill(input: { name: string; description?: string; instructions: string; workspaceId: string; proposedBy: string; agentId?: string }): Promise<string> {
    const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!NAME_RE.test(name)) throw new Error('could not derive a valid slug from that skill name');
    if (!input.instructions?.trim()) throw new Error('skill instructions are required');
    const drafts = (await this.list(input.workspaceId, input.agentId)).filter((s) => s.draft === 1);
    if (drafts.length >= 10) return 'Draft queue is full; the user has pending skill drafts to review first.';
    await this.create({
      name,
      description: (input.description ?? '').slice(0, 300),
      instructions: input.instructions.slice(0, 20_000),
      workspaceId: input.workspaceId,
      draft: true,
      proposedBy: input.proposedBy,
      // self-built skills are private to their agent
      agentId: input.agentId,
    });
    return `Skill "${name}" drafted. The user reviews and approves it before it becomes available; do not assume you can call it yet.`;
  }

  /** Promotion (permissions §5): an agent-private skill becomes shared —
   *  workspace-shared when a target workspace is given, else it keeps its
   *  stored scope. Widening blast radius requires the user's re-review of the
   *  full instructions client-side; here we enforce the scope rules. */
  async promote(id: string, workspaceId?: string): Promise<SkillRow> {
    const skill = await this.get(id);
    if (!skill.agentId) throw new ConflictException('skill is already shared');
    if (skill.draft === 1) throw new ConflictException('approve the draft before promoting it');
    const target = workspaceId ?? skill.workspaceId ?? undefined;
    if ((await this.list(target)).some((s) => s.name === skill.name)) {
      throw new ConflictException(`a shared skill named "${skill.name}" already exists in that scope`);
    }
    await this.db.update(skills).set({ agentId: null, workspaceId: target ?? null }).where(eq(skills.id, id));
    return this.get(id);
  }

  /** User approval: the draft becomes a live skill. Rejection deletes it. */
  async resolveDraft(id: string, approve: boolean): Promise<SkillRow | { ok: boolean }> {
    const skill = await this.get(id);
    if (skill.draft !== 1) throw new ConflictException('not a draft');
    if (!approve) return this.remove(id);
    await this.db.update(skills).set({ draft: 0, enabled: 1 }).where(eq(skills.id, id));
    return this.get(id);
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
  async toolSpecs(workspaceId: string, agentId?: string): Promise<AiToolSpec[]> {
    const rows: SkillRow[] = [];
    for (const s of await this.list(workspaceId, agentId)) if (s.enabled === 1 && s.draft !== 1 && await this.reaches(s, workspaceId, agentId)) rows.push(s);
    return rows.map((s) => ({
      name: SKILL_TOOL_PREFIX + s.name.replace(/-/g, '_'),
      description: `Skill: ${s.description || s.name}. Call with no arguments to load its step-by-step instructions, then follow them.`,
      inputSchema: { type: 'object', properties: {} },
    }));
  }

  /** True when a tool name addresses a skill visible to the workspace. */
  async resolveTool(workspaceId: string, toolName: string, agentId?: string): Promise<SkillRow | undefined> {
    if (!toolName.startsWith(SKILL_TOOL_PREFIX)) return undefined;
    const slug = toolName.slice(SKILL_TOOL_PREFIX.length).replace(/_/g, '-');
    const rows = await this.list(workspaceId, agentId);
    const hit = rows.find((s) => s.name === slug && s.enabled === 1 && s.draft !== 1);
    return hit && await this.reaches(hit, workspaceId, agentId) ? hit : undefined;
  }

  /** Invoking a skill returns its instruction body to the model. */
  invocation(skill: SkillRow): string {
    return `Skill "${skill.name}" loaded. Follow these instructions now:\n\n${skill.instructions}`;
  }
}

/** A contributed skill's audience list; [] = everyone. */
export function parseAudience(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

export function parseRevision(raw: string): PendingRevision | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingRevision; } catch { return null; }
}

function parseHistory(raw: string): SkillHistoryEntry[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? (v as SkillHistoryEntry[]) : []; } catch { return []; }
}
