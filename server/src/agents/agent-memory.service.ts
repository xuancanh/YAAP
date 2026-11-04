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
 *    as it got old enough;
 *  - **learning as it works** (§12): lessons carry what made them (`cause`),
 *    what happened, the refs they rest on (`evidence`), keywords, a recall
 *    count and a status; the digest is a small always-on core plus the
 *    lessons relevant to *this* turn's text; `consolidateAgent` merges
 *    paraphrases, retires what went stale and trims, on a quiet loop.
 *
 * LESSONS.md is regenerated from these rows on every write. The transparent
 * file brain is a product promise (FR-11.3): people read it in the Files
 * tab, and change lessons on the Memory tab; it stops being the source of
 * truth for machine reads, which is what makes any of the above possible.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentLessons, agents } from '../database/schema';
import { StorageService } from '../storage/storage.service';
import { ensureAgentHome, homeKey } from '../files/agent-home';

/** Where a lesson was learned. Trust follows the surface, never the text. */
export type LessonSource = 'chat' | 'loop' | 'channel' | 'app' | 'feedback' | 'import';
export const LESSON_SOURCES: readonly LessonSource[] = ['chat', 'loop', 'channel', 'app', 'feedback', 'import'];

/** What made a lesson (docs/agent-memory.md §12). The surface (`source`)
 *  decides trust; the cause says which moment of the work it came from. */
export type LessonCause = '' | 'distill' | 'note' | 'review' | 'failure' | 'feedback' | 'decision' | 'retro' | 'import';

/** Surfaces whose conclusions may enter the prompt without a human. `app`
 *  and `channel` are the ones the permission model already treats as
 *  untrusted input; a lesson is an instruction that outlives every turn, so
 *  they get the same posture here. `import` — memory carried over from
 *  another assistant or another AGENT.json — is text nobody here has read
 *  yet, so it is quarantined too (docs/agent-memory.md §8). */
const TRUSTED_SOURCES = new Set<LessonSource>(['chat', 'loop', 'feedback']);
export const isTrustedSource = (s: LessonSource): boolean => TRUSTED_SOURCES.has(s);

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
  cause: string;
  context: string;
  /** JSON array of refs. */
  evidence: string;
  tags: string;
  recalls: number;
  lastRecalledAt: string | null;
  /** active | retired */
  status: string;
  statusNote: string;
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
 *  "every turn costs more forever". The always-on core and the lessons
 *  relevant to this turn share it. */
export const DIGEST_CHARS = 3_500;
const CORE_CHARS = 2_200;
const CORE_MAX = 8;
const RELEVANT_MAX = 4;
/** A lesson is one rule, not an essay (the strict size cap). */
export const LESSON_CHARS = 600;
const CONTEXT_CHARS = 300;
const EVIDENCE_MAX = 8;
/** Similarity above which a new lesson is the same lesson again (pg_trgm). */
const DUPE_THRESHOLD = 0.55;
/** Rows kept per agent; consolidation trims to this by value, not age. */
const MAX_LESSONS = 300;
/** Active lessons the generated LESSONS.md lists before pointing at the Memory tab. */
const FILE_ACTIVE_MAX = 60;

const nowIso = () => new Date().toISOString();
/** Dedup key for imports: case- and whitespace-insensitive. */
const normalize = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
const newId = () => `les_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
/** The handle a prompt line and the tools use: the id's first 8 characters. */
export const shortLessonId = (id: string): string => id.replace(/^les_/, '').slice(0, 8);

/** Session name → surface. The turn loop names these sessions, so the naming
 *  is the provenance signal available without threading a flag through every
 *  call site. Anything unrecognized is a normal chat. */
export function sourceForSession(sessionName: string): LessonSource {
  if (sessionName.startsWith('Loop · ')) return 'loop';
  if (sessionName.startsWith('App · ')) return 'app';
  if (sessionName.startsWith('Telegram · ') || sessionName.startsWith('Email · ')) return 'channel';
  return 'chat';
}

// ---- model-free text matching (dedup, relevance) ----

const STOP = new Set(('the and for are but not you your yours with this that these those from into onto over than then them they their there here what when where which while who whom why how all any each every some such only own same other very can could should would will just also more most less least been being have has had having does did doing done was were its our ours out off per via about above after again against before below between both down during further once under until upon itself '
  + 'task tasks work woken wake reason run runs tool tools call calls use used using make made one two get got set let new old now see said says say like need needs needed want wants note notes').split(' '));

/** Content words of a text: lowercased, unicode-aware, stopwords and numbers
 *  dropped, a light plural/-ing/-ed stem. Task keys (REJ-35) survive whole. */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const w = raw.replace(/^-+|-+$/g, '');
    if (w.length < 3 || STOP.has(w) || /^[\d-]+$/.test(w)) continue;
    if (/^[a-z]{2,6}-\d+$/.test(w)) { out.add(w); continue; }
    out.add(w.length > 5 ? w.replace(/(ing|ed|es|s)$/, '') : w);
  }
  return out;
}

/** Similarity of two term sets: Jaccard, or — when one is nearly contained
 *  in the other — the overlap coefficient, discounted. Model-free and the
 *  same on PGlite and Postgres, which matters: PGlite has no pg_trgm, and the
 *  exact-text fallback let every paraphrase through as a new lesson. */
export function termSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  const overlap = inter / Math.min(a.size, b.size);
  return Math.min(a.size, b.size) >= 6 && overlap >= 0.85 ? Math.max(jaccard, overlap * 0.75) : jaccard;
}
/** Term similarity at which two lessons are the same lesson said twice. */
export const MERGE_SIMILARITY = 0.6;

export function parseEvidence(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String).filter(Boolean) : []; } catch { return []; }
}
const mergeEvidence = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].slice(-EVIDENCE_MAX);
/** A ref as people read it: `task:REJ-35` → `REJ-35`, `meeting:ab12…` → `meeting ab12cd34`. */
export function evidenceLabel(ref: string): string {
  const [kind, ...rest] = ref.split(':');
  const id = rest.join(':');
  if (kind === 'task') return id;
  return id ? `${kind} ${id.slice(0, 8)}` : ref;
}

/** Rank for the always-on core and for trimming: pinned, then how often it
 *  was learned again, then how often it proved relevant, then recency. */
function byValue(a: LessonRow, b: LessonRow): number {
  return (b.pinned - a.pinned) || (b.useCount - a.useCount) || ((b.recalls ?? 0) - (a.recalls ?? 0)) || b.updatedAt.localeCompare(a.updatedAt);
}

export interface RecordOpts {
  source: LessonSource;
  sessionId?: string | null;
  audience?: string;
  cause?: LessonCause;
  /** What happened (one line); the rule is the text. */
  context?: string;
  evidence?: string | string[];
  tags?: string | string[];
  pinned?: boolean;
}

export interface RecallHit { kind: 'lesson' | 'note'; id: string; text: string; ref: string; score: number; status?: string }
export interface LessonEvent { agentId: string; lesson: LessonRow; merged: boolean }

@Injectable()
export class AgentMemoryService {
  /** Whether pg_trgm exists here (it does not in PGlite). Probed once. */
  private trigram?: boolean;
  /** agentId → last consolidation (ms). One pass per agent per window. */
  private readonly consolidatedAt = new Map<string, number>();
  /** Days without being learned again or recalled before a lesson is stale;
   *  the company binds its tunable (memory.lessonStaleDays) per member. */
  private staleDaysFor: (agentId: string) => Promise<number> = async () => 45;
  /** Told after a lesson is recorded or confirmed (OrgLearningService
   *  watches for the repeats that raise a guidance proposal). */
  private readonly listeners: Array<(ev: LessonEvent) => void> = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
  ) {}

  setStaleDaysResolver(fn: (agentId: string) => Promise<number>): void { this.staleDaysFor = fn; }
  onLesson(fn: (ev: LessonEvent) => void): () => void {
    this.listeners.push(fn);
    return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); };
  }
  private emit(agentId: string, lesson: LessonRow, merged: boolean): void {
    for (const fn of this.listeners) { try { fn({ agentId, lesson, merged }); } catch { /* a listener never fails a write */ } }
  }

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
   * one — a repeat bumps useCount, joins the evidence and freshens the
   * timestamp instead of adding a competing near-duplicate; a retired lesson
   * learned again is active again.
   */
  async record(agentId: string, text: string, opts: RecordOpts = { source: 'chat' }): Promise<{ lesson: LessonRow; merged: boolean }> {
    const body = text.replace(/\s+/g, ' ').trim().slice(0, LESSON_CHARS);
    if (!body) throw new BadRequestException('a lesson needs text');
    const trusted = TRUSTED_SOURCES.has(opts.source) ? 1 : 0;
    const audience = opts.audience ?? SHARED_AUDIENCE;
    const evidence = (Array.isArray(opts.evidence) ? opts.evidence : opts.evidence ? [opts.evidence] : []).map((e) => e.trim().slice(0, 120)).filter(Boolean);
    const tags = (Array.isArray(opts.tags) ? opts.tags.join(' ') : opts.tags ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

    // A private lesson never merges into a shared one (that would widen its
    // audience by repetition), so similarity is checked within the audience.
    const existing = await this.findSimilar(agentId, body, trusted, audience);
    if (existing) {
      const [row] = await this.db.update(agentLessons)
        .set({
          useCount: existing.useCount + 1, updatedAt: nowIso(),
          evidence: JSON.stringify(mergeEvidence(parseEvidence(existing.evidence), evidence)),
          tags: [...new Set(`${existing.tags ?? ''} ${tags}`.split(' ').filter(Boolean))].join(' ').slice(0, 300),
          ...(existing.status === 'retired' ? { status: 'active', statusNote: '' } : {}),
          ...(opts.pinned ? { pinned: 1 } : {}),
        })
        .where(eq(agentLessons.id, existing.id)).returning();
      await this.regenerate(agentId);
      this.emit(agentId, row as LessonRow, true);
      return { lesson: row as LessonRow, merged: true };
    }

    const [row] = await this.db.insert(agentLessons).values({
      id: newId(), agentId, text: body,
      sourceKind: opts.source, sourceSessionId: opts.sessionId ?? null,
      trusted, pinned: opts.pinned ? 1 : 0, useCount: 1, audience,
      cause: opts.cause ?? '', context: (opts.context ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CHARS),
      evidence: JSON.stringify(evidence.slice(-EVIDENCE_MAX)), tags,
      createdAt: nowIso(), updatedAt: nowIso(),
    }).returning();
    await this.consolidate(agentId);
    await this.regenerate(agentId);
    this.emit(agentId, row as LessonRow, false);
    return { lesson: row as LessonRow, merged: false };
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
        useCount: 1, audience: SHARED_AUDIENCE, cause: 'import',
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

  /** Near-duplicate lookup: pg_trgm where available, then the model-free
   *  term similarity over this agent's rows of the same tier and audience.
   *  The common repeat is a model re-deriving the same sentence in other
   *  words, which exact matching never caught. */
  private async findSimilar(agentId: string, text: string, trusted: number, audience: string): Promise<LessonRow | null> {
    if (await this.hasTrigram()) {
      const res = await this.db.execute(sql`
        SELECT *, similarity("text", ${text}) AS sim FROM agent_lessons
        WHERE "agentId" = ${agentId} AND "trusted" = ${trusted} AND "audience" = ${audience}
          AND similarity("text", ${text}) > ${DUPE_THRESHOLD}
        ORDER BY sim DESC LIMIT 1
      `);
      const hit = (res.rows[0] as unknown as LessonRow | undefined) ?? null;
      if (hit) return hit;
    }
    const rows = await this.db.select().from(agentLessons)
      .where(and(eq(agentLessons.agentId, agentId), eq(agentLessons.trusted, trusted), eq(agentLessons.audience, audience))) as LessonRow[];
    const exact = rows.find((r) => r.text === text);
    if (exact) return exact;
    const terms = contentTerms(text);
    let best: LessonRow | null = null; let bestSim = MERGE_SIMILARITY;
    for (const r of rows) {
      const sim = termSimilarity(terms, contentTerms(r.text));
      if (sim >= bestSim) { best = r; bestSim = sim; }
    }
    return best;
  }

  async list(agentId: string, opts: { trusted?: boolean; status?: 'active' | 'retired' } = {}): Promise<LessonRow[]> {
    const conds = [eq(agentLessons.agentId, agentId)];
    if (opts.trusted !== undefined) conds.push(eq(agentLessons.trusted, opts.trusted ? 1 : 0));
    if (opts.status) conds.push(eq(agentLessons.status, opts.status));
    const rows = await this.db.select().from(agentLessons).where(and(...conds))
      .orderBy(desc(agentLessons.pinned), desc(agentLessons.updatedAt));
    return rows as LessonRow[];
  }

  /** A lesson by id or by the 8-character handle the prompt shows. */
  async resolve(agentId: string, ref: string): Promise<LessonRow | null> {
    const r = ref.trim().replace(/^\[|\]$/g, '');
    if (!/^[a-z0-9_]{4,40}$/i.test(r)) return null;
    const id = r.startsWith('les_') ? r : `les_${r}`;
    const rows = await this.db.select().from(agentLessons)
      .where(and(eq(agentLessons.agentId, agentId), like(agentLessons.id, `${id.replace(/_/g, '\\_')}%`))).limit(2) as LessonRow[];
    return rows.length === 1 ? rows[0] : null;
  }

  /** Trusted, active lessons this reader may see. Audience (docs/shared-agents.md
   *  §4): shared rows, the acting member's own private rows, and private rows
   *  a flow rule opened to them. With no actor named only the shared rows. */
  private async injectable(agentId: string, opts: { actor?: string; allowFrom?: ReadonlySet<string> }): Promise<LessonRow[]> {
    return (await this.list(agentId, { trusted: true, status: 'active' }))
      .filter((r) => visibleTo(r.audience ?? SHARED_AUDIENCE, opts.actor ?? '', opts.allowFrom));
  }

  /**
   * Lessons matched to a text (a task's wake prompt, a person's message, a
   * memory_recall question): content words shared with the lesson, its tags
   * and its context, each weighted by how rare it is across these lessons,
   * plus a strong bonus when the text names a task the lesson's evidence
   * names. At least two shared words, or that one evidence match.
   */
  rank(rows: LessonRow[], text: string): Array<{ row: LessonRow; score: number }> {
    const q = contentTerms(text.slice(0, 6_000));
    if (q.size === 0 || rows.length === 0) return [];
    const termsOf = new Map(rows.map((r) => [r.id, contentTerms(`${r.text} ${r.tags ?? ''} ${r.context ?? ''}`)]));
    const df = new Map<string, number>();
    for (const ts of termsOf.values()) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
    const n = rows.length;
    const out: Array<{ row: LessonRow; score: number }> = [];
    for (const r of rows) {
      const ts = termsOf.get(r.id)!;
      let score = 0; let hits = 0;
      for (const t of q) if (ts.has(t)) { hits++; score += Math.log(1 + n / (df.get(t) ?? 1)); }
      const keyHit = parseEvidence(r.evidence).some((e) => e.startsWith('task:') && q.has(e.slice(5).toLowerCase()));
      if (keyHit) score += 4;
      if (hits >= 2 || keyHit) out.push({ row: r, score });
    }
    return out.sort((a, b) => b.score - a.score || byValue(a.row, b.row));
  }

  private line(r: LessonRow): string {
    const keys = parseEvidence(r.evidence).filter((e) => e.startsWith('task:')).map(evidenceLabel).slice(-2);
    const bits = [r.useCount > 1 ? `learned ${r.useCount}×` : '', keys.join(', ')].filter(Boolean);
    return `- [${shortLessonId(r.id)}] ${r.text}${bits.length ? ` (${bits.join('; ')})` : ''}`;
  }

  /**
   * The block injected into the system prompt: trusted, active lessons only,
   * hard-capped. Two parts share the budget: a small always-on core (pinned,
   * then recurrence, then usefulness, then recency) and, when the turn's text
   * is known, the lessons relevant to it that the core did not carry.
   * Relevant hits count as recalls, which is what lets a lesson that keeps
   * proving useful climb into the core.
   */
  async digest(agentId: string, opts: { actor?: string; allowFrom?: ReadonlySet<string>; query?: string } = {}): Promise<string> {
    const rows = await this.injectable(agentId, opts);
    if (rows.length === 0) return '';
    const lines: string[] = []; const coreIds = new Set<string>();
    let used = 0;
    for (const r of [...rows].sort(byValue).slice(0, CORE_MAX)) {
      const line = this.line(r);
      if (used + line.length + 1 > CORE_CHARS) break;
      lines.push(line); coreIds.add(r.id); used += line.length + 1;
    }
    const recalled: string[] = [];
    if (opts.query?.trim()) {
      const header = 'Relevant to this work:';
      const relevant: string[] = [];
      let rel = header.length + 1;
      for (const { row } of this.rank(rows.filter((r) => !coreIds.has(r.id)), opts.query).slice(0, RELEVANT_MAX)) {
        const line = this.line(row);
        if (used + rel + line.length + 1 > DIGEST_CHARS) break;
        relevant.push(line); recalled.push(row.id); rel += line.length + 1;
      }
      if (relevant.length) lines.push(header, ...relevant);
    }
    if (recalled.length) await this.markRecalled(recalled).catch(() => undefined);
    return lines.join('\n');
  }

  private async markRecalled(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.update(agentLessons).set({ recalls: sql`${agentLessons.recalls} + 1`, lastRecalledAt: nowIso() }).where(inArray(agentLessons.id, ids));
  }

  /**
   * memory_recall: lessons (active first; retired ones marked) and the
   * agent's knowledge/ notes, matched to a question. Model-free, bounded.
   */
  async recall(agentId: string, query: string, opts: { actor?: string; allowFrom?: ReadonlySet<string>; limit?: number } = {}): Promise<RecallHit[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 20));
    const rows = (await this.list(agentId, { trusted: true }))
      .filter((r) => visibleTo(r.audience ?? SHARED_AUDIENCE, opts.actor ?? '', opts.allowFrom));
    const ranked = this.rank(rows, query).map(({ row, score }) => ({ row, score: row.status === 'retired' ? score / 2 : score }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
    const hits: RecallHit[] = ranked.map(({ row, score }) => ({
      kind: 'lesson', id: shortLessonId(row.id), text: row.text, score, status: row.status,
      ref: [row.useCount > 1 ? `learned ${row.useCount}×` : '', ...parseEvidence(row.evidence).map(evidenceLabel).slice(-3), row.updatedAt.slice(0, 10)].filter(Boolean).join(' · '),
    }));
    await this.markRecalled(ranked.filter((h) => h.row.status === 'active').map((h) => h.row.id)).catch(() => undefined);
    // knowledge/ notes: line-level matches, a few per question.
    const q = contentTerms(query);
    const agent = (await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    if (agent && q.size > 0) {
      const home = await ensureAgentHome(this.db, this.storage, agent).catch(() => null);
      const objs = home ? (await this.storage.list(`${home.prefix}knowledge/`).catch(() => [])).slice(0, 40) : [];
      const notes: RecallHit[] = [];
      for (const o of objs) {
        if (!/\.(md|txt)$/i.test(o.key)) continue;
        const buf = await this.storage.get(o.key).catch(() => null);
        if (!buf) continue;
        const path = `knowledge/${o.key.split('/knowledge/')[1] ?? ''}`;
        for (const ln of buf.toString('utf8').slice(0, 60_000).split('\n')) {
          const ts = contentTerms(ln);
          let hit = 0; for (const t of q) if (ts.has(t)) hit++;
          if (hit >= Math.min(2, q.size)) notes.push({ kind: 'note', id: path, text: ln.trim().slice(0, 300), ref: path, score: hit });
        }
      }
      hits.push(...notes.sort((a, b) => b.score - a.score).slice(0, Math.max(3, limit - hits.length)));
    }
    return hits;
  }

  /** Work proved a lesson right: it counts as learned again, with the new evidence. */
  async confirm(agentId: string, ref: string, opts: { evidence?: string[] } = {}): Promise<LessonRow> {
    const row = await this.resolve(agentId, ref);
    if (!row) throw new NotFoundException(`no lesson "${ref}" (use the 8-character id shown before a lesson)`);
    const [out] = await this.db.update(agentLessons).set({
      useCount: row.useCount + 1, updatedAt: nowIso(),
      evidence: JSON.stringify(mergeEvidence(parseEvidence(row.evidence), opts.evidence ?? [])),
      ...(row.status === 'retired' ? { status: 'active', statusNote: '' } : {}),
    }).where(eq(agentLessons.id, row.id)).returning();
    await this.regenerate(agentId);
    this.emit(agentId, out as LessonRow, true);
    return out as LessonRow;
  }

  /** A lesson that was wrong or no longer holds: kept for the record, never injected. */
  async retire(agentId: string, ref: string, reason: string): Promise<LessonRow> {
    const row = await this.resolve(agentId, ref);
    if (!row) throw new NotFoundException(`no lesson "${ref}" (use the 8-character id shown before a lesson)`);
    const [out] = await this.db.update(agentLessons).set({ status: 'retired', statusNote: reason.replace(/\s+/g, ' ').trim().slice(0, 300) || 'retired', pinned: 0, updatedAt: nowIso() })
      .where(eq(agentLessons.id, row.id)).returning();
    await this.regenerate(agentId);
    return out as LessonRow;
  }

  /** Promote a quarantined lesson (the user reviewed what an app or channel
   *  taught), pin/unpin, reword, retire or restore one — a person's edits. */
  async update(agentId: string, id: string, patch: { trusted?: boolean; pinned?: boolean; audience?: string; text?: string; status?: string }): Promise<LessonRow> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.trusted !== undefined) set.trusted = patch.trusted ? 1 : 0;
    if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
    // The owner may widen a private lesson to shared (or narrow one back);
    // the route is owner-only and there is no agent tool for it.
    if (patch.audience !== undefined) {
      if (patch.audience !== SHARED_AUDIENCE && !patch.audience.startsWith('private:')) throw new BadRequestException(`audience must be shared or private:<member>`);
      set.audience = patch.audience;
    }
    if (patch.text !== undefined) {
      const t = patch.text.replace(/\s+/g, ' ').trim();
      if (!t) throw new BadRequestException('a lesson needs text');
      set.text = t.slice(0, LESSON_CHARS);
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'retired') throw new BadRequestException('status must be active or retired');
      set.status = patch.status;
      set.statusNote = patch.status === 'retired' ? 'retired by a person' : '';
    }
    const [row] = await this.db.update(agentLessons).set(set)
      .where(and(eq(agentLessons.id, id), eq(agentLessons.agentId, agentId))).returning();
    if (!row) throw new NotFoundException(`lesson ${id}`);
    await this.regenerate(agentId);
    return row as LessonRow;
  }

  /** A memory nobody can delete is one nobody can correct. */
  async remove(agentId: string, id: string): Promise<{ ok: boolean }> {
    await this.db.delete(agentLessons)
      .where(and(eq(agentLessons.id, id), eq(agentLessons.agentId, agentId)));
    await this.regenerate(agentId);
    return { ok: true };
  }

  /**
   * Trim to MAX_LESSONS by value rather than by age: retired go first, then
   * pinned survive, then recurrence, then recency. The old file-level
   * tail-trim dropped the oldest entries whatever they were worth, which
   * deleted an agent's best lesson while keeping last week's duplicate.
   */
  async consolidate(agentId: string): Promise<number> {
    const rows = await this.list(agentId);
    if (rows.length <= MAX_LESSONS) return 0;
    const keep = new Set(
      [...rows]
        .sort((a, b) => ((a.status === 'retired' ? 1 : 0) - (b.status === 'retired' ? 1 : 0)) || byValue(a, b))
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
   * The quiet-loop consolidation (§12), at most once per agent per window:
   *  - **merge** active lessons that say the same thing (term similarity,
   *    within one trust tier and audience): the most valuable row keeps its
   *    text and takes the others' counts, recalls and evidence;
   *  - **retire** stale ones: learned once, never recalled, not pinned, not
   *    a person's correction, untouched for the stale window (a tunable);
   *  - **trim** to the cap by value.
   * LESSONS.md is rewritten only when something changed.
   */
  async consolidateAgent(agentId: string, opts: { now?: Date; force?: boolean; windowMs?: number } = {}): Promise<{ merged: number; retired: number; trimmed: number; skipped?: boolean }> {
    const now = opts.now ?? new Date();
    const last = this.consolidatedAt.get(agentId) ?? 0;
    if (!opts.force && now.getTime() - last < (opts.windowMs ?? 6 * 60 * 60_000)) return { merged: 0, retired: 0, trimmed: 0, skipped: true };
    this.consolidatedAt.set(agentId, now.getTime());
    const rows = (await this.list(agentId, { status: 'active' })).sort(byValue);
    const terms = new Map(rows.map((r) => [r.id, contentTerms(r.text)]));
    const gone = new Set<string>();
    let merged = 0;
    for (let i = 0; i < rows.length; i++) {
      const keep = rows[i];
      if (gone.has(keep.id)) continue;
      let uses = keep.useCount; let ev = parseEvidence(keep.evidence); let recalls = keep.recalls ?? 0; let pinned = keep.pinned;
      const absorbed: string[] = [];
      for (let j = i + 1; j < rows.length; j++) {
        const other = rows[j];
        if (gone.has(other.id) || other.trusted !== keep.trusted || (other.audience ?? SHARED_AUDIENCE) !== (keep.audience ?? SHARED_AUDIENCE)) continue;
        if (termSimilarity(terms.get(keep.id)!, terms.get(other.id)!) < MERGE_SIMILARITY) continue;
        uses += other.useCount; ev = mergeEvidence(ev, parseEvidence(other.evidence)); recalls += other.recalls ?? 0; pinned = Math.max(pinned, other.pinned);
        absorbed.push(other.id); gone.add(other.id);
      }
      if (absorbed.length === 0) continue;
      await this.db.update(agentLessons).set({ useCount: uses, evidence: JSON.stringify(ev), recalls, pinned, updatedAt: nowIso() }).where(eq(agentLessons.id, keep.id));
      await this.db.delete(agentLessons).where(inArray(agentLessons.id, absorbed));
      merged += absorbed.length;
    }
    const staleDays = await this.staleDaysFor(agentId).catch(() => 45);
    const cutoff = new Date(now.getTime() - staleDays * 24 * 60 * 60_000).toISOString();
    const stale = rows.filter((r) => !gone.has(r.id) && r.pinned === 0 && r.useCount <= 1 && (r.recalls ?? 0) === 0
      && r.cause !== 'feedback' && r.sourceKind !== 'feedback' && r.updatedAt < cutoff);
    if (stale.length) {
      await this.db.update(agentLessons).set({ status: 'retired', statusNote: `stale: not learned again or recalled in ${staleDays} days` })
        .where(inArray(agentLessons.id, stale.map((r) => r.id)));
    }
    const trimmed = await this.consolidate(agentId);
    if (merged || stale.length || trimmed) await this.regenerate(agentId);
    return { merged, retired: stale.length, trimmed };
  }

  /**
   * Rewrite LESSONS.md from the rows. The file stays the human's view of the
   * agent's memory — readable, greppable, in the Files tab, bounded — while
   * the table is what the system reads.
   */
  async regenerate(agentId: string): Promise<void> {
    const rows = await this.list(agentId);
    const trusted = rows.filter((r) => r.trusted === 1 && r.status !== 'retired').sort(byValue);
    const retired = rows.filter((r) => r.trusted === 1 && r.status === 'retired');
    const quarantined = rows.filter((r) => r.trusted === 0);

    const fmt = (r: LessonRow) => {
      const bits = [r.sourceKind];
      if (r.cause && r.cause !== r.sourceKind) bits.push(r.cause);
      if (r.useCount > 1) bits.push(`${r.useCount}×`);
      if ((r.recalls ?? 0) > 0) bits.push(`recalled ${r.recalls}×`);
      if (r.pinned) bits.push('pinned');
      if (audienceMember(r.audience ?? SHARED_AUDIENCE)) bits.push('private');
      const ev = parseEvidence(r.evidence).map(evidenceLabel).slice(-3);
      if (ev.length) bits.push(ev.join(', '));
      return `- ${r.text}\n  _(${bits.join(' · ')}, ${r.updatedAt.slice(0, 10)})_`;
    };

    let out = '# LESSONS.md\n\nWhat this agent has learned. Generated from its lesson store: the top entries '
      + 'go into every turn (within a size budget), the rest when they match the work. Change them on the '
      + 'agent\'s Memory tab; the agent records, confirms and retires its own with memory_note.\n\n';
    const shown = trusted.slice(0, FILE_ACTIVE_MAX);
    out += shown.length > 0
      ? `## Active\n\n${shown.map(fmt).join('\n')}\n${trusted.length > shown.length ? `\n…and ${trusted.length - shown.length} more on the Memory tab.\n` : ''}`
      : '## Active\n\nNothing learned yet.\n';
    if (retired.length > 0) {
      out += `\n## Retired (${retired.length})\n\nKept for the record, never injected.\n\n`
        + `${retired.slice(0, 10).map((r) => `- ~~${r.text.slice(0, 160)}~~ — ${r.statusNote || 'retired'}`).join('\n')}\n`;
    }
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
