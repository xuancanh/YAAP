/**
 * The company's spend ledger (docs/company-vision.md §7, "Money"): every
 * dollar charged to the company's envelopes between two instants, and the one
 * computation every spend figure reads — the Spend page and the Money
 * dashboard (`OrgRuntimeService.spendTree`), the forecast
 * (`OrgCapitalService.forecast`), the brief's Spend section, Home and the org
 * chart's mission control. So "$39.74 spent this month" is the same number on
 * every screen, and the members' figures add up to the company's.
 *
 * Two sources, never counted twice:
 *  - task runs (`org_runs`): each with its agent, task (so its project and
 *    class) and tokens;
 *  - everything else the envelopes are charged for without a run row —
 *    meetings and their minutes, the chief's structure review, planning, the
 *    auditor, red-team, evals, ask-the-company: the `spend_commit` audit rows
 *    `OrgRuntimeService.settle` writes. A commit for a task run says
 *    `source: 'task'` and is skipped (the run row carries it); a commit from
 *    before sources were recorded is matched to a run of the same agent with
 *    the same amount, and counted only when no run matches.
 *
 * The window is UTC: a month runs from the 1st 00:00 UTC to now.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgRuns } from '../database/schema';

export interface SpendEntry {
  agentId: string;
  /** The task of a run; null for spend outside a task (a meeting, a review…). */
  taskId: string | null;
  usd: number;
  tokensIn: number;
  tokensOut: number;
  /** When it counted: a run's start, a commit's time. */
  at: string;
  /** 'task' for a run, else what settled it ('meeting', 'review', 'audit', …; 'other' before sources were recorded). */
  source: string;
}

/** The UTC calendar month `now` falls in, to `now`. */
export function monthWindow(now: Date): { month: string; from: string; to: string } {
  const month = now.toISOString().slice(0, 7);
  return { month, from: `${month}-01T00:00:00.000Z`, to: now.toISOString() };
}

/** A legacy commit (no `source`) belongs to a run when the amounts agree (run usd is a REAL; commits keep 6 decimals). */
const sameAmount = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-5);

/** The commits outside task runs, given the runs of the same window. Pure. */
export function overheadEntries(
  commits: ReadonlyArray<{ refId: string; payload: string; createdAt: string }>,
  runs: ReadonlyArray<{ agentId: string; usd: number }>,
): SpendEntry[] {
  const unmatched = new Map<string, number[]>();
  for (const r of runs) if (r.usd > 0) unmatched.set(r.agentId, [...(unmatched.get(r.agentId) ?? []), r.usd]);
  const out: SpendEntry[] = [];
  for (const c of commits) {
    let p: { usd?: unknown; source?: unknown } = {};
    try { p = JSON.parse(c.payload) as typeof p; } catch { /* unreadable: nothing to count */ }
    const usd = Number(p.usd) || 0;
    if (usd <= 0 || p.source === 'task') continue;
    if (typeof p.source !== 'string') {
      const list = unmatched.get(c.refId) ?? [];
      const i = list.findIndex((u) => sameAmount(u, usd));
      if (i >= 0) { list.splice(i, 1); continue; }
    }
    out.push({ agentId: c.refId, taskId: null, usd, tokensIn: 0, tokensOut: 0, at: c.createdAt, source: typeof p.source === 'string' ? p.source : 'other' });
  }
  return out;
}

/** Every dollar charged to the company between `from` and `to` (ISO), task runs first. */
export async function spendLedger(db: DrizzleDb, orgId: string, from: string, to: string): Promise<SpendEntry[]> {
  const runs = await db.select().from(orgRuns).where(and(eq(orgRuns.orgId, orgId), gte(orgRuns.startedAt, from), lte(orgRuns.startedAt, to)));
  const commits = await db.select({ refId: orgAudit.refId, payload: orgAudit.payload, createdAt: orgAudit.createdAt }).from(orgAudit)
    .where(and(eq(orgAudit.orgId, orgId), eq(orgAudit.action, 'spend_commit'), gte(orgAudit.createdAt, from), lte(orgAudit.createdAt, to)));
  return [
    ...runs.map((r) => ({ agentId: r.agentId, taskId: r.taskId, usd: r.usd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, at: r.startedAt, source: 'task' })),
    ...overheadEntries(commits, runs),
  ];
}

/** The entries' USD. */
export function sumUsd(entries: ReadonlyArray<SpendEntry>): number {
  return entries.reduce((n, e) => n + e.usd, 0);
}
