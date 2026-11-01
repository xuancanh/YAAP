/**
 * OrgBriefService — the CEO's one message a day (docs/autonomous-company.md
 * §4.4). The brief is composed without a model: spend versus envelopes,
 * what closed / blocked / failed since the last brief, anomalies (loops,
 * no-progress blocks, charter drift, paused members, single-model review),
 * and the pending approvals as a numbered list the CEO answers in one reply
 * ("do 1, 3, skip 2"). It lands as an `agent_events` row of kind `brief` on
 * the chief of staff (channel-pushed, quiet hours respected) and is kept on
 * the org row so the reply can be resolved against the numbering it used.
 *
 * `reply()` is reachable only through the controller: the brief is also
 * sent to channels, which may answer questions and defer, but a decision
 * that widens authority or spends money is taken in the app
 * (docs/security.md §b, "approvals exist only in the app").
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { organizations } from '../database/schema';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { deliveryFor, parseQuietHours } from '../workspaces/quiet-hours';
import { OrgService } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService, summarize, type ApprovalDecision } from './org-approvals.service';
import { OrgAuditService } from './org-audit.service';

export interface BriefItem { n: number; approvalId: string; kind: string; summary: string }
export interface Brief { orgId: string; at: string; text: string; items: BriefItem[] }

export interface BriefReplyDecision { n: number; decision: ApprovalDecision; note?: string }

@Injectable()
export class OrgBriefService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Compose (and, with deliver, write) the brief. Deterministic: no model call. */
  async compose(orgId: string, opts: { deliver?: boolean; now?: Date; by?: string } = {}): Promise<Brief> {
    const now = opts.now ?? new Date();
    const org = await this.org.get(orgId);
    const since = org.lastBriefAt ?? new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const members = (await this.org.members(orgId)).filter((m) => m.status !== 'terminated');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nameOf = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : '—');
    const tasks = await this.tasks.list(orgId);
    const runs = (await this.tasks.runs(orgId, { limit: 500 })).filter((r) => r.startedAt >= since);
    const budgets = await this.org.budgets(orgId);
    const month = now.toISOString().slice(0, 7);
    const lines: string[] = [];
    lines.push(`# ${org.name} — brief for ${now.toISOString().slice(0, 10)}`);
    if (org.status === 'paused') lines.push('', '**The organization is paused (kill switch). No agent runs until you resume it.**');

    // 1. Spend vs envelopes
    lines.push('', '## Spend');
    const spentByAgent = new Map<string, number>();
    let orgSpent = 0;
    for (const r of (await this.tasks.runs(orgId, { limit: 500 })).filter((r) => r.startedAt.slice(0, 7) === month)) {
      orgSpent += r.usd; spentByAgent.set(r.agentId, (spentByAgent.get(r.agentId) ?? 0) + r.usd);
    }
    const company = budgets.find((b) => b.scope === 'company');
    lines.push(`- Company: $${orgSpent.toFixed(2)} this month${company && company.monthlyUsd > 0 ? ` of $${company.monthlyUsd.toFixed(2)} (${pct(orgSpent, company.monthlyUsd)})${orgSpent / company.monthlyUsd >= 0.8 ? ' ⚠ over 80%' : ''}` : ' (no company cap)'}`);
    const sinceRuns = runs.length;
    const chiefShare = org.chiefOfStaffAgentId ? (spentByAgent.get(org.chiefOfStaffAgentId) ?? 0) / Math.max(orgSpent, 0.000001) : 0;
    for (const m of members) {
      const b = budgets.find((x) => x.scope === 'agent' && x.refId === m.agentId);
      const spent = spentByAgent.get(m.agentId) ?? 0;
      lines.push(`- ${nameOf(m.agentId)} (${m.title || 'member'}${m.status === 'paused' ? ', paused' : ''}): $${spent.toFixed(2)}${b && b.monthlyUsd > 0 ? ` of $${b.monthlyUsd.toFixed(2)} (${pct(spent, b.monthlyUsd)})${spent / b.monthlyUsd >= 0.8 ? ' ⚠' : ''}` : ''}`);
    }
    if (orgSpent > 0 && chiefShare > 0.15) lines.push(`- ⚠ Coordination share: the chief of staff used ${Math.round(chiefShare * 100)}% of org spend (soft alarm at 15%).`);

    // 2. Tasks since the last brief
    const done = tasks.filter((t) => t.status === 'done' && t.updatedAt >= since);
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const review = tasks.filter((t) => t.status === 'in_review');
    const failed = runs.filter((r) => ['failed', 'loop', 'budget_stop'].includes(r.status));
    lines.push('', `## Work since ${since.slice(0, 16).replace('T', ' ')}`);
    lines.push(`- ${sinceRuns} run(s), ${done.length} task(s) accepted, ${review.length} in review, ${blocked.length} blocked, ${failed.length} failed run(s).`);
    for (const t of done.slice(0, 8)) lines.push(`  - ✓ ${t.title} (${nameOf(t.assigneeAgentId)})`);
    for (const t of blocked.slice(0, 8)) lines.push(`  - ■ blocked: ${t.title} (${nameOf(t.assigneeAgentId)}) — ${lastOf(t.blockers)}`);
    for (const r of failed.slice(0, 5)) lines.push(`  - ✗ ${r.status}: ${tasks.find((t) => t.id === r.taskId)?.title ?? r.taskId.slice(0, 8)} (${nameOf(r.agentId)})`);
    const accepted = tasks.filter((t) => t.status === 'done').length;
    if (accepted > 0 && orgSpent > 0) lines.push(`- Cost per accepted task this month: $${(orgSpent / accepted).toFixed(2)}.`);

    // 3. Anomalies
    const anomalies: string[] = [];
    const drift = await this.org.checkCharters(orgId);
    for (const d of drift) anomalies.push(`charter of ${d.name} changed outside the org path (accept it in the Org chart or restore it)`);
    for (const m of members.filter((x) => x.status === 'paused')) anomalies.push(`${nameOf(m.agentId)} is paused`);
    for (const r of runs.filter((x) => x.status === 'loop')) anomalies.push(`loop detected in a run by ${nameOf(r.agentId)} on "${tasks.find((t) => t.id === r.taskId)?.title ?? r.taskId.slice(0, 8)}"`);
    const noProgress = tasks.filter((t) => t.noProgressCount >= 2 && !['done', 'cancelled'].includes(t.status));
    for (const t of noProgress) anomalies.push(`"${t.title}" has had ${t.noProgressCount} run(s) without progress`);
    const families = new Set(members.map((m) => m.agentId));
    if (families.size < 2) anomalies.push('single-model review: with one member, the reviewer layer falls back to the independent action reviewer only');
    lines.push('', '## Anomalies');
    lines.push(...(anomalies.length ? anomalies.map((a) => `- ${a}`) : ['- none']));

    // 4. Pending approvals, numbered
    const pending = await this.approvals.pending(orgId);
    const items: BriefItem[] = pending.map((a, i) => ({ n: i + 1, approvalId: a.id, kind: a.kind, summary: summarize(a.kind, JSON.parse(a.payload || '{}') as Record<string, unknown>) }));
    lines.push('', '## Decisions needed');
    if (items.length === 0) lines.push('- none');
    for (const it of items) {
      const a = pending[it.n - 1];
      lines.push(`${it.n}. [${it.kind}] ${it.summary}${a.recommendation ? ` — chief: ${a.recommendation}` : ''}`);
    }
    if (items.length > 0) lines.push('', 'Reply with e.g. "do 1, 3, skip 2" or "revise 2: halve the budget".');

    const text = lines.join('\n');
    const brief: Brief = { orgId, at: now.toISOString(), text, items };
    if (opts.deliver !== false) await this.deliver(brief, org.chiefOfStaffAgentId, org.workspaceId, now, opts.by ?? 'system');
    return brief;
  }

  private async deliver(brief: Brief, chiefId: string | null, workspaceId: string, now: Date, by: string): Promise<void> {
    const ws = await this.workspaces.get(workspaceId).catch(() => null);
    await this.db.update(organizations).set({ lastBriefAt: brief.at, lastBrief: JSON.stringify(brief) }).where(eq(organizations.id, brief.orgId));
    await this.audit.append(brief.orgId, { actor: by, action: 'brief', refType: 'org', refId: brief.orgId, payload: { items: brief.items.length, chars: brief.text.length } });
    if (chiefId) {
      await this.agents.addEvent(chiefId, {
        kind: 'brief', title: `Daily brief — ${brief.items.length} decision(s) needed`, body: brief.text.slice(0, 1_000),
        payload: JSON.stringify({ orgId: brief.orgId, items: brief.items }), origin: 'loop', channel: true,
        ...deliveryFor(ws, 'brief', now),
      }).catch(() => {});
    }
  }

  async latest(orgId: string): Promise<Brief | null> {
    const org = await this.org.get(orgId);
    if (!org.lastBrief) return null;
    try { return JSON.parse(org.lastBrief) as Brief; } catch { return null; }
  }

  /** Resolve a one-line reply against the latest brief's numbering. */
  async reply(orgId: string, text: string, actor = 'user'): Promise<{ decisions: Array<BriefReplyDecision & { approvalId: string; status: string }>; unresolved: string[] }> {
    const brief = await this.latest(orgId);
    if (!brief) throw new BadRequestException('no brief to reply to — compose one first');
    const { decisions, unresolved } = parseBriefReply(text, brief.items.length);
    const out: Array<BriefReplyDecision & { approvalId: string; status: string }> = [];
    for (const d of decisions) {
      const item = brief.items.find((i) => i.n === d.n);
      if (!item) { unresolved.push(`#${d.n}`); continue; }
      try {
        const { approval } = await this.approvals.decide(orgId, item.approvalId, d.decision, d.note ?? '', actor);
        out.push({ ...d, approvalId: item.approvalId, status: approval.status });
      } catch (err) {
        out.push({ ...d, approvalId: item.approvalId, status: `error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    await this.audit.append(orgId, { actor, action: 'brief_reply', refType: 'org', refId: orgId, payload: { decisions: out.map((d) => `${d.n}:${d.decision}`), unresolved } });
    return { decisions: out, unresolved };
  }

  /** Minute tick: write each active org's brief once a day at its hour in
   *  the workspace's timezone (quiet hours only defer delivery). */
  async sweep(now: Date = new Date()): Promise<number> {
    let written = 0;
    for (const org of await this.org.list()) {
      if (org.status !== 'active') continue;
      const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
      const tz = parseQuietHours(ws?.quietHours)?.timezone;
      const local = localParts(now, tz);
      if (local.hour !== org.briefHour) continue;
      if (org.lastBriefAt && localParts(new Date(org.lastBriefAt), tz).day === local.day) continue;
      await this.compose(org.id, { now, deliver: true }).catch(() => undefined);
      written++;
    }
    return written;
  }
}

function pct(a: number, b: number): string { return b > 0 ? `${Math.round((a / b) * 100)}%` : '—'; }
function lastOf(rawList: string): string {
  try { const v = JSON.parse(rawList || '[]') as unknown[]; return String(v.at(-1) ?? 'no owner note'); } catch { return 'no owner note'; }
}

function localParts(d: Date, tz?: string): { hour: number; day: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    return { hour: Number(get('hour')), day: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return { hour: d.getHours(), day: d.toISOString().slice(0, 10) };
  }
}

const APPROVE_WORDS = /^(do|approve|approved|yes|ok|okay|accept|go|ship|run|confirm)$/i;
const REJECT_WORDS = /^(skip|reject|rejected|no|deny|decline|drop|cancel|stop)$/i;
const REVISE_WORDS = /^(revise|rework|change|redo|revisit|adjust)$/i;

/** Parse "do 1, 3, skip 2", "approve 1 and 3, reject 2", "revise 4: halve the budget",
 *  "yes to all". Numbers inherit the most recent verb; a clause without a
 *  verb before its first number is unresolved. */
export function parseBriefReply(text: string, maxN: number): { decisions: BriefReplyDecision[]; unresolved: string[] } {
  const decisions = new Map<number, BriefReplyDecision>();
  const unresolved: string[] = [];
  const clauses = (text ?? '').replace(/\band\b/gi, ',').split(/[,;\n]+/).map((c) => c.trim()).filter(Boolean);
  let verb: ApprovalDecision | null = null;
  for (const clause of clauses) {
    const [head, ...noteParts] = clause.split(':');
    const note = noteParts.join(':').trim() || undefined;
    const tokens = head.replace(/[#.]/g, ' ').split(/\s+/).filter(Boolean);
    let all = false;
    for (const tok of tokens) {
      if (APPROVE_WORDS.test(tok)) verb = 'approve';
      else if (REJECT_WORDS.test(tok)) verb = 'reject';
      else if (REVISE_WORDS.test(tok)) verb = 'revise';
      else if (/^all$/i.test(tok)) all = true;
      else if (/^\d+$/.test(tok)) {
        const n = Number(tok);
        if (!verb) { unresolved.push(tok); continue; }
        if (n < 1 || n > maxN) { unresolved.push(tok); continue; }
        decisions.set(n, { n, decision: verb, note });
      }
    }
    if (all && verb) for (let n = 1; n <= maxN; n++) if (!decisions.has(n)) decisions.set(n, { n, decision: verb, note });
  }
  return { decisions: [...decisions.values()].sort((a, b) => a.n - b.n), unresolved };
}
