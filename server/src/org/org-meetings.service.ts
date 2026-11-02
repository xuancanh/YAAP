/**
 * OrgMeetingsService — meetings, minutes, the decision log and the cadences
 * (docs/company-vision.md §3 and §6, docs/group-chat.md §8, execution-plan
 * item 19). The persistence and policy half; running a meeting (the turns)
 * is OrgMeetingRuntime.
 *
 * A meeting is a row of `org_meetings` and a thread in a unit channel. What
 * this service decides without a model:
 *  - the attendees of a ritual (the unit: lead + direct reports, plus the
 *    human CEO and board) and its facilitator (the lead; the chief for board
 *    meetings);
 *  - the standup agenda, composed from the board — per member: done since
 *    the last standup, in progress, blocked — and from each member's open
 *    tasks; blocked tasks without an owner get the lead as owner;
 *  - the minutes' execution: actions become briefed tasks (assigned when the
 *    facilitator may assign the owner under the unit rules, else backlog for
 *    the chief), decisions become decision-log rows, risks are audited,
 *    questions stay on the minutes for the brief;
 *  - cadence defaults per unit (standup weekdays 09:30, weekly review Fridays
 *    16:00, retro Fridays 16:30 every second week, the board meeting Mondays
 *    09:00 for the root unit), their cron validation and `nextRunAt`.
 * Every table carries accountId; every write that matters is audited.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { orgCadences, orgDecisions, orgMeetings } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { cronMatches } from '../chats/cron.util';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { isQuiet } from '../workspaces/quiet-hours';
import { OrgService, type Organization, type OrgMember } from './org.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgAuditService } from './org-audit.service';
import { OrgApprovalsService } from './org-approvals.service';
import { meetingTunable, meetingKinds, MEETING_TUNABLES } from './meeting-tunables';
import { classifyOpenItem, parseRoom, type MeetingRoom, type OpenItem, type PreReadCounts } from './meeting-room';
import { taskRef } from '../common/task-keys';

export type OrgMeeting = typeof orgMeetings.$inferSelect;
export type OrgDecision = typeof orgDecisions.$inferSelect;
export type OrgCadence = typeof orgCadences.$inferSelect;

export const MEETING_KINDS = ['planning', 'standup', 'weekly_review', 'retro', 'board', 'adhoc'] as const;
export type MeetingKind = typeof MEETING_KINDS[number];
/** `skipped`: a scheduled ritual with an empty agenda skipped itself (docs/meetings.md "Before"). */
export const MEETING_STATUSES = ['scheduled', 'running', 'done', 'cancelled', 'postponed', 'skipped'] as const;
export type MeetingStatus = typeof MEETING_STATUSES[number];

/** Rounds per meeting (§3: at most three — the fence; the org's
 *  `meeting.roundCap` tunable chooses inside it; a standup is one). */
export const MEETING_ROUND_CAP = 3;
/** The absolute fence with Extend (the round cap plus `meeting.extendRounds`, at most two). */
export const MEETING_ROUND_FENCE = MEETING_ROUND_CAP + 2;
export const STANDUP_ROUND_CAP = 1;
/** Retros are "every 2nd Friday": the cron says Friday, this says which. */
export const RETRO_MIN_GAP_DAYS = 13;

export interface Attendee { kind: 'agent' | 'human'; id: string }

/** A person's verdict on a proposal in the room (docs/meetings.md "During"):
 *  a rejected proposal is kept in the minutes but not executed. */
export interface ProposalVerdict { verdict?: 'approved' | 'rejected'; verdictBy?: string; verdictName?: string }
/** `due`: an ISO deadline when the proposer gave one; set on the board task. */
export interface MinutesAction extends ProposalVerdict { title: string; owner: string; done_when: string; outcome: string; by: string; taskId?: string; /** The task's key (docs/tasks-keys.md). */ taskKey?: string | null; messageId?: string; due?: string | null }
export interface MinutesDecision extends ProposalVerdict { title: string; decision: string; alternatives: string; rationale: string; by: string; decisionId?: string; messageId?: string }
export interface MinutesRisk { text: string; by: string }
export interface MinutesQuestion { question: string; by: string; messageId?: string; answer?: string; answeredBy?: string }
/** An off-topic point the facilitator parked (`meeting_park`): in the minutes and a backlog task. */
export interface MinutesParked { text: string; by: string; taskId?: string; taskKey?: string | null }
/** A lesson from a retro (docs/company-vision.md §6, item 22): text with an
 *  audience, optionally a charter change for a member (a CEO approval card)
 *  and a playbook change (a revise task for its owner). Materialised by
 *  OrgMemoryService through `onMaterialise`. */
export interface MinutesLesson {
  text: string;
  audience: 'member' | 'unit' | 'company';
  by: string;
  proposedCharterChange?: { agent: string; text: string; mode?: 'append' | 'replace'; approvalId?: string };
  proposedPlaybookChange?: { playbookId: string; note: string; taskId?: string };
  lessonIds?: string[];
}
export interface Minutes {
  summary: string;
  decisions: MinutesDecision[];
  actions: MinutesAction[];
  risks: MinutesRisk[];
  questions: MinutesQuestion[];
  lessons?: MinutesLesson[];
  parked?: MinutesParked[];
  /** Why the meeting ended: closed | stopped | ended | usd_cap | rounds | passed | items | skipped | cancelled. */
  endedBy?: string;
}

export const KIND_TITLES: Record<MeetingKind, string> = {
  planning: 'Planning', standup: 'Standup', weekly_review: 'Weekly review', retro: 'Retro', board: 'Board meeting', adhoc: 'Meeting',
};

/** The default cadences (docs/company-vision.md §3). Server-local time, as
 *  loops' crons are (cron.util.ts). */
export const DEFAULT_CADENCES: Array<{ kind: MeetingKind; cron: string; rootOnly: boolean }> = [
  { kind: 'standup', cron: '30 9 * * 1-5', rootOnly: false },
  { kind: 'weekly_review', cron: '0 16 * * 5', rootOnly: false },
  { kind: 'retro', cron: '30 16 * * 5', rootOnly: false },
  { kind: 'board', cron: '0 9 * * 1', rootOnly: true },
];

const CRON_FIELD = /^[\d*,/-]+$/;
export function isValidCron(expr: string): boolean {
  const f = (expr ?? '').trim().split(/\s+/);
  return f.length === 5 && f.every((x) => CRON_FIELD.test(x));
}

/** How far ahead a cadence is scanned (a monthly planning fits). */
export const CRON_SCAN_DAYS = 35;

/** The next instant after `from` the cron matches, scanning by the minute
 *  (bounded to CRON_SCAN_DAYS; null when it never matches in that window). */
export function nextCronAfter(expr: string, from: Date): Date | null {
  if (!isValidCron(expr)) return null;
  const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < CRON_SCAN_DAYS * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) if (cronMatches(expr, d)) return new Date(d.getTime());
  return null;
}

export function parseMinutes(raw: string | null | undefined): Minutes {
  const empty: Minutes = { summary: '', decisions: [], actions: [], risks: [], questions: [], lessons: [], parked: [] };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<Minutes>;
    return { ...empty, ...v, decisions: v.decisions ?? [], actions: v.actions ?? [], risks: v.risks ?? [], questions: v.questions ?? [], lessons: v.lessons ?? [], parked: v.parked ?? [] };
  } catch { return empty; }
}

export function parseAttendees(raw: string | null | undefined): Attendee[] {
  try { const v = JSON.parse(raw || '[]') as unknown; return Array.isArray(v) ? (v as Attendee[]).filter((a) => a && (a.kind === 'agent' || a.kind === 'human') && typeof a.id === 'string') : []; } catch { return []; }
}

export function minutesHash(minutes: Minutes): string {
  return createHash('sha256').update(JSON.stringify(minutes)).digest('hex');
}

/** `/meeting <kind> [#unit] [agenda…]` (docs/group-chat.md §8). The first
 *  token names a kind when it is one; otherwise the meeting is ad hoc and the
 *  whole rest is the agenda. Returns null when the text is not the command. */
export function parseMeetingCommand(text: string): { kind: MeetingKind; unitSlug: string | null; agenda: string } | null {
  const m = /^\/meeting(?:\s+([\s\S]*))?$/i.exec((text ?? '').trim());
  if (!m) return null;
  const tokens = (m[1] ?? '').trim().split(/\s+/).filter(Boolean);
  let kind: MeetingKind = 'adhoc';
  if (tokens.length && (MEETING_KINDS as readonly string[]).includes(tokens[0].toLowerCase().replace('-', '_'))) kind = tokens.shift()!.toLowerCase().replace('-', '_') as MeetingKind;
  let unitSlug: string | null = null;
  if (tokens.length && /^#[a-z0-9][a-z0-9-]*$/i.test(tokens[0])) unitSlug = tokens.shift()!.slice(1).toLowerCase();
  return { kind, unitSlug, agenda: tokens.join(' ').slice(0, 4_000) };
}

@Injectable()
export class OrgMeetingsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly units: OrgUnitsService,
    private readonly tasks: OrgTasksService,
    private readonly audit: OrgAuditService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    /** Optional: supervised-mode cadence changes are approval cards this applies. */
    @Optional() private readonly approvals?: OrgApprovalsService,
  ) {
    // A unit that appears gets its default cadences (docs/company-vision.md §3).
    this.org.onStructureChange((orgId) => this.ensureCadenceDefaults(orgId).then(() => undefined));
    this.approvals?.onApply('cadence', (orgId, payload, approval) => this.applyCadenceApproval(orgId, payload, approval.id));
  }

  /** Another module's step in `materialise` (lessons → the lessons store,
   *  charter cards, playbook revisions: OrgMemoryService, item 22). Runs
   *  after the built-in steps, before the minutes are written back. */
  private readonly materialisers: Array<(orgId: string, meeting: OrgMeeting, minutes: Minutes) => Promise<void>> = [];
  onMaterialise(fn: (orgId: string, meeting: OrgMeeting, minutes: Minutes) => Promise<void>): () => void {
    this.materialisers.push(fn);
    return () => { const i = this.materialisers.indexOf(fn); if (i >= 0) this.materialisers.splice(i, 1); };
  }

  /** Round cap, USD cap, daily cap and attendee rule for this org (§1b tunables, clamped). */
  limitsFor(org: Organization): { roundCap: number; usdCap: number; dailyCap: number; attendees: 'unit' | 'leads'; kinds: MeetingKind[] } {
    return {
      roundCap: Math.min(MEETING_ROUND_CAP, meetingTunable(org, 'meeting.roundCap')),
      usdCap: meetingTunable(org, 'meeting.usdCap'),
      dailyCap: meetingTunable(org, 'meeting.dailyCap'),
      attendees: meetingTunable(org, 'meeting.leadsOnly') >= 1 ? 'leads' : 'unit',
      kinds: meetingKinds(org),
    };
  }

  // ---- meetings ----

  async list(orgId: string, opts: { unitId?: string | null; status?: string | null; limit?: number } = {}): Promise<OrgMeeting[]> {
    const conds = [eq(orgMeetings.orgId, orgId)];
    if (opts.unitId) conds.push(eq(orgMeetings.unitId, opts.unitId));
    if (opts.status) conds.push(eq(orgMeetings.status, opts.status));
    return this.db.select().from(orgMeetings).where(and(...conds)).orderBy(desc(orgMeetings.createdAt)).limit(Math.min(500, opts.limit ?? 100));
  }

  async get(orgId: string, meetingId: string): Promise<OrgMeeting> {
    const m = (await this.db.select().from(orgMeetings).where(and(eq(orgMeetings.orgId, orgId), eq(orgMeetings.id, meetingId))).limit(1)).at(0);
    if (!m) throw new NotFoundException(`meeting ${meetingId}`);
    return m;
  }

  /** The meeting a thread root belongs to, if the thread is a meeting. */
  async byThread(threadRootId: string): Promise<OrgMeeting | null> {
    return (await this.db.select().from(orgMeetings).where(eq(orgMeetings.threadRootId, threadRootId)).limit(1)).at(0) ?? null;
  }

  /** Create a meeting row (status scheduled). Attendees default to the unit
   *  (lead + direct reports, the human CEO and board); the facilitator to the
   *  unit lead (the chief for board meetings). */
  async create(orgId: string, input: {
    kind: MeetingKind; unitId?: string | null; channelId?: string | null; agenda?: string; title?: string;
    attendees?: Attendee[]; facilitatorAgentId?: string | null; scheduledFor?: string | null; createdBy?: string;
  }): Promise<OrgMeeting> {
    const org = await this.org.get(orgId);
    if (!MEETING_KINDS.includes(input.kind)) throw new BadRequestException(`kind must be one of ${MEETING_KINDS.join(', ')}`);
    const unit = input.unitId ? await this.units.get(orgId, input.unitId) : (input.kind === 'board' ? await this.units.rootUnit(orgId) : null);
    const channelId = input.channelId ?? unit?.channelId ?? null;
    const facilitator = input.facilitatorAgentId ?? (input.kind === 'board' ? org.chiefOfStaffAgentId : unit?.leadAgentId ?? org.chiefOfStaffAgentId) ?? null;
    if (!facilitator) throw new BadRequestException('a meeting needs a facilitator (the unit lead or the chief of staff)');
    const attendees = input.attendees?.length ? dedupe(input.attendees) : unit ? await this.unitAttendees(orgId, unit) : [{ kind: 'agent' as const, id: facilitator }];
    if (!attendees.some((a) => a.kind === 'agent' && a.id === facilitator)) attendees.unshift({ kind: 'agent', id: facilitator });
    const title = (input.title ?? '').trim().slice(0, 120) || `${KIND_TITLES[input.kind]}${unit ? ` · ${unit.name}` : ''}`;
    const row: OrgMeeting = {
      accountId: currentAccountId(), id: newId(), orgId, unitId: unit?.id ?? null, channelId, threadRootId: null,
      kind: input.kind, title, agenda: (input.agenda ?? '').slice(0, 8_000), facilitatorAgentId: facilitator,
      attendees: JSON.stringify(attendees.slice(0, 12)), status: 'scheduled', scheduledFor: input.scheduledFor ?? null,
      startedAt: null, endedAt: null, rounds: 0, usd: 0, minutes: '', createdBy: input.createdBy ?? 'system', createdAt: nowIso(), minutesPath: null, summary: '',
      room: '', tokensIn: 0, tokensOut: 0,
    };
    await this.db.insert(orgMeetings).values(row);
    await this.audit.append(orgId, { actor: row.createdBy, action: 'meeting_create', refType: 'meeting', refId: row.id, payload: { kind: row.kind, unitId: row.unitId, attendees: attendees.length } });
    return row;
  }

  async update(orgId: string, meetingId: string, patch: Partial<Pick<OrgMeeting, 'status' | 'threadRootId' | 'startedAt' | 'endedAt' | 'rounds' | 'usd' | 'minutes' | 'agenda' | 'scheduledFor' | 'title' | 'minutesPath' | 'summary' | 'tokensIn' | 'tokensOut'>>): Promise<OrgMeeting> {
    await this.get(orgId, meetingId);
    await this.db.update(orgMeetings).set(patch).where(eq(orgMeetings.id, meetingId));
    return this.get(orgId, meetingId);
  }

  /** Replace the attendee list (a person who joins the room, docs/meetings.md "During"). */
  async setAttendees(orgId: string, meetingId: string, attendees: Attendee[]): Promise<void> {
    await this.get(orgId, meetingId);
    await this.db.update(orgMeetings).set({ attendees: JSON.stringify(dedupe(attendees).slice(0, 16)) }).where(eq(orgMeetings.id, meetingId));
  }

  /** Per-meeting chain of room writes: the runtime and the people's controls
   *  read-modify-write one JSON column, one at a time. */
  private readonly roomLocks = new Map<string, Promise<unknown>>();

  /** Change the meeting's room (docs/meetings.md "During") under its lock;
   *  `fn` mutates the parsed room (and may return a value). */
  async patchRoom<T = void>(orgId: string, meetingId: string, fn: (room: MeetingRoom, m: OrgMeeting) => T | Promise<T>): Promise<{ room: MeetingRoom; result: T }> {
    const prev = this.roomLocks.get(meetingId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const m = await this.get(orgId, meetingId);
      const room = parseRoom(m.room);
      const result = await fn(room, m);
      await this.db.update(orgMeetings).set({ room: JSON.stringify(room) }).where(eq(orgMeetings.id, meetingId));
      return { room, result };
    });
    this.roomLocks.set(meetingId, next);
    try { return await next; } finally { if (this.roomLocks.get(meetingId) === next) this.roomLocks.delete(meetingId); }
  }

  // ---- before and after: the previous meeting, its open items, the pre-read ----

  /** The last meeting of the same unit and kind that was held (done), before `m`. */
  async previousOf(orgId: string, m: Pick<OrgMeeting, 'id' | 'unitId' | 'kind' | 'channelId'>): Promise<OrgMeeting | null> {
    if (m.kind === 'adhoc') return null;
    const rows = (await this.list(orgId, { unitId: m.unitId ?? undefined, status: 'done', limit: 100 }))
      .filter((x) => x.id !== m.id && x.kind === m.kind && x.unitId === m.unitId && (m.unitId !== null || x.channelId === m.channelId));
    rows.sort((a, b) => ((a.startedAt ?? a.createdAt) > (b.startedAt ?? b.createdAt) ? -1 : 1));
    return rows[0] ?? null;
  }

  /** The previous meeting's action items, classified from the board tasks
   *  they became: done, blocked, late (not moved since), open, dropped. */
  async openItems(orgId: string, prev: OrgMeeting | null): Promise<OpenItem[]> {
    if (!prev) return [];
    const agreedAt = prev.endedAt ?? prev.startedAt ?? prev.createdAt;
    const out: OpenItem[] = [];
    for (const a of parseMinutes(prev.minutes).actions) {
      if (a.verdict === 'rejected') continue;
      const t = a.taskId ? await this.tasks.get(orgId, a.taskId).catch(() => null) : null;
      out.push({ title: a.title, owner: a.owner.replace(/ \(backlog for the chief\)$/, ''), taskId: a.taskId ?? null, taskKey: t?.key ?? a.taskKey ?? null, state: classifyOpenItem(t, agreedAt), status: t?.status ?? 'unknown', due: t?.dueAt ?? a.due ?? null });
    }
    return out.slice(0, 20);
  }

  /**
   * The facilitator's pre-read for a ritual, composed without a model
   * (docs/meetings.md "Before"): goal check-ins and at-risk goals since the
   * last meeting of this kind (the scorecard deltas), what moved on the
   * board, what is blocked. The counts drive the auto-skip rule.
   */
  async preRead(orgId: string, unit: OrgUnit | null, since: string): Promise<{ text: string; counts: PreReadCounts }> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const root = unit ? unit.parentUnitId === null : true;
    const goals = (await this.org.goals(orgId).catch(() => [])).filter((g) => g.status === 'active' && (root || g.unitId === unit?.id));
    const checkIns = goals.filter((g) => g.lastCheckInAt && g.lastCheckInAt > since);
    const atRisk = goals.filter((g) => g.atRisk === 1);
    const tasks = (await this.tasks.list(orgId)).filter((t) => root || t.unitId === unit?.id);
    const moved = tasks.filter((t) => t.updatedAt > since);
    const done = moved.filter((t) => t.status === 'done');
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const val = (g: typeof goals[number]) => (g.currentValue !== null && g.targetValue !== null ? ` ${g.currentValue}/${g.targetValue}${g.unitLabel ? ` ${g.unitLabel}` : ''}` : '');
    const lines: string[] = [`**Pre-read** (compiled by the facilitator from the record, since ${since.slice(0, 16).replace('T', ' ')} UTC):`];
    lines.push(`- Scorecard: ${checkIns.length ? checkIns.slice(0, 8).map((g) => `${g.title}${val(g)}${g.atRisk ? ' (at risk)' : ' (on pace)'}`).join('; ') : 'no check-in since the last meeting'}`);
    if (atRisk.length) lines.push(`- At risk: ${atRisk.slice(0, 6).map((g) => `${g.title}${g.atRiskReason ? ` — ${g.atRiskReason.slice(0, 120)}` : ''}`).join('; ')}`);
    lines.push(`- Board: ${moved.length ? `${moved.length} task(s) moved, ${done.length} done${done.length ? ` (${done.slice(0, 6).map((t) => t.title).join('; ')})` : ''}` : 'nothing moved'}`);
    lines.push(`- Blocked: ${blocked.length ? blocked.slice(0, 6).map((t) => `${taskRef(t)} ${t.title} — ${nm(t.assigneeAgentId)}`).join('; ') : 'nothing'}`);
    return { text: lines.join('\n'), counts: { deltas: moved.length, blocked: blocked.length, checkIns: checkIns.length, atRisk: atRisk.length } };
  }

  /**
   * How many of the latest meetings of a unit's ritual in a row produced
   * nothing — skipped, or held without a decision or an action that stood
   * (the chief's ritual-retirement review counts these against
   * `chief.sunsetEmptyCycles`).
   */
  async emptyStreak(orgId: string, unitId: string | null, kind: string): Promise<number> {
    const rows = (await this.list(orgId, { unitId: unitId ?? undefined, limit: 200 }))
      .filter((x) => x.kind === kind && x.unitId === unitId && (x.status === 'done' || x.status === 'skipped'))
      .sort((a, b) => ((a.startedAt ?? a.scheduledFor ?? a.createdAt) > (b.startedAt ?? b.scheduledFor ?? b.createdAt) ? -1 : 1));
    let n = 0;
    for (const x of rows) {
      if (x.status === 'done') {
        const mins = parseMinutes(x.minutes);
        if (mins.decisions.some((d) => d.verdict !== 'rejected') || mins.actions.some((a) => a.verdict !== 'rejected')) break;
      }
      n++;
    }
    return n;
  }

  /** Cancel a meeting (the API path; the runtime stops at the next turn). */
  async cancel(orgId: string, meetingId: string, actor = 'user', reason = 'cancelled'): Promise<OrgMeeting> {
    const m = await this.get(orgId, meetingId);
    if (m.status === 'done' || m.status === 'cancelled') return m;
    await this.db.update(orgMeetings).set({ status: 'cancelled', endedAt: nowIso() }).where(eq(orgMeetings.id, meetingId));
    await this.audit.append(orgId, { actor, action: 'meeting_cancel', refType: 'meeting', refId: meetingId, payload: { reason: reason.slice(0, 300), wasRunning: m.status === 'running' } });
    return this.get(orgId, meetingId);
  }

  /** Meetings of a unit that started today (UTC) and were not cancelled or
   *  postponed — the per-unit daily cap counts these. */
  async countToday(orgId: string, unitId: string | null, now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const rows = await this.list(orgId, { unitId: unitId ?? undefined, limit: 500 });
    return rows.filter((m) => m.startedAt?.startsWith(day) && (m.status === 'running' || m.status === 'done')).length;
  }

  /** The unit as attendees: lead + active direct reports (with the `leads`
   *  rule, only the reports that lead units themselves), the human CEO and board. */
  async unitAttendees(orgId: string, unit: OrgUnit): Promise<Attendee[]> {
    const org = await this.org.get(orgId);
    const rule = this.limitsFor(org).attendees;
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const leads = rule === 'leads' ? new Set((await this.units.units(orgId)).map((u) => u.leadAgentId)) : null;
    const agents: Attendee[] = [{ kind: 'agent', id: unit.leadAgentId }, ...members.filter((m) => m.reportsToAgentId === unit.leadAgentId && (!leads || leads.has(m.agentId))).map((m) => ({ kind: 'agent' as const, id: m.agentId }))];
    const humans: Attendee[] = [{ kind: 'human', id: currentAccountId() }];
    for (const h of await this.org.humans(orgId).catch(() => [])) if (h.role === 'ceo' || h.role === 'board') humans.push({ kind: 'human', id: h.memberAccountId });
    return dedupe([...agents, ...humans]).filter((a) => a.kind === 'human' || members.some((m) => m.agentId === a.id));
  }

  // ---- the standup agenda (no model) ----

  /**
   * Compose the standup agenda from the board: per member — done since the
   * last standup, in progress, blocked — plus each member's open tasks
   * anywhere on the board. Blocked tasks without an owner are given to the
   * lead (docs/company-vision.md §3). Returns the agenda text.
   */
  async standupAgenda(orgId: string, unit: OrgUnit, now = new Date()): Promise<{ agenda: string; reassigned: string[] }> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const nm = (id: string | null) => (id ? names.get(id) ?? id.slice(0, 8) : 'nobody');
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const unitMembers = [unit.leadAgentId, ...members.filter((m) => m.reportsToAgentId === unit.leadAgentId).map((m) => m.agentId)];
    const last = (await this.list(orgId, { unitId: unit.id, status: 'done', limit: 50 })).find((m) => m.kind === 'standup');
    const since = last?.endedAt ?? new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const all = await this.tasks.list(orgId);
    const board = all.filter((t) => t.unitId === unit.id);
    const reassigned: string[] = [];
    for (const t of board.filter((x) => x.status === 'blocked' && !x.assigneeAgentId)) {
      await this.tasks.update(orgId, t.id, { assigneeAgentId: unit.leadAgentId }, 'system').catch(() => undefined);
      await this.audit.append(orgId, { actor: 'system', action: 'blocked_owner_assigned', refType: 'task', refId: t.id, payload: { agentId: unit.leadAgentId, unitId: unit.id, via: 'standup' } });
      reassigned.push(t.id);
      t.assigneeAgentId = unit.leadAgentId;
    }
    const lines = [`Standup for ${unit.name} (#${unit.slug}) — since ${since.slice(0, 16).replace('T', ' ')}. Composed from the board; add only what the board cannot know.`];
    for (const agentId of unitMembers) {
      const mine = all.filter((t) => t.assigneeAgentId === agentId);
      const done = mine.filter((t) => t.status === 'done' && t.updatedAt >= since);
      const progress = mine.filter((t) => ['claimed', 'in_progress', 'in_review'].includes(t.status));
      const blocked = mine.filter((t) => t.status === 'blocked');
      const open = mine.filter((t) => ['todo', 'backlog'].includes(t.status));
      lines.push('', `**${nm(agentId)}**${agentId === unit.leadAgentId ? ' (lead)' : ''}`);
      lines.push(`- done: ${done.length ? done.map(short).join('; ') : 'nothing since the last standup'}`);
      lines.push(`- in progress: ${progress.length ? progress.map(short).join('; ') : 'nothing'}`);
      lines.push(`- blocked: ${blocked.length ? blocked.map((t) => `${short(t)} — ${lastBlocker(t)}`).join('; ') : 'nothing'}`);
      if (open.length) lines.push(`- open (not started): ${open.slice(0, 6).map(short).join('; ')}${open.length > 6 ? ` and ${open.length - 6} more` : ''}`);
    }
    const unowned = board.filter((t) => !t.assigneeAgentId && !['done', 'cancelled'].includes(t.status));
    if (unowned.length) lines.push('', `Unowned on this board: ${unowned.map(short).join('; ')}`);
    if (reassigned.length) lines.push(`Blocked without an owner → ${nm(unit.leadAgentId)} now owns: ${reassigned.map((id) => { const x = all.find((t) => t.id === id); return x ? taskRef(x) : `[${id.slice(0, 8)}]`; }).join(', ')}.`);
    return { agenda: lines.join('\n'), reassigned };
  }

  /** The board as a meeting reads it: open tasks and goals of the unit. */
  async boardSnapshot(orgId: string, unit: OrgUnit | null): Promise<string> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    if (!unit) {
      const tasks = (await this.tasks.list(orgId)).filter((t) => !['done', 'cancelled'].includes(t.status)).slice(0, 30);
      return tasks.length ? tasks.map((t) => `${taskRef(t)} (${t.status}) ${t.title} — ${t.assigneeAgentId ? names.get(t.assigneeAgentId) ?? 'agent' : 'nobody'}`).join('\n') : 'The board is empty.';
    }
    return this.units.unitReport(orgId, unit.id, names);
  }

  // ---- minutes → tasks, decisions, questions, risks ----

  /**
   * Execute the minutes (docs/company-vision.md §3): every action becomes a
   * briefed task on the unit board (assigned when the facilitator may assign
   * that owner — the chief anyone, a lead itself and its reports — else the
   * backlog for the chief), every decision a decision-log row, every risk an
   * audit row; questions stay on the minutes (the brief reads them). Writes
   * the minutes and the hash back on the meeting. No model.
   */
  async materialise(orgId: string, meeting: OrgMeeting, minutes: Minutes, opts: { threadRootId?: string | null } = {}): Promise<{ minutes: Minutes; hash: string }> {
    const org = await this.org.get(orgId);
    const members = (await this.org.members(orgId)).filter((m) => m.status === 'active');
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const facilitator = meeting.facilitatorAgentId;
    const isChief = facilitator !== null && facilitator === org.chiefOfStaffAgentId;
    const lead = facilitator ? await this.units.isLead(orgId, facilitator) : null;
    const mayAssign = (m: OrgMember) => isChief || (lead !== null && (m.agentId === facilitator || m.reportsToAgentId === facilitator));
    const resolve = (ref: string): OrgMember | null => {
      const q = (ref ?? '').trim().toLowerCase();
      if (!q) return null;
      return members.find((m) => m.agentId === q || m.agentId.startsWith(q) || (names.get(m.agentId) ?? '').toLowerCase() === q) ?? null;
    };
    const unitName = meeting.unitId ? (await this.units.get(orgId, meeting.unitId).catch(() => null))?.name : null;
    const context = `From the ${KIND_TITLES[meeting.kind as MeetingKind] ?? 'meeting'} "${meeting.title}"${unitName ? ` of ${unitName}` : ''} on ${(meeting.startedAt ?? meeting.createdAt).slice(0, 10)}${meeting.agenda ? `. Agenda: ${meeting.agenda.slice(0, 600)}` : ''}`;
    for (const a of minutes.actions) {
      if (a.taskId || a.verdict === 'rejected') continue;
      const owner = resolve(a.owner);
      const assignee = owner && mayAssign(owner) ? owner.agentId : null;
      const t = await this.tasks.create(orgId, {
        title: a.title, brief: { outcome: a.outcome || a.title, context, constraints: '', done_when: a.done_when },
        assigneeAgentId: assignee, status: assignee ? 'todo' : 'backlog', createdBy: `agent:${a.by || facilitator}`, dueAt: a.due ?? null,
        unitId: meeting.unitId ?? undefined, channelId: meeting.channelId, messageId: opts.threadRootId ?? meeting.threadRootId,
      }).catch(() => null);
      if (t) { a.taskId = t.id; a.taskKey = t.key; if (!assignee && a.owner) a.owner = `${a.owner} (backlog for the chief)`; }
    }
    for (const d of minutes.decisions) {
      if (d.decisionId || d.verdict === 'rejected') continue;
      const row = await this.logDecision(orgId, {
        title: d.title, decision: d.decision, alternatives: d.alternatives, rationale: d.rationale,
        // A person who approved it in the room is its decider.
        decidedBy: d.verdict === 'approved' && d.verdictBy ? d.verdictBy : `agent:${d.by || facilitator}`, unitId: meeting.unitId, meetingId: meeting.id, refType: 'meeting', refId: meeting.id,
      });
      d.decisionId = row.id;
    }
    // The parking lot: each point a backlog task on the unit board.
    for (const p of minutes.parked ?? []) {
      if (p.taskId) continue;
      const t = await this.tasks.create(orgId, {
        title: `Parked: ${p.text}`.slice(0, 200), brief: { outcome: p.text, context: `${context}. Parked in the meeting as off-topic.`, constraints: '', done_when: 'Decided where it belongs, or dropped' },
        assigneeAgentId: null, status: 'backlog', createdBy: `agent:${p.by || facilitator}`,
        unitId: meeting.unitId ?? undefined, channelId: meeting.channelId, messageId: opts.threadRootId ?? meeting.threadRootId,
      }).catch(() => null);
      if (t) { p.taskId = t.id; p.taskKey = t.key; }
    }
    for (const r of minutes.risks) await this.audit.append(orgId, { actor: `agent:${r.by || facilitator}`, action: 'meeting_risk', refType: 'meeting', refId: meeting.id, payload: { text: r.text.slice(0, 600) } });
    for (const fn of this.materialisers) await fn(orgId, meeting, minutes).catch((err: unknown) => this.audit.append(orgId, { actor: 'system', action: 'meeting_materialise_failed', refType: 'meeting', refId: meeting.id, payload: { error: String(err instanceof Error ? err.message : err).slice(0, 300) } }).then(() => undefined));
    const hash = minutesHash(minutes);
    await this.db.update(orgMeetings).set({ minutes: JSON.stringify(minutes) }).where(eq(orgMeetings.id, meeting.id));
    return { minutes, hash };
  }

  /** Minutes as the channel reads them (docs/group-chat.md §8). */
  renderMinutes(meeting: OrgMeeting, minutes: Minutes, names: Map<string, string>): string {
    const nm = (id: string) => names.get(id) ?? id.slice(0, 8);
    const tokens = (meeting.tokensIn ?? 0) + (meeting.tokensOut ?? 0);
    const verdict = (v: ProposalVerdict) => (v.verdict ? ` · ${v.verdict} by ${v.verdictName || 'a person'}` : '');
    const lines = [`**Minutes — ${meeting.title}** (${minutes.endedBy === 'stopped' ? 'ended early' : `${meeting.rounds} round${meeting.rounds === 1 ? '' : 's'}`}, $${meeting.usd.toFixed(2)}${tokens ? `, ${tokens.toLocaleString('en-US')} tokens` : ''})`];
    if (minutes.summary) lines.push('', minutes.summary.slice(0, 2_000));
    lines.push('', `Decisions (${minutes.decisions.length})`, ...(minutes.decisions.length ? minutes.decisions.map((d) => `- ${d.title}: ${d.decision}${d.decisionId ? ` · #decision:${d.decisionId.slice(0, 8)}` : ''}${verdict(d)}`) : ['- none']));
    lines.push('', `Actions (${minutes.actions.length})`, ...(minutes.actions.length ? minutes.actions.map((a) => `- ${a.title} — ${a.owner || 'unowned'}${a.taskId ? ` · task ${a.taskKey || `[${a.taskId.slice(0, 8)}]`}` : ''}${verdict(a)}`) : ['- none']));
    lines.push('', `Risks (${minutes.risks.length})`, ...(minutes.risks.length ? minutes.risks.map((r) => `- ${r.text} (${nm(r.by)})`) : ['- none']));
    lines.push('', `Questions for the CEO (${minutes.questions.length})`, ...(minutes.questions.length ? minutes.questions.map((q) => `- ${q.question} (${nm(q.by)})${q.answer ? ` — answered: ${q.answer}` : ''}`) : ['- none']));
    const parked = minutes.parked ?? [];
    if (parked.length) lines.push('', `Parking lot (${parked.length})`, ...parked.map((p) => `- ${p.text}${p.taskId ? ` · backlog ${p.taskKey || `[${p.taskId.slice(0, 8)}]`}` : ''}`));
    const lessons = minutes.lessons ?? [];
    if (lessons.length) lines.push('', `Lessons (${lessons.length})`, ...lessons.map((l) => `- [${l.audience}] ${l.text}${l.proposedCharterChange ? ` · charter change for ${nm(l.proposedCharterChange.agent)}${l.proposedCharterChange.approvalId ? ` (approval ${l.proposedCharterChange.approvalId.slice(0, 8)})` : ''}` : ''}${l.proposedPlaybookChange ? ` · playbook ${l.proposedPlaybookChange.playbookId.slice(0, 8)}${l.proposedPlaybookChange.taskId ? ` → task [${l.proposedPlaybookChange.taskId.slice(0, 8)}]` : ''}` : ''} (${nm(l.by)})`));
    return lines.join('\n');
  }

  /** Open questions from meetings in the last `days` (the brief's section). */
  async openQuestions(orgId: string, days = 7): Promise<Array<{ meetingId: string; title: string; question: string; by: string; at: string }>> {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const out: Array<{ meetingId: string; title: string; question: string; by: string; at: string }> = [];
    for (const m of (await this.list(orgId, { status: 'done', limit: 100 })).filter((x) => (x.endedAt ?? x.createdAt) >= since)) {
      for (const q of parseMinutes(m.minutes).questions.filter((x) => !x.answer)) out.push({ meetingId: m.id, title: m.title, question: q.question, by: q.by, at: m.endedAt ?? m.createdAt });
    }
    return out;
  }

  // ---- the decision log (§6) ----

  async logDecision(orgId: string, input: { title: string; decision: string; alternatives?: string; rationale?: string; decidedBy: string; unitId?: string | null; meetingId?: string | null; approvalId?: string | null; refType?: string; refId?: string }): Promise<OrgDecision> {
    const title = (input.title ?? '').trim().slice(0, 200);
    if (!title) throw new BadRequestException('decision title is required');
    const row: OrgDecision = {
      accountId: currentAccountId(), id: newId(), orgId, unitId: input.unitId ?? null, meetingId: input.meetingId ?? null, approvalId: input.approvalId ?? null,
      title, decision: (input.decision ?? '').slice(0, 4_000), alternatives: (input.alternatives ?? '').slice(0, 4_000), rationale: (input.rationale ?? '').slice(0, 4_000),
      decidedBy: input.decidedBy.slice(0, 80), refType: input.refType ?? '', refId: input.refId ?? '', createdAt: nowIso(),
    };
    await this.db.insert(orgDecisions).values(row);
    await this.audit.append(orgId, { actor: row.decidedBy, action: 'decision_log', refType: 'decision', refId: row.id, payload: { title, meetingId: row.meetingId, approvalId: row.approvalId } });
    return row;
  }

  async decisions(orgId: string, opts: { unitId?: string | null; limit?: number } = {}): Promise<OrgDecision[]> {
    const conds = [eq(orgDecisions.orgId, orgId)];
    if (opts.unitId) conds.push(eq(orgDecisions.unitId, opts.unitId));
    return this.db.select().from(orgDecisions).where(and(...conds)).orderBy(desc(orgDecisions.createdAt)).limit(Math.min(500, opts.limit ?? 100));
  }

  async decision(orgId: string, id: string): Promise<OrgDecision> {
    const d = (await this.db.select().from(orgDecisions).where(and(eq(orgDecisions.orgId, orgId), eq(orgDecisions.id, id))).limit(1)).at(0);
    if (!d) throw new NotFoundException(`decision ${id}`);
    return d;
  }

  // ---- cadences ----

  async cadences(orgId: string): Promise<OrgCadence[]> {
    return (await this.db.select().from(orgCadences).where(eq(orgCadences.orgId, orgId))).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
  }

  /** One row per (unit, kind) for every live unit; the board cadence for
   *  the root only. Idempotent; returns how many rows were created. */
  async ensureCadenceDefaults(orgId: string, now = new Date()): Promise<number> {
    const org = await this.org.get(orgId).catch(() => null);
    if (!org || org.status === 'archived' || !org.chiefOfStaffAgentId) return 0;
    const units = await this.units.units(orgId).catch(() => [] as OrgUnit[]);
    const existing = await this.cadences(orgId);
    let created = 0;
    for (const u of units) {
      for (const d of DEFAULT_CADENCES) {
        if (d.rootOnly && u.parentUnitId !== null) continue;
        if (existing.some((c) => c.unitId === u.id && c.kind === d.kind)) continue;
        const row: OrgCadence = { accountId: currentAccountId(), id: newId(), orgId, unitId: u.id, kind: d.kind, cron: d.cron, enabled: 1, lastRunAt: null, nextRunAt: nextCronAfter(d.cron, now)?.toISOString() ?? null, createdAt: nowIso() };
        await this.db.insert(orgCadences).values(row).catch(() => undefined);
        created++;
      }
    }
    if (created > 0) await this.audit.append(orgId, { actor: 'system', action: 'cadence_defaults', refType: 'org', refId: orgId, payload: { created } });
    return created;
  }

  async updateCadence(orgId: string, cadenceId: string, patch: { cron?: string; enabled?: boolean }, actor = 'user'): Promise<OrgCadence> {
    const c = (await this.db.select().from(orgCadences).where(and(eq(orgCadences.orgId, orgId), eq(orgCadences.id, cadenceId))).limit(1)).at(0);
    if (!c) throw new NotFoundException(`cadence ${cadenceId}`);
    const set: Partial<OrgCadence> = {};
    if (patch.cron !== undefined) { if (!isValidCron(patch.cron)) throw new BadRequestException('cron must have five fields: minute hour day-of-month month day-of-week'); set.cron = patch.cron.trim(); set.nextRunAt = nextCronAfter(set.cron, new Date())?.toISOString() ?? null; }
    if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
    if (Object.keys(set).length > 0) await this.db.update(orgCadences).set(set).where(eq(orgCadences.id, c.id));
    await this.audit.append(orgId, { actor, action: 'cadence_update', refType: 'cadence', refId: c.id, payload: { ...set } });
    return { ...c, ...set };
  }

  /**
   * The bounds a cadence change must stay inside (docs/company-vision.md §1b:
   * "never more than N meetings a day, never outside quiet hours"): a valid
   * five-field cron, a kind the org holds meetings of, no day with more fires
   * than the unit's daily cap (counted over the coming CRON_SCAN_DAYS), and no fire
   * inside the workspace's quiet window. Returns the refusal, or null.
   */
  async cadenceBoundsError(org: Organization, kind: string, cron: string, now = new Date()): Promise<string | null> {
    if (!MEETING_KINDS.includes(kind as MeetingKind) || kind === 'adhoc') return `kind must be one of ${MEETING_KINDS.filter((k) => k !== 'adhoc').join(', ')}`;
    const limits = this.limitsFor(org);
    if (!limits.kinds.includes(kind as MeetingKind)) return `this company holds no ${kind} meetings (meeting.kinds)`;
    if (!isValidCron(cron)) return 'cron must have five fields: minute hour day-of-month month day-of-week';
    const ws = await this.workspaces.get(org.workspaceId).catch(() => null);
    const perDay = new Map<string, number>();
    const d = new Date(now.getTime()); d.setSeconds(0, 0);
    for (let i = 0; i < CRON_SCAN_DAYS * 24 * 60; i++, d.setMinutes(d.getMinutes() + 1)) {
      if (!cronMatches(cron, d)) continue;
      const day = d.toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
      if (perDay.get(day)! > Math.max(1, limits.dailyCap)) return `refused: that cadence fires more than ${Math.max(1, limits.dailyCap)} time(s) a day (meeting.dailyCap, max ${MEETING_TUNABLES['meeting.dailyCap'].max})`;
      if (ws && isQuiet(ws, d).quiet) return `refused: that cadence fires inside the workspace's quiet hours (${d.toISOString().slice(11, 16)} UTC)`;
    }
    if (perDay.size === 0) return `refused: that cadence never fires in the coming ${CRON_SCAN_DAYS} days`;
    return null;
  }

  /**
   * Set (or switch off) a unit's cadence of `kind` — the chief's and a lead's
   * `org_set_cadence` in autonomous mode, an approved card in supervised
   * mode, or the API. Bounds are checked here (the fence); the change is
   * audited and written to the decision log with its reason (§1b).
   */
  async setCadence(orgId: string, input: { unitId: string; kind: string; cron: string | null; why: string; actor: string; decidedBy: string; approvalId?: string | null }): Promise<OrgCadence> {
    const org = await this.org.get(orgId);
    // The self-modification boundary (docs/boundary.md): cadences are the org's to set alone.
    await this.org.gate(orgId, { kind: 'cadence', key: `${input.unitId}:${input.kind}`, summary: `${input.kind} cadence → ${input.cron ?? 'off'}` }, input.actor);
    const unit = await this.units.get(orgId, input.unitId);
    if (input.cron !== null) {
      const err = await this.cadenceBoundsError(org, input.kind, input.cron);
      if (err) throw new BadRequestException(err);
    } else if (!MEETING_KINDS.includes(input.kind as MeetingKind)) throw new BadRequestException(`kind must be one of ${MEETING_KINDS.join(', ')}`);
    const existing = (await this.cadences(orgId)).find((c) => c.unitId === unit.id && c.kind === input.kind);
    const now = new Date();
    let row: OrgCadence;
    if (existing) {
      const set: Partial<OrgCadence> = input.cron === null ? { enabled: 0 } : { cron: input.cron.trim(), enabled: 1, nextRunAt: nextCronAfter(input.cron, now)?.toISOString() ?? null };
      await this.db.update(orgCadences).set(set).where(eq(orgCadences.id, existing.id));
      row = { ...existing, ...set };
    } else {
      row = { accountId: currentAccountId(), id: newId(), orgId, unitId: unit.id, kind: input.kind, cron: (input.cron ?? '').trim() || '0 0 31 2 *', enabled: input.cron === null ? 0 : 1, lastRunAt: null, nextRunAt: input.cron ? nextCronAfter(input.cron, now)?.toISOString() ?? null : null, createdAt: nowIso() };
      await this.db.insert(orgCadences).values(row);
    }
    await this.audit.append(orgId, { actor: input.actor, action: 'cadence_set', refType: 'cadence', refId: row.id, payload: { unitId: unit.id, kind: input.kind, cron: input.cron, previous: existing ? { cron: existing.cron, enabled: existing.enabled } : null, why: input.why.slice(0, 600), approvalId: input.approvalId ?? null } });
    await this.logDecision(orgId, {
      title: `${KIND_TITLES[input.kind as MeetingKind] ?? input.kind} cadence of ${unit.name}: ${input.cron ?? 'off'}`,
      decision: input.cron ? `Hold the ${input.kind} of ${unit.name} on cron "${input.cron}" (server time).` : `Stop holding the ${input.kind} of ${unit.name}.`,
      alternatives: existing ? `Keep ${existing.enabled ? `"${existing.cron}"` : 'it off'}.` : 'Keep the default.',
      rationale: input.why, decidedBy: input.decidedBy, unitId: unit.id, approvalId: input.approvalId ?? null, refType: 'cadence', refId: row.id,
    });
    return row;
  }

  private async applyCadenceApproval(orgId: string, payload: Record<string, unknown>, approvalId: string): Promise<Record<string, unknown>> {
    const row = await this.setCadence(orgId, {
      unitId: String(payload.unitId ?? ''), kind: String(payload.kind ?? ''), cron: payload.cron ? String(payload.cron) : null,
      why: String(payload.why ?? ''), actor: 'user', decidedBy: 'user', approvalId,
    });
    return { cadenceId: row.id, cron: row.cron, enabled: row.enabled };
  }

  /** Cadences due at `now`: enabled, cron matches this minute, not already
   *  fired this minute; a retro also needs RETRO_MIN_GAP_DAYS since its last run. */
  async due(orgId: string, now: Date): Promise<OrgCadence[]> {
    const minute = now.toISOString().slice(0, 16);
    const kinds = new Set<string>(this.limitsFor(await this.org.get(orgId)).kinds);
    return (await this.cadences(orgId)).filter((c) => c.enabled === 1 && kinds.has(c.kind) && cronMatches(c.cron, now) && (c.lastRunAt ?? '').slice(0, 16) !== minute
      && !(c.kind === 'retro' && c.lastRunAt && now.getTime() - new Date(c.lastRunAt).getTime() < RETRO_MIN_GAP_DAYS * 24 * 60 * 60_000));
  }

  async markFired(cadence: OrgCadence, now: Date): Promise<void> {
    await this.db.update(orgCadences).set({ lastRunAt: now.toISOString(), nextRunAt: nextCronAfter(cadence.cron, now)?.toISOString() ?? null }).where(eq(orgCadences.id, cadence.id));
  }

  /** Whether a ritual of `kind` may fire for this org in its workspace mode
   *  (docs/company-vision.md §3): autonomous runs everything; supervised runs
   *  the conversations (standup, weekly review, retro) but a board meeting only
   *  when a human holds a CEO or board seat in `org_humans`. */
  async cadenceAllowed(org: Organization, kind: string, orgMode: string | undefined): Promise<{ ok: boolean; reason?: string }> {
    if (orgMode === 'autonomous') return { ok: true };
    if (kind === 'standup' || kind === 'weekly_review' || kind === 'retro') return { ok: true };
    if (kind === 'board') {
      const humans = await this.org.humans(org.id).catch(() => []);
      return humans.some((h) => h.role === 'ceo' || h.role === 'board') ? { ok: true } : { ok: false, reason: 'supervised mode: a board meeting needs a human CEO or board member in the organization' };
    }
    return { ok: false, reason: `${kind} meetings are not scheduled in supervised mode` };
  }
}

function dedupe(list: Attendee[]): Attendee[] {
  const seen = new Set<string>();
  return list.filter((a) => { const k = `${a.kind}:${a.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function short(t: OrgTask): string { return `${taskRef(t)} ${t.title}`; }
function lastBlocker(t: OrgTask): string {
  try { const v = JSON.parse(t.blockers || '[]') as unknown[]; return String(v.at(-1) ?? 'no reason given'); } catch { return 'no reason given'; }
}
