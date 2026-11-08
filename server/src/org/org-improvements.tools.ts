/**
 * The improvement tools (docs/improvements.md), offered to org members as
 * a ToolProviderHook beside the runtime's matrix:
 *
 *  - `org_improvements` (read, every member): the proposals by status, one
 *    proposal with its evidence, diff, history and verification, or — with
 *    `sources: true` — where the company's work comes from against its caps;
 *  - `org_improvement_propose` (every member): raise a capped, evidenced
 *    proposal on a process, policy, standard, playbook, charter, cadence or
 *    tunable. Standard changes apply at once; normal ones are decision cards
 *    the proposer's manager decides (org_decide); emergency ones apply during
 *    an open incident and are reviewed afterwards.
 *
 * The chief and the heads get one context line: where work comes from, the
 * proposals open and what waits on what they own.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgImprovementsService } from './org-improvements.service';
import { CATEGORY_WORD, IMPROVEMENT_STATUSES, ORIGIN_WORD, WORK_ORIGINS, type ImprovementCategory } from './improvement-model';

const TOOLS: AiToolSpec[] = [
  { name: 'org_improvements', description: 'Improvement proposals (read-only): by status (proposed | accepted | applied | verified | reverted | rejected | expired), or one by key (IM-3) with its evidence, diff, history and verification. sources: true shows where new work comes from (plans, process steps, service requests, incidents, retros, agent initiative…) against the self-started caps.', inputSchema: { type: 'object', properties: { key: { type: 'string' }, status: { type: 'string', enum: [...IMPROVEMENT_STATUSES] }, sources: { type: 'boolean' }, org: { type: 'string' } } } },
  { name: 'org_improvement_propose', description: 'Propose a change to how the company works instead of creating a task about it: a target, evidence, a hypothesis, the change and the metric it should move. Capped per target and per unit. A standard change (your own, reversible, controls untouched) applies at once; a normal one goes to your manager as a decision card; a mitigation or repair while its incident is open applies at once and is reviewed after. Applied changes are verified against the metric and reverted when they miss.', inputSchema: { type: 'object', properties: {
    title: { type: 'string' },
    target: { type: 'string', description: 'process:<name> | policy:<key> | quality_standard:<slug> | playbook:<name> | charter:<member> | cadence:<kind> | tunable:<key>.' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'What shows the problem: task or run keys, metric values, deviations, lessons, an incident.' },
    hypothesis: { type: 'string', description: 'Why the change fixes it.' },
    change: { type: 'object', description: 'process {def} | policy or quality_standard {fields} | playbook {body} | charter {text, mode} | cadence {cron} or {enabled} | tunable {value}. Omit for a prose change the owner carries out.' },
    diff: { type: 'string', description: 'The change in words when it is not structured.' },
    expected: { type: 'string', description: '"<metric> up|down [by n]": process.deviationRate, process.cycleHours, quality.firstPassYield, work.selfShare, metric:<source id>…' },
    category: { type: 'string', enum: ['investigate', 'mitigate', 'repair', 'detect', 'prevent'] },
    incident: { type: 'string', description: 'The open incident it answers (id).' },
    org: { type: 'string' },
  }, required: ['title', 'evidence', 'hypothesis'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_improvements']);

@Injectable()
export class OrgImprovementsTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly improvements: OrgImprovementsService,
    private readonly config: ConfigService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => READ.has(t.name));
    if (ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? TOOLS : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }

  private readonly cache = new Map<string, { at: number; line: string | null }>();

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit || ctx?.aux) return null;
    const lines: string[] = [];
    for (const m of await this.memberships(session.agentId)) {
      const key = `${m.orgId}:${session.agentId}`;
      let hit = this.cache.get(key);
      if (!hit || Date.now() - hit.at > 5 * 60_000) { hit = { at: Date.now(), line: await this.improvements.contextLine(m.orgId, session.agentId).catch(() => null) }; this.cache.set(key, hit); }
      if (hit.line) lines.push(hit.line);
    }
    return lines.length ? lines.join('\n') : null;
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const ms = await this.memberships(agentId);
    if (ms.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of ms) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (ms.length > 1) throw new Error(`you belong to ${ms.length} organizations — pass org: <name>`);
    return this.org.get(ms[0].orgId);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    switch (name) {
      case 'org_improvements': {
        if (input.sources) {
          const w = await this.improvements.workSources(org.id, { days: 14 });
          const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
          return [
            `New tasks in the last ${w.days} days: ${w.total}. Self-started ${pct(w.selfShare)}, in Operating/Unsorted projects ${pct(w.systemShare)}, from retros ${pct(w.retroShare)}.`,
            ...WORK_ORIGINS.filter((o) => w.byOrigin[o]).map((o) => `- ${ORIGIN_WORD[o]}: ${w.byOrigin[o]}`),
            `Self-started work per unit (cap ${w.caps.selfWip} open, ${w.caps.selfPerDay}/member/day, over the cap: ${w.caps.overCap}): ${w.perUnit.map((u) => `${u.name} ${u.selfOpen}/${u.cap}`).join(', ') || '—'}. Refused ${w.admission.refused}, parked ${w.admission.parked}, wakes deferred ${w.admission.deferredWakes}.`,
            `Proposals: ${w.proposals.opened} opened, ${w.proposals.accepted} accepted, ${w.proposals.applied} applied, ${w.proposals.verified} verified, ${w.proposals.reverted} reverted; ${w.proposals.waiting} awaiting a decision.`,
          ].join('\n');
        }
        if (str('key')) {
          const p = this.improvements.view(await wrap(() => this.improvements.get(org.id, str('key'))));
          return [
            `${p.key} "${p.title}" — ${p.status}${p.reviewPending ? ' (emergency change, review open)' : ''}; ${CATEGORY_WORD[p.category as ImprovementCategory] ?? p.category}, ${p.changeClass} change (${p.classWhy}).`,
            `Target: ${p.targetLabel}. Owner: ${p.owner}. Raised by ${p.proposedBy} (${p.origin}).`,
            `Hypothesis: ${p.hypothesis}`,
            `Evidence:\n${p.evidence.map((e) => `- [${e.kind}] ${e.summary}${e.ref ? ` (${e.ref})` : ''}`).join('\n')}`,
            p.diff.length ? `Change:\n${p.diff.slice(0, 20).join('\n')}` : 'Change: none structured (the owner carries it out).',
            `Expected: ${p.expectedText}${p.baseline !== null ? `; baseline ${p.baseline}` : ''}${p.verifyAt ? `; verified on ${p.verifyAt.slice(0, 10)}` : ''}.`,
            p.verification ? `Verification: ${p.verification.outcome} — ${p.verification.detail}` : '',
            p.lastError ? `Last error: ${p.lastError}` : '',
            `History:\n${p.history.slice(-8).map((h) => `- ${h.at.slice(0, 16)} ${h.from || '·'} → ${h.to} by ${h.by}: ${h.why}`).join('\n')}`,
          ].filter(Boolean).join('\n');
        }
        const rows = await this.improvements.list(org.id, { status: str('status') || undefined, limit: 40 });
        if (!rows.length) return str('status') ? `No ${str('status')} proposals.` : 'No improvement proposals yet. Raise one with org_improvement_propose when evidence shows a standard, policy or process needs to change.';
        return rows.map((p) => `- ${p.key} ${p.status} · ${p.category} · ${p.changeClass} — ${p.title} (${p.targetLabel})`).join('\n');
      }
      case 'org_improvement_propose': {
        const evidence = Array.isArray(input.evidence) ? input.evidence : str('evidence') ? [str('evidence')] : [];
        const r = await wrap(() => this.improvements.createProposal(org.id, {
          title: str('title'), target: str('target') || null, evidence, hypothesis: str('hypothesis'),
          change: input.change && typeof input.change === 'object' ? input.change as Record<string, unknown> : null, diff: str('diff') || undefined,
          expected: str('expected') || null, category: str('category') || undefined, incidentId: str('incident') || null,
        }, `agent:${agentId}`));
        const ctx = this.runtime?.runningCtx(session.id);
        if (ctx) ctx.progress = true;
        return r.text;
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }
}
