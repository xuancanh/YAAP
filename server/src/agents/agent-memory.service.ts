/**
 * AgentMemoryService — what a durable agent has learned (docs/agent-memory.md).
 *
 * The pipeline that produced lessons was already good; what was missing was
 * the other half of the loop. Lessons were appended to LESSONS.md and read by
 * nothing, so an agent with six months of accumulated memory behaved exactly
 * like one with none. This service owns the store that fixes that:
 *
 *  - **provenance** on every lesson, so untrusted surfaces (mini apps,
 *    channels) can teach *proposals* and never instructions. This had to come
 *    before injection, not after: while nothing read LESSONS.md, an app
 *    distilling into it was harmless; the moment the digest reaches the
 *    prompt, that same path is brain poisoning with a slow fuse;
 *  - **dedup on write**, so the same lesson learned five times is one row
 *    with useCount 5 rather than five entries competing for the budget;
 *  - **a bounded digest** for the system prompt, ranked and character-capped
 *    like the profile beside it;
 *  - **consolidation**, trimming by value instead of by age — the old
 *    byte-cap tail-trim dropped the best lesson an agent ever learned as soon
 *    as it got old enough.
 *
 * LESSONS.md is regenerated from these rows on every write. The transparent
 * file brain is a product promise (FR-11.3) and users should keep being able
 * to read and hand-edit it; it just stops being the source of truth for
 * machine reads, which is what makes any of the above possible.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentLessons, agents } from '../database/schema';
import { StorageService } from '../storage/storage.service';
import { ensureAgentHome, homeKey } from '../files/agent-home';

/** Where a lesson was learned. Trust follows the surface, never the text. */
export type LessonSource = 'chat' | 'loop' | 'channel' | 'app' | 'feedback' | 'import';
export const LESSON_SOURCES: readonly LessonSource[] = ['chat', 'loop', 'channel', 'app', 'feedback', 'import'];

/** Surfaces whose conclusions may enter the prompt without a human. `app`
 *  and `channel` are the ones the permission model already treats as
 *  untrusted input; a lesson is an instruction that outlives every turn, so
 *  they get the same posture here. `import` — memory carried over from
 *  another assistant or another AGENT.json — is text nobody here has read
 *  yet, so it is quarantined too (docs/agent-memory.md §8). */
const TRUSTED_SOURCES = new Set<LessonSource>(['chat', 'loop', 'feedback']);

export interface LessonRow {
  id: string;
  agentId: string;
  text: string;
  sourceKind: string;
  sourceSessionId: string | null;
  trusted: number;
  pinned: number;
  useCount: number;
  /** 'shared' | 'private:<memberAccountId>' (docs/shared-agents.md §4). */
  audience: string;
  createdAt: string;
  updatedAt: string;
}

export const SHARED_AUDIENCE = 'shared';
export const privateAudience = (memberAccountId: string): string => `private:${memberAccountId}`;
/** The member a private audience names, or null for shared. */
export function audienceMember(audience: string): string | null {
  return audience.startsWith('private:') ? audience.slice('private:'.length) : null;
}

/** Who may read a lesson: everyone for shared; the member it is private to;
 *  and anyone a flow rule (`allowFrom`) opened that member's lessons to. */
export function visibleTo(audience: string, actor: string, allowFrom?: ReadonlySet<string>): boolean {
  const owner = audienceMember(audience);
  if (owner === null) return true;
  if (owner === actor) return true;
  return allowFrom?.has(owner) ?? false;
}

/** Prompt budget for the injected digest — the same order as the user
 *  profile beside it. "The agent remembers more" must never quietly mean
 *  "every turn costs more forever". */
const DIGEST_CHARS = 3_500;
const DIGEST_MAX = 12;
/** Similarity above which a new lesson is the same lesson again. */
const DUPE_THRESHOLD = 0.55;
/** Rows kept per agent; consolidation trims to this by value, not age. */
const MAX_LESSONS = 300;

const nowIso = () => new Date().toISOString();
/** Dedup key for imports: case- and whitespace-insensitive. */
const normalize = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const newId = () => `les_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** Session name → surface. The turn loop names these sessions, so the naming
 *  is the provenance signal available without threading a flag through every
 *  call site. Anything unrecognized is a normal chat. */
export function sourceForSession(sessionName: string): LessonSource {
  if (sessionName.startsWith('Loop · ')) return 'loop';
  if (sessionName.startsWith('App · ')) return 'app';
  if (sessionName.startsWith('Telegram · ') || sessionName.startsWith('Email · ')) return 'channel';
  return 'chat';
}

@Injectable()
export class AgentMemoryService {
  /** Whether pg_trgm exists here (it does not in PGlite). Probed once. */
  private trigram?: boolean;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  private async hasTrigram(): Promise<boolean> {
    if (this.trigram === undefined) {
      const res = await this.db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
        .catch(() => ({ rows: [] as unknown[] }));
      this.trigram = res.rows.length > 0;
    }
    return this.trigram;
  }

  /**
   * Record a lesson. Returns the row plus whether it merged into an existing
   * one — a repeat bumps useCount and freshens the timestamp instead of
   * adding a competing near-duplicate.
   */
  async record(
    agentId: string,
    text: string,
    opts: { source: LessonSource; sessionId?: string | null; audience?: string } = { source: 'chat' },
  ): Promise<{ lesson: LessonRow; merged: boolean }> {
    const body = text.trim().slice(0, 2_000);
    const trusted = TRUSTED_SOURCES.has(opts.source) ? 1 : 0;
    const audience = opts.audience ?? SHARED_AUDIENCE;

    // A private lesson never merges into a shared one (that would widen its
    // audience by repetition), so similarity is checked within the audience.
    const existing = await this.findSimilar(agentId, body, trusted, audience);
    if (existing) {
      const [row] = await this.db.update(agentLessons)
        .set({ useCount: existing.useCount + 1, updatedAt: nowIso() })
        .where(eq(agentLessons.id, existing.id)).returning();
      await this.regenerate(agentId);
      return { lesson: row, merged: true };
    }

    const [row] = await this.db.insert(agentLessons).values({
      id: newId(), agentId, text: body,
      sourceKind: opts.source, sourceSessionId: opts.sessionId ?? null,
      trusted, pinned: 0, useCount: 1, audience,
      createdAt: nowIso(), updatedAt: nowIso(),
    }).returning();
    await this.consolidate(agentId);
    await this.regenerate(agentId);
    return { lesson: row, merged: false };
  }

  /**
   * Bulk import (docs/agent-memory.md §8): rows from another assistant's
   * export or an AGENT.json. Every row lands as `import` provenance; whether
   * it is trusted is the caller's explicit choice (the UI's "trust imported
   * lessons" tick), never the default. Dedup is against *all* existing
   * lessons regardless of tier — importing the same export twice must not
   * double the quarantine queue — and within the batch itself.
   */
  async importLessons(
    agentId: string,
    texts: string[],
    opts: { trusted?: boolean; pinned?: string[] } = {},
  ): Promise<{ added: number; skipped: number; ids: string[] }> {
    const existing = new Set((await this.list(agentId)).map((r) => normalize(r.text)));
    const seen = new Set<string>();
    const ids: string[] = [];
    let skipped = 0;
    for (const raw of texts) {
      const body = raw.trim().slice(0, 2_000);
      const key = normalize(body);
      if (!key || existing.has(key) || seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const [row] = await this.db.insert(agentLessons).values({
        id: newId(), agentId, text: body,
        sourceKind: 'import', sourceSessionId: null,
        trusted: opts.trusted ? 1 : 0,
        pinned: opts.pinned?.includes(raw) ? 1 : 0,
        useCount: 1, audience: SHARED_AUDIENCE,
        createdAt: nowIso(), updatedAt: nowIso(),
      }).returning();
      ids.push(row.id);
    }
    if (ids.length > 0) {
      await this.consolidate(agentId);
      await this.regenerate(agentId);
    }
    return { added: ids.length, skipped, ids };
  }

  /** Near-duplicate lookup. Uses pg_trgm where available and falls back to
   *  exact text match, which is worth having rather than nothing: the common
   *  repeat is a model re-deriving the same sentence. */
  private async findSimilar(agentId: string, text: string, trusted: number, audience: string): Promise<LessonRow | null> {
    if (await this.hasTrigram()) {
      const res = await this.db.execute(sql`
        SELECT *, similarity("text", ${text}) AS sim FROM agent_lessons
        WHERE "agentId" = ${agentId} AND "trusted" = ${trusted} AND "audience" = ${audience}
          AND similarity("text", ${text}) > ${DUPE_THRESHOLD}
        ORDER BY sim DESC LIMIT 1
      `);
      return (res.rows[0] as unknown as LessonRow | undefined) ?? null;
    }
    const rows = await this.db.select().from(agentLessons)
      .where(and(eq(agentLessons.agentId, agentId), eq(agentLessons.text, text), eq(agentLessons.trusted, trusted), eq(agentLessons.audience, audience)))
      .limit(1);
    return rows[0] ?? null;
  }

  async list(agentId: string, opts: { trusted?: boolean } = {}): Promise<LessonRow[]> {
    const where = opts.trusted === undefined
      ? eq(agentLessons.agentId, agentId)
      : and(eq(agentLessons.agentId, agentId), eq(agentLessons.trusted, opts.trusted ? 1 : 0));
    const rows = await this.db.select().from(agentLessons).where(where)
      .orderBy(desc(agentLessons.pinned), desc(agentLessons.updatedAt));
    return rows;
  }

  /**
   * The block injected into the system prompt: trusted lessons only, ranked
   * and hard-capped. Ranking is deliberately simple — pinned first, then
   * recurrence, then recency. A dumb ranker that ships beats a good one that
   * waits, because until something reaches the prompt the whole pipeline is
   * decoration.
   */
  async digest(agentId: string, opts: { actor?: string; allowFrom?: ReadonlySet<string> } = {}): Promise<string> {
    // Audience (docs/shared-agents.md §4): shared rows, the acting member's
    // own private rows, and private rows a flow rule opened to them. With no
    // actor named (single-user, or a caller that predates members) only the
    // shared rows are injected — never a member's private ones by default.
    const rows = (await this.list(agentId, { trusted: true }))
      .filter((r) => visibleTo(r.audience ?? SHARED_AUDIENCE, opts.actor ?? '', opts.allowFrom))
      .sort((a, b) =>
        (b.pinned - a.pinned)
        || (b.useCount - a.useCount)
        || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, DIGEST_MAX);

    const lines: string[] = [];
    let used = 0;
    for (const r of rows) {
      const line = `- ${r.text}${r.useCount > 1 ? ` (learned ${r.useCount}×)` : ''}`;
      if (used + line.length > DIGEST_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join('\n');
  }

  /** Promote a quarantined lesson (the user reviewed what an app or channel
   *  taught) or pin/unpin one. */
  async update(agentId: string, id: string, patch: { trusted?: boolean; pinned?: boolean; audience?: string }): Promise<LessonRow> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.trusted !== undefined) set.trusted = patch.trusted ? 1 : 0;
    if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
    // The owner may widen a private lesson to shared (or narrow one back);
    // the route is owner-only and there is no agent tool for it.
    if (patch.audience !== undefined) {
      if (patch.audience !== SHARED_AUDIENCE && !patch.audience.startsWith('private:')) throw new BadRequestException(`audience must be shared or private:<member>`);
      set.audience = patch.audience;
    }
    const [row] = await this.db.update(agentLessons).set(set)
      .where(and(eq(agentLessons.id, id), eq(agentLessons.agentId, agentId))).returning();
    if (!row) throw new NotFoundException(`lesson ${id}`);
    await this.regenerate(agentId);
    return row;
  }

  /** A memory nobody can delete is one nobody can correct. */
  async remove(agentId: string, id: string): Promise<{ ok: boolean }> {
    await this.db.delete(agentLessons)
      .where(and(eq(agentLessons.id, id), eq(agentLessons.agentId, agentId)));
    await this.regenerate(agentId);
    return { ok: true };
  }

  /**
   * Trim to MAX_LESSONS by value rather than by age: pinned survive, then
   * recurrence, then recency. The old file-level tail-trim dropped the oldest
   * entries whatever they were worth, which deleted an agent's best lesson
   * while keeping last week's duplicate.
   */
  async consolidate(agentId: string): Promise<number> {
    const rows = await this.list(agentId);
    if (rows.length <= MAX_LESSONS) return 0;
    const keep = new Set(
      [...rows]
        .sort((a, b) =>
          (b.pinned - a.pinned)
          || (b.useCount - a.useCount)
          || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_LESSONS)
        .map((r) => r.id),
    );
    const drop = rows.filter((r) => !keep.has(r.id));
    for (const r of drop) {
      await this.db.delete(agentLessons).where(eq(agentLessons.id, r.id));
    }
    return drop.length;
  }

  /**
   * Rewrite LESSONS.md from the rows. The file stays the human's view of the
   * agent's memory — readable, greppable, in the Files tab — while the table
   * is what the system reads.
   */
  async regenerate(agentId: string): Promise<void> {
    const rows = await this.list(agentId);
    const trusted = rows.filter((r) => r.trusted === 1);
    const quarantined = rows.filter((r) => r.trusted === 0);

    const fmt = (r: LessonRow) => {
      const bits = [r.sourceKind];
      if (r.useCount > 1) bits.push(`${r.useCount}×`);
      if (r.pinned) bits.push('pinned');
      if (audienceMember(r.audience ?? SHARED_AUDIENCE)) bits.push('private');
      return `- ${r.text}\n  _(${bits.join(' · ')}, ${r.updatedAt.slice(0, 10)})_`;
    };

    let out = '# LESSONS.md\n\nWhat this agent has learned. Written by distillation, '
      + 'injected into every turn (the top entries, within a size budget), and editable here.\n\n';
    out += trusted.length > 0
      ? `## Active\n\n${trusted.map(fmt).join('\n')}\n`
      : '## Active\n\nNothing learned yet.\n';
    if (quarantined.length > 0) {
      out += '\n## Awaiting review\n\nLearned from a mini app, a chat channel, or an import. '
        + 'These are never injected until you promote them, because an app that could '
        + 'teach its agent could write its own instructions.\n\n'
        + `${quarantined.map(fmt).join('\n')}\n`;
    }
    const agent = (await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    if (!agent) return;
    const home = await ensureAgentHome(this.db, this.storage, agent);
    await this.storage.put(homeKey(home, 'LESSONS.md'), Buffer.from(out, 'utf8'), 'text/markdown')
      .catch(() => {});
  }
}
