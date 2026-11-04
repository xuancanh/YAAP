/**
 * AgentGuidanceService — an agent's own guidance, and where every change to
 * it came from (docs/agent-memory.md §12).
 *
 * Two kinds of guidance shape how an agent works. The **charter** is written
 * by its manager or the owner; an agent never edits it. **How I work** is the
 * agent's own section: working notes it keeps as it learns ("I check the
 * deliverable on disk before re-waking anyone"), injected right after the
 * charter, editable by a person on the Memory tab, and rewritten by the agent
 * with `memory_guidance`. The boundary row `self_guidance` is `alone`: the
 * agent may revise it without asking, because it changes how the agent works
 * only within its charter and every change names its lessons.
 *
 * Every change is a row of `agent_guidance_changes` — the agent's edits
 * (`self`, applied), and the proposals repeated lessons raise through the
 * company's existing paths (`charter`: a charter_change card; `playbook`: a
 * revise task), pending until decided. The row carries the lesson ids, so a
 * person can always ask "why does it work like this?" and get the lessons.
 *
 * HOW-I-WORK.md in the agent's home is regenerated from the section and its
 * log, like LESSONS.md, so it reads in the Files tab.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentGuidanceChanges, agents } from '../database/schema';
import { StorageService } from '../storage/storage.service';
import { ensureAgentHome, homeKey } from '../files/agent-home';
import { checkBoundary } from '../org/boundary';
import { AgentMemoryService, shortLessonId } from './agent-memory.service';

/** The section's cap: it sits in every turn, beside a charter of similar size. */
export const SELF_GUIDANCE_CHARS = 1_500;
export const GUIDANCE_FILE = 'HOW-I-WORK.md';

export type GuidanceKind = 'self' | 'charter' | 'playbook';
export type GuidanceStatus = 'applied' | 'pending' | 'approved' | 'rejected';

export interface GuidanceChange {
  id: string;
  agentId: string;
  kind: string;
  status: string;
  text: string;
  /** JSON array of lesson ids. */
  lessonIds: string;
  ref: string;
  by: string;
  why: string;
  createdAt: string;
  decidedAt: string | null;
}

const nowIso = () => new Date().toISOString();
const newId = () => `gdc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
export function parseIds(raw: string | null | undefined): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

@Injectable()
export class AgentGuidanceService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly storage: StorageService,
    private readonly memory: AgentMemoryService,
  ) {}

  private async agentRow(agentId: string) {
    const row = (await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    if (!row) throw new NotFoundException(`agent ${agentId}`);
    return row;
  }

  async selfGuidance(agentId: string): Promise<string> {
    return (await this.agentRow(agentId)).selfGuidance ?? '';
  }

  async changes(agentId: string, opts: { status?: GuidanceStatus; kind?: GuidanceKind; limit?: number } = {}): Promise<GuidanceChange[]> {
    const conds = [eq(agentGuidanceChanges.agentId, agentId)];
    if (opts.status) conds.push(eq(agentGuidanceChanges.status, opts.status));
    if (opts.kind) conds.push(eq(agentGuidanceChanges.kind, opts.kind));
    return this.db.select().from(agentGuidanceChanges).where(and(...conds))
      .orderBy(desc(agentGuidanceChanges.createdAt)).limit(opts.limit ?? 50) as Promise<GuidanceChange[]>;
  }

  /** The Memory tab's view: the section, its log and what is pending. */
  async view(agentId: string): Promise<{ selfGuidance: string; changes: GuidanceChange[]; pending: GuidanceChange[] }> {
    const [selfGuidance, changes] = await Promise.all([this.selfGuidance(agentId), this.changes(agentId, { limit: 30 })]);
    return { selfGuidance, changes, pending: changes.filter((c) => c.status === 'pending') };
  }

  /**
   * Replace the agent's "How I work" section. `by: 'agent'` is the agent's
   * own act through memory_guidance — the boundary row self_guidance decides
   * it (alone), and the lessons it names must be the agent's own. A person's
   * edit (`by: 'user'`) needs no lessons.
   */
  async writeSelf(agentId: string, input: { text: string; lessonIds?: string[]; why?: string; by: 'agent' | 'user' }): Promise<{ text: string; change: GuidanceChange; truncated: boolean }> {
    await this.agentRow(agentId);
    const raw = input.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const truncated = raw.length > SELF_GUIDANCE_CHARS;
    const text = raw.slice(0, SELF_GUIDANCE_CHARS);
    if (input.by === 'agent') {
      const d = checkBoundary({ kind: 'self_guidance', key: agentId, summary: 'revise How I work' }, `agent:${agentId}`);
      if (d.outcome !== 'proceed') throw new BadRequestException(d.reason);
    }
    const ids: string[] = [];
    for (const ref of input.lessonIds ?? []) {
      const l = await this.memory.resolve(agentId, ref);
      if (!l) throw new BadRequestException(`no lesson "${ref}" of yours — name lessons by the 8-character id shown before them`);
      ids.push(l.id);
    }
    if (input.by === 'agent' && ids.length === 0) throw new BadRequestException('name the lessons this change comes from (lessonIds), so a person can see why you work this way');
    await this.db.update(agents).set({ selfGuidance: text }).where(eq(agents.id, agentId));
    const [change] = await this.db.insert(agentGuidanceChanges).values({
      id: newId(), agentId, kind: 'self', status: 'applied', text, lessonIds: JSON.stringify(ids),
      ref: '', by: input.by, why: (input.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 400), createdAt: nowIso(),
    }).returning();
    await this.regenerate(agentId);
    return { text, change: change as GuidanceChange, truncated };
  }

  /** A proposal a repeated lesson raised (a charter card, a playbook revise task). */
  async recordProposal(agentId: string, input: { kind: 'charter' | 'playbook'; text: string; lessonIds: string[]; ref: string; why?: string }): Promise<GuidanceChange> {
    const [change] = await this.db.insert(agentGuidanceChanges).values({
      id: newId(), agentId, kind: input.kind, status: 'pending', text: input.text.slice(0, 4_000), lessonIds: JSON.stringify(input.lessonIds),
      ref: input.ref, by: 'system', why: (input.why ?? '').slice(0, 400), createdAt: nowIso(),
    }).returning();
    await this.regenerate(agentId);
    return change as GuidanceChange;
  }

  /** The card or task behind a proposal was decided. */
  async decide(ref: string, status: 'approved' | 'rejected'): Promise<GuidanceChange | null> {
    if (!ref) return null;
    const [row] = await this.db.update(agentGuidanceChanges).set({ status, decidedAt: nowIso() })
      .where(and(eq(agentGuidanceChanges.ref, ref), eq(agentGuidanceChanges.status, 'pending'))).returning();
    if (row) await this.regenerate(row.agentId);
    return (row as GuidanceChange | undefined) ?? null;
  }

  /** Lesson ids already carried by a proposal (pending or decided) or a self edit. */
  async usedLessonIds(agentId: string, kinds: GuidanceKind[] = ['charter', 'playbook']): Promise<Set<string>> {
    const rows = await this.changes(agentId, { limit: 500 });
    return new Set(rows.filter((r) => kinds.includes(r.kind as GuidanceKind)).flatMap((r) => parseIds(r.lessonIds)));
  }

  /** HOW-I-WORK.md: the section and where each change came from. */
  async regenerate(agentId: string): Promise<void> {
    const agent = await this.agentRow(agentId).catch(() => null);
    if (!agent) return;
    const log = await this.changes(agentId, { limit: 20 });
    const lessons = new Map((await this.memory.list(agentId)).map((l) => [l.id, l.text]));
    const from = (c: GuidanceChange) => {
      const ids = parseIds(c.lessonIds);
      return ids.length ? ` — from ${ids.map((id) => `[${shortLessonId(id)}]${lessons.has(id) ? ` "${lessons.get(id)!.slice(0, 80)}"` : ''}`).join('; ')}` : '';
    };
    const label = (c: GuidanceChange) => c.kind === 'self'
      ? `${c.by === 'user' ? 'edited by a person' : 'revised by the agent'}`
      : `${c.kind} change proposed (${c.status})`;
    let out = '# How I work\n\nMy own working notes, kept as I learn. They sit right after my charter in every turn; '
      + 'my charter is written by my manager or the owner. Generated from my guidance — change it on my Memory tab.\n\n';
    out += agent.selfGuidance?.trim() ? `${agent.selfGuidance.trim()}\n` : '_Nothing yet._\n';
    if (log.length) out += `\n## Where this came from\n\n${log.map((c) => `- ${c.createdAt.slice(0, 10)} · ${label(c)}${c.why ? `: ${c.why}` : ''}${from(c)}`).join('\n')}\n`;
    const home = await ensureAgentHome(this.db, this.storage, agent).catch(() => null);
    if (!home) return;
    await this.storage.put(homeKey(home, GUIDANCE_FILE), Buffer.from(out, 'utf8'), 'text/markdown').catch(() => {});
  }
}
