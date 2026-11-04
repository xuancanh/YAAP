/**
 * OrgLearningService — members learn from the moments of their work, without
 * a model (docs/agent-memory.md §12).
 *
 * The audit of a running company found members wrote lessons only when an
 * idle chat happened to distill, and the moments that teach most never
 * became lessons at all: a review that sent work back, a run the breaker
 * stopped, a proposal the CEO turned down with a note. Each of those already
 * produces text written for the member (the reviewer's note, the breaker's
 * reason, the CEO's note), so the reflection step is a template, not a model
 * call: strictly capped, deduped by the lesson store (a repeat counts up
 * instead of adding a row), each with the task key or card as evidence.
 *
 *  - **review sent back** → a lesson for the assignee from the reviewer's
 *    note; when the task is later accepted those lessons are confirmed (the
 *    fix held), which is the recurrence signal;
 *  - **breaker stop** (loop, no progress) → a lesson for the member; the
 *    same stop again counts up;
 *  - **proposal rejected with a note** → a lesson for the member who asked;
 *  - **task accepted** → one journal line (JOURNAL.md stays the log).
 * `memory.captureTriggers` switches each one.
 *
 * **Guidance proposals.** A lesson learned `memory.guidanceRepeats` times
 * (a tunable derived from the profile) is proposed through the company's
 * existing paths — never written: a lesson that names an active playbook
 * becomes a revise task for its owner, any other a `charter_change` card for
 * the CEO with the diff and the lessons it came from. The boundary row
 * `guidance_proposal` (propose) decides; one charter card per member at a
 * time; a lesson is proposed once. The decision closes the proposal's row in
 * agent_guidance_changes, which is what the Memory tab shows as pending.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsService } from '../agents/agents.service';
import { AgentMemoryService, parseEvidence, shortLessonId, type LessonEvent, type LessonRow } from '../agents/agent-memory.service';
import { AgentGuidanceService } from '../agents/agent-guidance.service';
import { AccountsService } from '../accounts/accounts.service';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgApprovalsService, summarize, type OrgApproval } from './org-approvals.service';
import { OrgRuntimeService, type BreakerEvent } from './org-runtime.service';
import { OrgPlaybooksService } from './org-playbooks.service';
import { OrgAuditService } from './org-audit.service';
import { lineDiff } from './org-memory.service';
import { captureOn, deriveMemoryTunables, learningTunable } from './memory-tunables';
import { diagnoseProfile } from './chief-os';
import { taskRef } from '../common/task-keys';

const clip = (t: string, n: number) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const derive = (o: { values?: string | null; culture?: string | null; mission?: string | null }) => deriveMemoryTunables(diagnoseProfile(o));

/** The member's charter as it would read with the learned rules appended. */
export function charterWithLessons(before: string, rules: Array<{ text: string; useCount: number; evidence: string[] }>): string {
  const lines = rules.map((r) => `- ${r.text} (learned ${r.useCount}×${r.evidence.length ? `; ${r.evidence.slice(-2).join(', ')}` : ''})`);
  return `${before.trimEnd()}\n\nLearned in the work:\n${lines.join('\n')}`.trim();
}

@Injectable()
export class OrgLearningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgLearningService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** agentId → a pending proposal check (debounced after a repeat). */
  private readonly checking = new Map<string, Promise<unknown>>();
  /** Test seam: the clock. */
  now: () => Date = () => new Date();

  constructor(
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly approvals: OrgApprovalsService,
    private readonly runtime: OrgRuntimeService,
    private readonly agents: AgentsService,
    private readonly memory: AgentMemoryService,
    private readonly guidance: AgentGuidanceService,
    private readonly config: ConfigService,
    @Optional() private readonly playbooks?: OrgPlaybooksService,
    @Optional() private readonly audit?: OrgAuditService,
    @Optional() private readonly accounts?: AccountsService,
  ) {
    if (!this.enabled()) return;
    this.tasks.onReviewVerdict((ev) => this.onReview(ev));
    this.tasks.onAccepted((ev) => this.onAccepted(ev.orgId, ev.task.id, ev.rounds));
    this.runtime.onBreaker((ev) => this.onBreaker(ev));
    this.approvals.onDecided((ev) => this.onDecided(ev));
    this.memory.onLesson((ev) => this.onLesson(ev));
    this.memory.setStaleDaysResolver(async (agentId) => {
      const org = await this.orgOf(agentId);
      return org ? learningTunable(org, 'memory.lessonStaleDays', derive) : 45;
    });
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    // The quiet loop: proposals for lessons that crossed the threshold while
    // nothing was listening (a restart, a lowered tunable).
    this.timer = setInterval(() => { void this.tick(); }, 30 * 60_000);
  }
  onModuleDestroy(): void { clearInterval(this.timer); }

  /** Resolves once the debounced proposal checks have settled (tests). */
  async idle(): Promise<void> { while (this.checking.size > 0) await Promise.allSettled([...this.checking.values()]); }

  private async tick(): Promise<void> {
    const one = async () => {
      for (const o of await this.org.list()) {
        if (o.status !== 'active') continue;
        for (const m of (await this.org.members(o.id)).filter((x) => x.status === 'active')) {
          await this.proposeGuidance(o.id, m.agentId).catch((err) => this.logger.warn(`guidance check for ${m.agentId} failed: ${err instanceof Error ? err.message : err}`));
        }
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  private async orgOf(agentId: string): Promise<Organization | null> {
    const m = (await this.org.membershipsOf(agentId).catch(() => [])).find((x) => x.status === 'active');
    return m ? this.org.get(m.orgId).catch(() => null) : null;
  }

  // ---- capture ----

  private async onReview(ev: { orgId: string; taskId: string; assigneeAgentId: string | null; verdict: string; note?: string; rounds?: number }): Promise<void> {
    if (ev.verdict === 'accept' || !ev.assigneeAgentId || !ev.note?.trim()) return;
    const org = await this.org.get(ev.orgId).catch(() => null);
    if (!org || !captureOn(org, 'review')) return;
    const t = await this.tasks.get(ev.orgId, ev.taskId).catch(() => null);
    if (!t) return;
    const key = taskRef(t);
    await this.memory.record(ev.assigneeAgentId, `When doing work like "${clip(t.title, 80)}": ${clip(ev.note, 380)}`, {
      source: 'loop', cause: 'review', evidence: [`task:${key}`],
      context: ev.verdict === 'escalate' ? `${key} was escalated by its reviewer` : `${key} was sent back in review (round ${(ev.rounds ?? 0) + 1})`,
      tags: t.class && t.class !== 'general' ? t.class : '',
    }).catch(() => undefined);
  }

  private async onAccepted(orgId: string, taskId: string, rounds: number): Promise<void> {
    const t = await this.tasks.get(orgId, taskId).catch(() => null);
    if (!t) return;
    await this.guidance.decide(t.id, 'approved').catch(() => undefined);
    if (!t.assigneeAgentId) return;
    const org = await this.org.get(orgId).catch(() => null);
    if (!org) return;
    const key = taskRef(t);
    if (rounds > 0) {
      // The fix the reviewer asked for held: the lessons it taught count again.
      for (const l of (await this.memory.list(t.assigneeAgentId, { status: 'active' })).filter((r) => r.cause === 'review' && parseEvidence(r.evidence).includes(`task:${key}`))) {
        await this.memory.confirm(t.assigneeAgentId, l.id, { evidence: [`task:${key}`] }).catch(() => undefined);
      }
    }
    if (captureOn(org, 'journal')) {
      await this.agents.appendJournal(t.assigneeAgentId, `${this.now().toISOString().slice(0, 10)}  ${key} accepted${rounds > 0 ? ` after ${rounds} review round${rounds === 1 ? '' : 's'}` : ''}: ${clip(t.title, 120)}`).catch(() => undefined);
    }
  }

  private async onBreaker(ev: BreakerEvent): Promise<void> {
    if (ev.kind === 'budget_stop') return; // the envelope, not the member's way of working
    const org = await this.org.get(ev.orgId).catch(() => null);
    if (!org || !captureOn(org, 'breaker')) return;
    const t = await this.tasks.get(ev.orgId, ev.taskId).catch(() => null);
    const key = t ? taskRef(t) : '';
    const rule = ev.kind === 'loop'
      ? 'When a tool call gives the same result twice, change the approach (another source, a smaller step) or set the task blocked naming what it waits on, instead of repeating the call.'
      : 'When a run cannot move the task, set it blocked naming what it waits on (or ask for help) instead of ending the run without a change.';
    await this.memory.record(ev.agentId, rule, {
      source: 'loop', cause: 'failure', evidence: key ? [`task:${key}`] : [], context: clip(ev.detail, 280), tags: ev.kind === 'loop' ? 'loop repeated call breaker' : 'no-progress stuck breaker',
    }).catch(() => undefined);
  }

  private async onDecided(ev: { orgId: string; approval: OrgApproval; decision: string; note: string }): Promise<void> {
    const payload = (() => { try { return JSON.parse(ev.approval.payload || '{}') as Record<string, unknown>; } catch { return {}; } })();
    if (ev.approval.kind === 'charter_change' && payload.source === 'lessons' && (ev.decision === 'approve' || ev.decision === 'reject')) {
      await this.guidance.decide(ev.approval.id, ev.decision === 'approve' ? 'approved' : 'rejected').catch(() => undefined);
    }
    if (ev.decision !== 'reject' || !ev.note?.trim()) return;
    const by = ev.approval.requestedBy ?? '';
    if (!by.startsWith('agent:')) return;
    const org = await this.org.get(ev.orgId).catch(() => null);
    if (!org || !captureOn(org, 'decision')) return;
    const what = clip(summarize(ev.approval.kind, payload), 120);
    await this.memory.record(by.slice('agent:'.length), `Before proposing a ${ev.approval.kind.replace(/_/g, ' ')} like "${what}", weigh the CEO's note on the last one: ${clip(ev.note, 300)}`, {
      source: 'loop', cause: 'decision', evidence: [`approval:${ev.approval.id}`], context: `the CEO rejected ${ev.approval.kind.replace(/_/g, ' ')}: ${what}`,
    }).catch(() => undefined);
  }

  // ---- guidance proposals ----

  private onLesson(ev: LessonEvent): void {
    if (!ev.merged || ev.lesson.trusted !== 1 || ev.lesson.useCount < 2) return;
    if (this.checking.has(ev.agentId)) return;
    const p = (async () => {
      const org = await this.orgOf(ev.agentId);
      if (org && org.status === 'active') await this.proposeGuidance(org.id, ev.agentId);
    })().catch(() => undefined).finally(() => this.checking.delete(ev.agentId));
    this.checking.set(ev.agentId, p);
  }

  /**
   * Propose what crossed the threshold: playbook lessons as revise tasks,
   * the rest bundled into one charter card (none while one is pending).
   * Returns what was raised.
   */
  async proposeGuidance(orgId: string, agentId: string): Promise<{ charter?: string; playbooks: string[]; reason?: string }> {
    const org = await this.org.get(orgId);
    if (org.status !== 'active') return { playbooks: [], reason: 'org not active' };
    const member = await this.org.member(orgId, agentId);
    if (!member || member.status !== 'active') return { playbooks: [], reason: 'not an active member' };
    const repeats = learningTunable(org, 'memory.guidanceRepeats', derive);
    const used = await this.guidance.usedLessonIds(agentId);
    const ready = (await this.memory.list(agentId, { trusted: true, status: 'active' }))
      .filter((l) => l.useCount >= repeats && (l.audience ?? 'shared') === 'shared' && !used.has(l.id));
    if (ready.length === 0) return { playbooks: [], reason: `no lesson learned ${repeats}× that was not proposed` };
    const decision = await this.org.boundaryDecide(orgId, { kind: 'guidance_proposal', key: agentId, summary: `propose guidance from ${ready.length} repeated lesson(s)` }, `agent:${agentId}`);
    if (decision.outcome === 'refuse') return { playbooks: [], reason: decision.reason };

    const out: { charter?: string; playbooks: string[] } = { playbooks: [] };
    const active = this.playbooks ? await this.playbooks.list(orgId, { status: 'active' }).catch(() => []) : [];
    const forCharter: LessonRow[] = [];
    for (const l of ready) {
      const hay = `${l.text} ${l.context} ${l.tags}`.toLowerCase();
      const pb = active.find((p) => hay.includes(p.title.toLowerCase()) || hay.includes(`skill_${p.name.replace(/-/g, '_')}`));
      if (pb && this.playbooks) {
        const r = await this.playbooks.reviseTask(orgId, pb.id, { note: `A lesson learned ${l.useCount}× in the work: ${l.text}`, by: agentId }).catch(() => null);
        if (r) {
          await this.guidance.recordProposal(agentId, { kind: 'playbook', text: l.text, lessonIds: [l.id], ref: r.taskId, why: `learned ${l.useCount}× — revise "${pb.title}"` });
          out.playbooks.push(r.taskId);
          continue;
        }
      }
      forCharter.push(l);
    }
    if (forCharter.length === 0) return out;
    const pending = await this.guidance.changes(agentId, { status: 'pending', kind: 'charter' });
    if (pending.length > 0) return { ...out, reason: 'a charter proposal is already waiting on the CEO' };
    const agent = await this.agents.get(agentId);
    const before = agent.charter ?? '';
    const rules = forCharter.slice(0, 5).map((l) => ({ text: l.text, useCount: l.useCount, evidence: parseEvidence(l.evidence).filter((e) => e.startsWith('task:')).map((e) => e.slice(5)) }));
    const after = charterWithLessons(before, rules);
    const lessonIds = forCharter.slice(0, 5).map((l) => l.id);
    const lessonText = forCharter.slice(0, 5).map((l) => `[${shortLessonId(l.id)}] ${l.text} (learned ${l.useCount}×)`).join(' · ');
    const card = await this.approvals.create(orgId, {
      kind: 'charter_change',
      payload: { agentId, agentName: agent.name, before, after, diff: lineDiff(before, after), mode: 'append', lesson: clip(lessonText, 600), source: 'lessons', lessonIds, repeats, boundaryRule: decision.rule.id },
      requestedBy: `agent:${agentId}`,
      recommendation: clip(`${agent.name} keeps learning this in the work (each at least ${repeats}×): ${lessonText}`, 600),
    });
    await this.guidance.recordProposal(agentId, { kind: 'charter', text: after.slice(before.trimEnd().length).trim(), lessonIds, ref: card.id, why: `learned ${repeats}× or more` });
    await this.audit?.append(orgId, { actor: `agent:${agentId}`, action: 'guidance_proposed', refType: 'agent', refId: agentId, payload: { approvalId: card.id, lessonIds, repeats } }).catch(() => undefined);
    await this.agents.addEvent(agentId, { kind: 'info', title: 'A lesson you keep learning was proposed for your charter', body: `The CEO decides the card. Until then keep working from your charter and How you work. ${clip(lessonText, 400)}`, payload: JSON.stringify({ orgId, approvalId: card.id }), origin: 'loop' }).catch(() => undefined);
    out.charter = card.id;
    return out;
  }
}
