/**
 * OrgMemoryService — the company's memory (docs/company-vision.md §6,
 * execution-plan item 22): the tools that write and read it, the
 * postmortem triggers, the lessons a retro produces and the decision-log
 * rows every structural change owes.
 *
 *  - Tools (a ToolProviderHook on the turn loop): `org_write_playbook`
 *    {title, body, roles?, why} for any member, `org_playbooks {role?}`,
 *    `org_decisions {q?, unit?}` (ILIKE over the log) and, for the chief,
 *    `org_recall {question}` — the model-free citation pack of
 *    OrgKnowledgeService, for use inside planning and review runs. Active
 *    playbooks for a member's title are appended to its org context.
 *  - Postmortems: when an objective or key result is abandoned, a task
 *    escalates after the review rounds, a breaker trips twice on one task in
 *    a day, or an audit finding is critical, a `retro` is scheduled for the
 *    owning unit with an agenda built from the record — timeline (audit rows
 *    of the ref), cost (its runs), signals, decisions touching it, playbook
 *    outcomes — and no model. One retro per ref per
 *    `memory.postmortemCooldownDays`; `memory.postmortemTriggers` is the bit
 *    set of what triggers (§1b). Event-driven for abandons and escalations,
 *    a sweep on the memory tick for breakers and findings.
 *  - Lessons: the retro's `meeting_propose_lesson {text, audience, proposed
 *    CharterChange?, proposedPlaybookChange?}` lands in the minutes; when the
 *    minutes materialise, each lesson is recorded in the lessons store of the
 *    agents its audience names (member | unit | company; source `loop`, the
 *    trusted surface), a charter change becomes a `charter_change` approval
 *    card with the diff (the CEO decides; approving writes the charter and
 *    re-accepts its hash), a playbook change becomes a revise task for the
 *    playbook's owner.
 *  - Decision log: every applied approval and every executed autonomous
 *    action writes an `org_decisions` row with alternatives and rationale
 *    from the `why`, unless the owning module already wrote one.
 */
import { BadRequestException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgAudit, orgDecisions } from '../database/schema';
import { AccountsService } from '../accounts/accounts.service';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { AgentMemoryService } from '../agents/agent-memory.service';
import { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import { TriggerBus, type OrgBoardEvent } from '../chats/trigger-bus';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type OrgGoal, type Organization } from './org.service';
import { OrgTasksService, REVIEW_ROUND_CAP, parseBrief } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgApprovalsService, summarize, type OrgApproval } from './org-approvals.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgMeetingsService, type Minutes, type MinutesLesson, type OrgMeeting } from './org-meetings.service';
import { OrgMeetingRuntime } from './org-meeting-runtime.service';
import { OrgSignalsService } from './org-signals.service';
import { OrgPlaybooksService, parseRoles } from './org-playbooks.service';
import { OrgKnowledgeService } from './org-knowledge.service';
import { memoryTunable, postmortemTriggerOn, type PostmortemTrigger } from './memory-tunables';

const DAY_MS = 24 * 60 * 60_000;

/** What a module tells a retro about one of its refs (see addRefDescriber). */
export type RefDescriber = (orgId: string, refId: string) => Promise<{ title: string; subject: string; unitId?: string | null; taskIds?: string[] } | null>;
const TOOL_NAMES = new Set(['org_write_playbook', 'org_playbooks', 'org_decisions', 'org_recall']);

const MEMBER_TOOLS: AiToolSpec[] = [
  { name: 'org_write_playbook', description: 'Write a playbook: a repeatable procedure the company should keep, as a SKILL.md body (steps, checks, pitfalls). It is parked until a reviewer other than you accepts the review task this opens; then it becomes a skill (skill_org_<slug>) offered to the roles you name (titles; empty = everyone). Writing again with the same title proposes a new version. why is required.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string', description: 'The SKILL.md body: when to use it, the steps, what done looks like.' }, roles: { type: 'array', items: { type: 'string' }, description: 'Member titles it is for (e.g. "Writer"); empty for every role.' }, why: { type: 'string', description: 'One line: what this procedure repeats and why keeping it helps.' }, org: { type: 'string' } }, required: ['title', 'body', 'why'] } },
  { name: 'org_playbooks', description: 'List the company\'s active playbooks (reviewed procedures) with their skill tool name, version, roles and outcomes; `role` filters to a title. Load one with its skill_org_* tool.', inputSchema: { type: 'object', properties: { role: { type: 'string' }, status: { type: 'string', enum: ['draft', 'in_review', 'active', 'retired'] }, org: { type: 'string' } } } },
  { name: 'org_decisions', description: 'Search the decision log (docs/company-vision.md §6): what was decided, the alternatives, the rationale, who decided, when. `q` is matched against title, decision and rationale; `unit` narrows to a unit. Cite a decision as #decision:<id> in channels or [decision:<id>] in an answer.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, unit: { type: 'string' }, limit: { type: 'number' }, org: { type: 'string' } } } },
];
const CHIEF_TOOLS: AiToolSpec[] = [
  { name: 'org_recall', description: 'Recall what the company knows about a question, model-free: goals and key results, tasks, decisions, meeting minutes, signals, audit rows and channel messages matched by keyword, each with a citation id ([task:…], [decision:…], [goal:…], [meeting:…], [audit:…]). Use it before planning or reviewing work that touches an old topic ("what did we decide about pricing and what happened after").', inputSchema: { type: 'object', properties: { question: { type: 'string' }, org: { type: 'string' } }, required: ['question'] } },
];

const LESSON_TOOL: AiToolSpec = {
  name: 'meeting_propose_lesson',
  description: 'Propose a lesson for the minutes of this retro (docs/company-vision.md §6): one sentence the company should remember, with an audience — member (you), unit (this unit) or company (everyone). Optionally propose a charter change for a member (text to append to, or replace, their charter; the CEO approves it as a card showing the diff) and/or a playbook change (its owner gets a revise task). Executed when the meeting closes.',
  inputSchema: { type: 'object', properties: {
    text: { type: 'string' }, audience: { type: 'string', enum: ['member', 'unit', 'company'] },
    proposedCharterChange: { type: 'object', properties: { agent: { type: 'string', description: 'Member name.' }, text: { type: 'string', description: 'The charter text to add (or the whole new charter with mode replace).' }, mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['agent', 'text'] },
    proposedPlaybookChange: { type: 'object', properties: { playbookId: { type: 'string', description: 'Playbook id, skill name or title.' }, note: { type: 'string' } }, required: ['playbookId', 'note'] },
  }, required: ['text', 'audience'] },
};

@Injectable()
export class OrgMemoryService implements ToolProviderHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrgMemoryService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** Test seam: the clock. */
  now: () => Date = () => new Date();
  /** refType → how another module describes its refs to a retro (incidents, item 29). */
  private readonly describers = new Map<string, RefDescriber>();

  /** Let another module describe its refs (the "What happened" of the agenda and the unit). */
  addRefDescriber(refType: string, fn: RefDescriber): void { this.describers.set(refType, fn); }

  /** refType:refId → the postmortem consideration in flight (one per ref at a time). */
  private readonly considering = new Map<string, Promise<{ meetingId: string | null; reason?: string }>>();

  /** Resolves once every event-driven postmortem consideration has settled (tests). */
  async idle(): Promise<void> {
    while (this.considering.size > 0) await Promise.allSettled([...this.considering.values()]);
  }

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly meetings: OrgMeetingsService,
    private readonly approvals: OrgApprovalsService,
    private readonly runtime: OrgRuntimeService,
    private readonly turns: TurnLoopService,
    private readonly playbooks: OrgPlaybooksService,
    private readonly knowledge: OrgKnowledgeService,
    private readonly config: ConfigService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly signals?: OrgSignalsService,
    @Optional() private readonly meetingRuntime?: OrgMeetingRuntime,
    /** Optional: without it lessons are kept in the minutes only. */
    @Optional() private readonly memory?: AgentMemoryService,
    @Optional() private readonly bus?: TriggerBus,
    @Optional() private readonly accounts?: AccountsService,
  ) {
    if (!this.enabled()) return;
    this.turns.addToolProvider(this);
    this.meetings.onMaterialise((orgId, meeting, minutes) => this.materialiseLessons(orgId, meeting, minutes));
    this.approvals.onApply('charter_change', (orgId, payload, approval) => this.applyCharterChange(orgId, payload, approval));
    this.approvals.onDecided((ev) => this.logApprovalDecision(ev));
    this.runtime.onAutoAction((ev) => this.logAutoAction(ev));
    this.meetingRuntime?.addMeetingTool({ spec: LESSON_TOOL, kinds: ['retro'], execute: (ctx, input) => this.proposeLesson(ctx, input) });
    this.meetingRuntime?.addAgendaProvider((orgId, m) => (m.kind === 'retro' ? this.playbooks.outcomesSummary(orgId) : Promise.resolve(null)));
    this.org.onGoalChange((goal, before) => this.onGoalChange(goal, before));
    this.bus?.onOrgBoard((ev) => { void this.onBoardEvent(ev); });
  }

  enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.timer = setInterval(() => { void this.tick(this.now()); }, 60_000);
  }

  onModuleDestroy(): void { clearInterval(this.timer); }

  /** The memory tick: the postmortem sweep and the playbook review sync, once per active account. */
  async tick(now: Date): Promise<void> {
    if (!this.enabled()) return;
    const one = async () => {
      for (const org of await this.org.list()) {
        if (org.status !== 'active') continue;
        await this.sweep(org.id, now).catch((err) => this.logger.warn(`memory sweep for org ${org.id} failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    if (!this.accounts) return one();
    await this.accounts.forEachAccount(one);
  }

  // ---- postmortems (docs/company-vision.md §6) ----

  private async onGoalChange(goal: OrgGoal, before: OrgGoal | null): Promise<void> {
    if (goal.status !== 'abandoned' || before?.status === 'abandoned') return;
    if (goal.kind !== 'objective' && goal.kind !== 'key_result') return;
    await this.considerPostmortem(goal.orgId, 'goal_abandoned', 'goal', goal.id).catch(() => undefined);
  }

  private async onBoardEvent(ev: OrgBoardEvent): Promise<void> {
    if (ev.kind !== 'escalation' || !ev.refId) return;
    const t = await this.tasks.get(ev.orgId, ev.refId).catch(() => null);
    if (t && t.reviewRounds >= REVIEW_ROUND_CAP) await this.considerPostmortem(ev.orgId, 'escalation', 'task', t.id).catch(() => undefined);
  }

  /** The model-free sweep: every trigger kind, deduplicated per ref. */
  async sweep(orgId: string, now: Date = this.now()): Promise<Array<{ trigger: PostmortemTrigger; refType: string; refId: string; meetingId: string | null; reason?: string }>> {
    const org = await this.org.get(orgId);
    if (org.status !== 'active') return [];
    await this.playbooks.syncReviews(orgId).catch(() => undefined);
    const out: Array<{ trigger: PostmortemTrigger; refType: string; refId: string; meetingId: string | null; reason?: string }> = [];
    const consider = async (trigger: PostmortemTrigger, refType: string, refId: string) => { out.push({ trigger, refType, refId, ...(await this.considerPostmortem(orgId, trigger, refType, refId, now)) }); };
    for (const g of (await this.org.goals(orgId)).filter((g) => g.status === 'abandoned' && (g.kind === 'objective' || g.kind === 'key_result'))) await consider('goal_abandoned', 'goal', g.id);
    const tasks = await this.tasks.list(orgId);
    for (const t of tasks.filter((t) => t.status === 'blocked' && t.reviewRounds >= REVIEW_ROUND_CAP && listOf(t.blockers).some((b) => b.startsWith('escalated:')))) await consider('escalation', 'task', t.id);
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const trips = new Map<string, number>();
    for (const r of (await this.tasks.runs(orgId, { limit: 500 })).filter((r) => r.startedAt >= since && (r.outcome === 'loop' || r.outcome === 'no_progress'))) trips.set(r.taskId, (trips.get(r.taskId) ?? 0) + 1);
    const needed = memoryTunable(org, 'memory.breakerTrips');
    for (const [taskId, n] of trips) if (n >= needed) await consider('breaker', 'task', taskId);
    if (this.signals) {
      for (const s of (await this.signals.list(orgId, { kind: 'audit_finding', severity: 'critical' })).filter((s) => s.status !== 'resolved')) await consider('audit_critical', 'signal', s.id);
    }
    return out;
  }

  /**
   * Schedule a postmortem retro for `refType:refId` unless the trigger is
   * switched off or one was scheduled for this ref inside the cooldown.
   * Returns the meeting id, or null with the reason.
   */
  async considerPostmortem(orgId: string, trigger: PostmortemTrigger, refType: string, refId: string, now: Date = this.now()): Promise<{ meetingId: string | null; reason?: string }> {
    const key = `${orgId}:${refType}:${refId}`;
    const running = this.considering.get(key);
    if (running) return running;
    const p = this.considerNow(orgId, trigger, refType, refId, now).finally(() => { if (this.considering.get(key) === p) this.considering.delete(key); });
    this.considering.set(key, p);
    return p;
  }

  private async considerNow(orgId: string, trigger: PostmortemTrigger, refType: string, refId: string, now: Date): Promise<{ meetingId: string | null; reason?: string }> {
    const org = await this.org.get(orgId);
    if (org.status !== 'active') return { meetingId: null, reason: 'org not active' };
    if (!postmortemTriggerOn(org, trigger)) return { meetingId: null, reason: `trigger ${trigger} is off (memory.postmortemTriggers)` };
    const cooldownDays = memoryTunable(org, 'memory.postmortemCooldownDays');
    const sinceIso = new Date(now.getTime() - cooldownDays * DAY_MS).toISOString();
    const recent = (await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, orgId), eq(orgAudit.action, 'postmortem_scheduled'), eq(orgAudit.refId, refId), gte(orgAudit.createdAt, sinceIso))).limit(1)).at(0);
    if (recent) return { meetingId: null, reason: `cooldown: a postmortem for this ref was scheduled ${recent.createdAt.slice(0, 10)} (memory.postmortemCooldownDays = ${cooldownDays})` };
    const unit = await this.unitFor(orgId, refType, refId);
    const { agenda, title } = await this.postmortemAgenda(orgId, trigger, refType, refId);
    const input = { kind: 'retro' as const, unitId: unit?.id ?? null, agenda, title: title.slice(0, 120), createdBy: 'postmortem' };
    const meeting = this.meetingRuntime ? await this.meetingRuntime.start(orgId, input) : await this.meetings.create(orgId, input);
    await this.audit.append(orgId, { actor: 'system', action: 'postmortem_scheduled', refType, refId, payload: { trigger, meetingId: meeting.id, unitId: unit?.id ?? null } });
    const lead = unit?.leadAgentId ?? org.chiefOfStaffAgentId;
    if (lead) await this.agents.addEvent(lead, { kind: 'info', title: `Postmortem scheduled: ${title}`.slice(0, 200), body: `Trigger: ${trigger.replace('_', ' ')}. The retro runs in ${unit ? `#${unit.slug}` : 'the company channel'} with an agenda built from the record; bring lessons (meeting_propose_lesson).`, payload: JSON.stringify({ orgId, meetingId: meeting.id, trigger, refType, refId }), origin: 'loop' }).catch(() => undefined);
    return { meetingId: meeting.id };
  }

  private async unitFor(orgId: string, refType: string, refId: string): Promise<OrgUnit | null> {
    if (!this.units) return null;
    const root = await this.units.rootUnit(orgId).catch(() => null);
    try {
      if (refType === 'task') { const t = await this.tasks.get(orgId, refId); return t.unitId ? await this.units.get(orgId, t.unitId) : await this.units.unitForAssignee(orgId, t.assigneeAgentId); }
      if (refType === 'goal') { const g = await this.org.goal(orgId, refId); return g.unitId ? await this.units.get(orgId, g.unitId) : root; }
      if (refType === 'signal' && this.signals) { const s = await this.signals.get(orgId, refId); return s.unitId ? await this.units.get(orgId, s.unitId) : root; }
      const described = this.describers.has(refType) ? await this.describers.get(refType)!(orgId, refId) : null;
      if (described?.unitId) return await this.units.get(orgId, described.unitId);
      if (described?.taskIds?.length) { const t = await this.tasks.get(orgId, described.taskIds[0]); return t.unitId ? await this.units.get(orgId, t.unitId) : await this.units.unitForAssignee(orgId, t.assigneeAgentId); }
    } catch { /* fall through to the root */ }
    return root;
  }

  /** The agenda, from the record and nothing else. */
  async postmortemAgenda(orgId: string, trigger: PostmortemTrigger, refType: string, refId: string): Promise<{ agenda: string; title: string }> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null | undefined) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const lines: string[] = [];
    let title = `Postmortem · ${trigger.replace('_', ' ')}`;
    let subject = '';
    const taskIds: string[] = [];
    if (refType === 'task') {
      const t = await this.tasks.get(orgId, refId);
      const b = parseBrief(t.brief);
      title = `Postmortem · ${t.title}`;
      subject = `Task [${t.id.slice(0, 8)}] "${t.title}" — status ${t.status}, owner ${nm(t.assigneeAgentId)}, ${t.reviewRounds} review round(s), blockers: ${listOf(t.blockers).join('; ') || 'none'}.\nOutcome wanted: ${b.outcome || '(not stated)'}. Done when: ${b.done_when || '(not stated)'}.`;
      taskIds.push(t.id);
    } else if (refType === 'goal') {
      const g = await this.org.goal(orgId, refId);
      title = `Postmortem · ${g.title}`;
      subject = `${g.kind.replace('_', ' ')} [${g.id.slice(0, 8)}] "${g.title}" — status ${g.status}, owner ${nm(g.ownerAgentId)}${g.metric ? `, ${g.metric} ${fmt(g.currentValue ?? g.startValue)} → ${fmt(g.targetValue)}${g.unitLabel ? ` ${g.unitLabel}` : ''}` : ''}${g.dueAt ? `, due ${g.dueAt.slice(0, 10)}` : ''}${g.atRiskReason ? `. Was at risk: ${g.atRiskReason}` : ''}.${g.description ? `\n${g.description.slice(0, 600)}` : ''}`;
      const projects = (await this.org.projects(orgId)).filter((p) => p.goalId === g.id);
      for (const t of (await this.tasks.list(orgId)).filter((t) => t.projectId && projects.some((p) => p.id === t.projectId))) taskIds.push(t.id);
      if (taskIds.length) subject += `\n${taskIds.length} task(s) under it.`;
    } else if (refType === 'signal' && this.signals) {
      const s = await this.signals.get(orgId, refId);
      title = `Postmortem · ${s.title.replace(/^Audit: /, '')}`;
      subject = `Audit finding (signal ${s.id.slice(0, 8)}, ${s.severity}, ${s.status}): ${s.title}${s.detail ? `\n${s.detail}` : ''}\nAbout ${s.refType} ${s.refId}.`;
      const m = /^[a-z_]+:([\w-]+)$/.exec(s.refId);
      if (s.refType === 'task' && m) taskIds.push(m[1]);
    } else if (this.describers.has(refType)) {
      const d = await this.describers.get(refType)!(orgId, refId).catch(() => null);
      if (d) { title = `Postmortem · ${d.title}`; subject = d.subject; taskIds.push(...(d.taskIds ?? [])); }
    }
    lines.push(`**Why this retro**: ${describeTrigger(trigger)}.`, '', '## What happened', subject || `${refType} ${refId}`);
    // Timeline: the audit rows of the ref (and of its tasks), oldest first.
    const refIds = [refId, ...taskIds.filter((id) => id !== refId)];
    const rows: Array<typeof orgAudit.$inferSelect> = [];
    for (const id of refIds.slice(0, 20)) rows.push(...(await this.db.select().from(orgAudit).where(and(eq(orgAudit.orgId, orgId), eq(orgAudit.refId, id))).orderBy(desc(orgAudit.seq)).limit(40)));
    rows.sort((a, b) => a.seq - b.seq);
    const shown = rows.slice(-30);
    lines.push('', `## Timeline (${rows.length} audit row(s)${rows.length > shown.length ? `, last ${shown.length}` : ''})`, ...(shown.length ? shown.map((r) => `- [audit:${r.seq}] ${r.createdAt.slice(0, 16).replace('T', ' ')} ${r.actor} ${r.action}${r.payload && r.payload !== '{}' ? ` ${r.payload.slice(0, 140)}` : ''}`) : ['- nothing recorded']));
    // Cost: the runs of the task(s).
    if (taskIds.length) {
      const runs = (await this.tasks.runs(orgId, { limit: 500 })).filter((r) => taskIds.includes(r.taskId));
      const usd = runs.reduce((a, r) => a + r.usd, 0);
      const by = new Map<string, number>();
      for (const r of runs) by.set(r.outcome || r.status, (by.get(r.outcome || r.status) ?? 0) + 1);
      lines.push('', '## Cost', `${runs.length} run(s), $${usd.toFixed(2)}, ${runs.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0)} tokens${by.size ? ` — outcomes: ${[...by].map(([k, v]) => `${k} ×${v}`).join(', ')}` : ''}.`);
    }
    // Signals about the ref.
    if (this.signals) {
      const sig = (await this.signals.list(orgId)).filter((s) => refIds.includes(s.refId) || s.refId.endsWith(`:${refId}`) || s.id === refId).slice(0, 12);
      lines.push('', `## Signals (${sig.length})`, ...(sig.length ? sig.map((s) => `- ${s.severity} ${s.kind} (${s.status}) ${s.title}${s.ackNote ? ` — ack: ${s.ackNote.slice(0, 120)}` : ''}`) : ['- none']));
    }
    // Decisions touching it: by ref, or by title words in the decision text.
    const words = (subject.split('"')[1] ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 4).slice(0, 6);
    const decisions = (await this.db.select().from(orgDecisions).where(eq(orgDecisions.orgId, orgId)).orderBy(desc(orgDecisions.createdAt)).limit(300))
      .filter((d) => refIds.includes(d.refId) || (words.length > 0 && words.filter((w) => `${d.title} ${d.decision}`.toLowerCase().includes(w)).length >= Math.min(2, words.length))).slice(0, 10);
    lines.push('', `## Decisions touching it (${decisions.length})`, ...(decisions.length ? decisions.map((d) => `- #decision:${d.id.slice(0, 8)} ${d.createdAt.slice(0, 10)} "${d.title}": ${d.decision.slice(0, 200)} (${d.decidedBy})`) : ['- none in the log']));
    const outcomes = await this.playbooks.outcomesSummary(orgId).catch(() => null);
    if (outcomes) lines.push('', outcomes);
    lines.push('', '## What this retro produces', 'Lessons with an audience (meeting_propose_lesson: member | unit | company), a charter change where a member\'s purpose misled it (the CEO approves the diff), a playbook change where a procedure misled (its owner gets a revise task), and the actions that stop this repeating. Say what the record shows, not what it should have shown.');
    return { agenda: lines.join('\n').slice(0, 12_000), title };
  }

  // ---- lessons (the retro's output) ----

  private async proposeLesson(ctx: { meeting: OrgMeeting; orgId: string; agentId: string; minutes: Minutes; post(text: string): Promise<void> }, input: Record<string, unknown>): Promise<string> {
    const str = (k: string, o: Record<string, unknown> = input) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const text = str('text');
    const audience = str('audience') as MinutesLesson['audience'];
    if (!text) throw new Error('text is required');
    if (!['member', 'unit', 'company'].includes(audience)) throw new Error('audience must be member, unit or company');
    ctx.minutes.lessons ??= [];
    if (ctx.minutes.lessons.length >= 20) throw new Error('the minutes already hold 20 lessons');
    const lesson: MinutesLesson = { text: text.slice(0, 1_000), audience, by: ctx.agentId };
    const cc = input.proposedCharterChange as Record<string, unknown> | undefined;
    if (cc && typeof cc === 'object') {
      const agent = str('agent', cc); const t = str('text', cc);
      if (!agent || !t) throw new Error('proposedCharterChange needs agent and text');
      const members = await this.org.members(ctx.orgId);
      const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
      const q = agent.toLowerCase();
      const m = members.find((x) => x.status !== 'terminated' && (x.agentId === q || x.agentId.startsWith(q) || (names.get(x.agentId) ?? '').toLowerCase() === q));
      if (!m) throw new Error(`no member "${agent}"`);
      lesson.proposedCharterChange = { agent: m.agentId, text: t.slice(0, 8_000), mode: str('mode', cc) === 'replace' ? 'replace' : 'append' };
    }
    const pc = input.proposedPlaybookChange as Record<string, unknown> | undefined;
    if (pc && typeof pc === 'object') {
      const ref = str('playbookId', pc); const note = str('note', pc);
      if (!ref || !note) throw new Error('proposedPlaybookChange needs playbookId and note');
      const pb = await this.playbooks.byRef(ctx.orgId, ref).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
      lesson.proposedPlaybookChange = { playbookId: pb.id, note: note.slice(0, 2_000) };
    }
    ctx.minutes.lessons.push(lesson);
    await ctx.post(`Lesson (${audience}): ${text}${lesson.proposedCharterChange ? ` · proposes a charter change for ${(await this.agents.get(lesson.proposedCharterChange.agent).catch(() => null))?.name ?? 'a member'}` : ''}${lesson.proposedPlaybookChange ? ` · proposes a playbook change (${lesson.proposedPlaybookChange.playbookId.slice(0, 8)})` : ''}`);
    return `Lesson recorded for the minutes (${ctx.minutes.lessons.length} so far). When the meeting closes it is written to the ${audience === 'member' ? 'your' : `${audience}'s`} lessons${lesson.proposedCharterChange ? ', the charter change goes to the CEO as a card with the diff' : ''}${lesson.proposedPlaybookChange ? ', the playbook owner gets a revise task' : ''}.`;
  }

  /** The materialise step for lessons: the lessons store per audience, a
   *  `charter_change` card, a playbook revise task. Idempotent per lesson. */
  async materialiseLessons(orgId: string, meeting: OrgMeeting, minutes: Minutes): Promise<void> {
    const lessons = minutes.lessons ?? [];
    if (lessons.length === 0) return;
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const unit = meeting.unitId && this.units ? await this.units.get(orgId, meeting.unitId).catch(() => null) : null;
    const unitAgents = unit ? [unit.leadAgentId, ...members.filter((m) => m.reportsToAgentId === unit.leadAgentId).map((m) => m.agentId)] : members.map((m) => m.agentId);
    for (const l of lessons) {
      if (!l.lessonIds) {
        const targets = l.audience === 'member' ? [l.by] : l.audience === 'unit' ? unitAgents : members.map((m) => m.agentId);
        const ids: string[] = [];
        for (const agentId of [...new Set(targets)].filter((id) => members.some((m) => m.agentId === id))) {
          const r = await this.memory?.record(agentId, `Retro lesson (${l.audience}, "${meeting.title}"): ${l.text}`, { source: 'loop', audience: 'shared' }).catch(() => null);
          if (r) ids.push(r.lesson.id);
        }
        l.lessonIds = ids;
        await this.audit.append(orgId, { actor: `agent:${l.by}`, action: 'lesson_recorded', refType: 'meeting', refId: meeting.id, payload: { audience: l.audience, agents: ids.length, text: l.text.slice(0, 300) } });
      }
      if (l.proposedCharterChange && !l.proposedCharterChange.approvalId) {
        const target = await this.agents.get(l.proposedCharterChange.agent).catch(() => null);
        if (target) {
          const before = target.charter ?? '';
          const after = l.proposedCharterChange.mode === 'replace' ? l.proposedCharterChange.text : `${before.trimEnd()}\n\n${l.proposedCharterChange.text}`.trim();
          const a = await this.approvals.create(orgId, {
            kind: 'charter_change',
            payload: { agentId: target.id, agentName: target.name, before, after, diff: lineDiff(before, after), mode: l.proposedCharterChange.mode ?? 'append', lesson: l.text, meetingId: meeting.id, proposedBy: l.by },
            requestedBy: `agent:${l.by}`, recommendation: `From the retro "${meeting.title}": ${l.text}`.slice(0, 600),
          });
          l.proposedCharterChange.approvalId = a.id;
          await this.audit.append(orgId, { actor: `agent:${l.by}`, action: 'charter_change_proposed', refType: 'agent', refId: target.id, payload: { approvalId: a.id, meetingId: meeting.id, mode: l.proposedCharterChange.mode ?? 'append' } });
        }
      }
      if (l.proposedPlaybookChange && !l.proposedPlaybookChange.taskId) {
        const r = await this.playbooks.reviseTask(orgId, l.proposedPlaybookChange.playbookId, { note: `${l.text} — ${l.proposedPlaybookChange.note}`, by: l.by, meetingId: meeting.id }).catch(() => null);
        if (r) l.proposedPlaybookChange.taskId = r.taskId;
      }
    }
  }

  /** The CEO approved a charter change: write the charter and re-accept its hash. */
  private async applyCharterChange(orgId: string, payload: Record<string, unknown>, approval: OrgApproval): Promise<Record<string, unknown>> {
    const agentId = String(payload.agentId ?? '');
    const after = String(payload.after ?? '');
    if (!agentId || !after.trim()) throw new BadRequestException('charter_change needs agentId and the new charter');
    const member = await this.org.member(orgId, agentId);
    if (!member || member.status === 'terminated') throw new BadRequestException('that member is no longer in the organization');
    await this.agents.update(agentId, { charter: after });
    const m = await this.org.acceptCharter(orgId, agentId, 'user');
    await this.audit.append(orgId, { actor: 'user', action: 'charter_change_applied', refType: 'agent', refId: agentId, payload: { approvalId: approval.id, hash: m.charterHash, meetingId: payload.meetingId ?? null } });
    await this.agents.addEvent(agentId, { kind: 'info', title: 'Your charter changed', body: `The CEO approved a change from a retro: ${String(payload.lesson ?? '').slice(0, 600)}`, payload: JSON.stringify({ orgId, approvalId: approval.id }), origin: 'user' }).catch(() => undefined);
    return { agentId, charterHash: m.charterHash };
  }

  // ---- the decision log for approvals and autonomous actions ----

  private async logApprovalDecision(ev: { orgId: string; approval: OrgApproval; decision: string; note: string; result?: Record<string, unknown>; decidedBy: string }): Promise<void> {
    if (ev.decision !== 'approve' && ev.decision !== 'reject') return;
    const existing = (await this.db.select().from(orgDecisions).where(and(eq(orgDecisions.orgId, ev.orgId), eq(orgDecisions.approvalId, ev.approval.id))).limit(1)).at(0);
    if (existing) return;
    const payload = parseJson(ev.approval.payload);
    const summary = summarize(ev.approval.kind, payload);
    const why = String(payload.why ?? payload.reason ?? ev.approval.recommendation ?? '').trim();
    await this.meetings.logDecision(ev.orgId, {
      title: `${ev.approval.kind.replace('_', ' ')}: ${summary}`.slice(0, 200),
      decision: ev.decision === 'approve' ? `Approved: ${summary}.` : `Rejected: ${summary}.`,
      alternatives: ev.decision === 'approve' ? 'Reject it, or ask for a revision.' : 'Approve it as proposed.',
      rationale: [why ? `Proposed because: ${why}` : '', ev.note ? `Decision note: ${ev.note}` : ''].filter(Boolean).join(' ') || `${ev.decision}d by the CEO without a note`,
      decidedBy: ev.decidedBy && ev.decidedBy !== currentAccountId() ? `human:${ev.decidedBy}`.slice(0, 80) : 'user', approvalId: ev.approval.id, refType: 'approval', refId: ev.approval.id,
      unitId: typeof payload.unitId === 'string' ? payload.unitId : null,
    }).catch((err) => this.logger.warn(`decision log for approval ${ev.approval.id} failed: ${err instanceof Error ? err.message : err}`));
  }

  private async logAutoAction(ev: { orgId: string; action: string; summary: string; reason: string; payload: Record<string, unknown>; actor: string }): Promise<void> {
    const verb = ev.action === 'tune' ? 'Tuned' : ev.action === 'hire' ? 'Hired' : ev.action === 'reorg' ? 'Reorganized' : ev.action === 'scope_widen' ? 'Widened scopes' : ev.action === 'budget' ? 'Allocated budget' : 'Terminated';
    await this.meetings.logDecision(ev.orgId, {
      title: `Autonomous ${ev.action.replace('_', ' ')}: ${ev.summary}`.slice(0, 200),
      decision: `${verb}: ${ev.summary}.`,
      alternatives: ev.action === 'tune' ? `Keep ${String(ev.payload.key ?? 'the tunable')} at ${String(ev.payload.from ?? 'its value')}.` : 'Leave the structure as it was, or propose it to the CEO instead.',
      rationale: ev.reason, decidedBy: ev.actor, refType: ev.action === 'tune' ? 'tunable' : 'org', refId: ev.action === 'tune' ? String(ev.payload.key ?? '') : ev.orgId,
    }).catch((err) => this.logger.warn(`decision log for auto ${ev.action} failed: ${err instanceof Error ? err.message : err}`));
  }

  // ---- ToolProviderHook ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const memberships = (await this.org.membershipsOf(session.agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) return [];
    const chief = (await Promise.all(memberships.map((m) => this.org.get(m.orgId).catch(() => null)))).some((o) => o?.chiefOfStaffAgentId === session.agentId);
    return chief ? [...MEMBER_TOOLS, ...CHIEF_TOOLS] : MEMBER_TOOLS;
  }

  owns(name: string): boolean { return TOOL_NAMES.has(name); }

  /** org_write_playbook creates a parked skill and a review task — a proposal
   *  the review gates, so like the other org proposals it runs as a read. */
  isReadOnly(name: string): boolean { return TOOL_NAMES.has(name); }

  /** The playbooks offered to this member's role, per organization. */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const blocks: string[] = [];
    for (const m of (await this.org.membershipsOf(session.agentId)).filter((x) => x.status === 'active')) {
      const block = await this.playbooks.contextBlock(m.orgId, session.agentId).catch(() => null);
      if (block) blocks.push(block);
    }
    return blocks.length ? blocks.join('\n\n') : null;
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const member = await this.org.member(org.id, agentId);
    if (!member || member.status !== 'active') throw new Error(`you are not an active member of "${org.name}"`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    switch (name) {
      case 'org_write_playbook': {
        const ctx = this.runtime.runningCtx(session.id);
        const roles = Array.isArray(input.roles) ? input.roles.map(String) : [];
        const r = await this.playbooks.write(org.id, { title: str('title'), body: str('body'), roles, why: str('why'), authorAgentId: agentId, sourceTaskId: ctx?.taskId || null }).catch((err: unknown) => { throw new Error(err instanceof Error ? err.message : String(err)); });
        if (ctx) ctx.progress = true;
        return `Playbook "${r.playbook.title}" v${r.playbook.version} written (${r.playbook.name}; ${r.created ? 'new' : 'a new version'}) and sent to review: task [${r.task.id.slice(0, 8)}], reviewer ${r.task.reviewerAgentId ? names.get(r.task.reviewerAgentId) ?? r.task.reviewerAgentId.slice(0, 8) : 'none available — the CEO reviews'}. It becomes callable as skill_${r.playbook.name.replace(/-/g, '_')} for ${parseRoles(r.playbook.roles).join(', ') || 'every role'} when the review accepts it; until then keep working without it.`;
      }
      case 'org_playbooks': {
        const status = str('status') || 'active';
        const rows = await this.playbooks.list(org.id, { status, role: str('role') || null });
        if (rows.length === 0) return `No ${status} playbooks${str('role') ? ` for ${str('role')}` : ''}. Write one with org_write_playbook when you find a procedure worth repeating.`;
        return rows.map((p) => { const o = JSON.parse(p.outcomes || '{}') as { uses?: number; up?: number; down?: number }; return `- [${p.id.slice(0, 8)}] skill_${p.name.replace(/-/g, '_')} v${p.version} (${p.status}) "${p.title}" — for ${parseRoles(p.roles).join(', ') || 'everyone'}; owner ${p.ownerAgentId ? names.get(p.ownerAgentId) ?? p.ownerAgentId.slice(0, 8) : 'nobody'}${typeof o.uses === 'number' ? `; ${o.uses} use(s), ${o.up ?? 0} 👍 / ${o.down ?? 0} 👎` : ''}`; }).join('\n');
      }
      case 'org_decisions': {
        const unitId = str('unit') && this.units ? (await this.units.units(org.id)).find((u) => { const q = str('unit').toLowerCase().replace(/^#/, ''); return u.id === q || u.id.startsWith(q) || u.slug === q || u.name.toLowerCase() === q; })?.id : undefined;
        if (str('unit') && !unitId) throw new Error(`no unit "${str('unit')}"`);
        const rows = await this.knowledge.searchDecisions(org.id, str('q'), { unitId: unitId ?? null, limit: Math.min(50, Number(input.limit) || 20) });
        if (rows.length === 0) return str('q') ? `No decision matches "${str('q')}".` : 'The decision log is empty.';
        return rows.map((d) => `- [decision:${d.id}] ${d.createdAt.slice(0, 16).replace('T', ' ')} "${d.title}": ${d.decision.slice(0, 300)}${d.alternatives ? ` · alternatives: ${d.alternatives.slice(0, 160)}` : ''}${d.rationale ? ` · because: ${d.rationale.slice(0, 200)}` : ''} — ${d.decidedBy}${d.meetingId ? `, meeting ${d.meetingId.slice(0, 8)}` : d.approvalId ? `, approval ${d.approvalId.slice(0, 8)}` : ''}`).join('\n');
      }
      case 'org_recall': {
        if (!isChief) throw new Error('org_recall is a chief-of-staff tool');
        const question = str('question');
        if (!question) throw new Error('question is required');
        const pack = await this.knowledge.recall(org.id, question);
        await this.audit.append(org.id, { actor: 'chief', action: 'recall', refType: 'org', refId: org.id, payload: { chars: question.length, keywords: pack.keywords.slice(0, 10), hits: { goals: pack.goals.length, tasks: pack.tasks.length, decisions: pack.decisions.length, meetings: pack.meetings.length, audit: pack.audit.length, messages: pack.messages.length } } });
        return this.knowledge.renderPack(pack);
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }

  private async resolveOrg(agentId: string, orgHint: unknown): Promise<Organization> {
    const memberships = (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) throw new Error('you do not belong to an organization');
    if (typeof orgHint === 'string' && orgHint.trim()) {
      const q = orgHint.trim().toLowerCase();
      for (const m of memberships) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${orgHint}"`);
    }
    if (memberships.length > 1) throw new Error(`you belong to ${memberships.length} organizations — pass org: <name>`);
    return this.org.get(memberships[0].orgId);
  }

  /** Ask the company (the API): `OrgKnowledgeService.answer` with the asker named. */
  ask(orgId: string, question: string, asker: string) { return this.knowledge.answer(orgId, question, { asker }); }
}

function describeTrigger(t: PostmortemTrigger): string {
  switch (t) {
    case 'goal_abandoned': return 'an objective or key result was abandoned';
    case 'escalation': return `a task escalated to the CEO after ${REVIEW_ROUND_CAP} review rounds`;
    case 'breaker': return 'a circuit breaker tripped repeatedly on one task (loop or no-progress stops)';
    case 'audit_critical': return 'the auditor recorded a critical finding';
    case 'incident': return 'a major or critical incident was opened and contained';
  }
}

/** A small line diff for the approval card: lines only in `before` as `-`,
 *  only in `after` as `+`, shared lines kept in order of `after`. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n'); const b = after.split('\n');
  const inA = new Map<string, number>(); for (const l of a) inA.set(l, (inA.get(l) ?? 0) + 1);
  const inB = new Map<string, number>(); for (const l of b) inB.set(l, (inB.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of a) if (!inB.has(l)) out.push(`- ${l}`);
  for (const l of b) out.push(inA.has(l) ? `  ${l}` : `+ ${l}`);
  return out.join('\n').slice(0, 16_000);
}

function parseJson(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}') as unknown; return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}
function listOf(raw: string): string[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}
function fmt(v: number | null | undefined): string { return v === null || v === undefined ? '?' : Number.isInteger(v) ? String(v) : v.toFixed(2); }

