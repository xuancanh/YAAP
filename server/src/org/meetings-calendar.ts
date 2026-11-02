/**
 * The meetings list and calendar (docs/meetings.md "The calendar"):
 * `GET /api/workspaces/:id/meetings?unitId=&channel=&from=&to=` returns the
 * meetings held in the range (with their minutes link, attendees and status)
 * and the upcoming occurrences of the cadences, expanded from their crons
 * (server-local time, like the tick that fires them). Every row names its
 * unit, so the standups of two units at 09:30 are told apart.
 *
 * No model; a workspace without an organization answers an empty list.
 */
import { BadRequestException, Controller, Get, Inject, Injectable, NotFoundException, Optional, Param, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, or } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { accounts, channels as channelsTable } from '../database/schema';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { matchField } from '../chats/cron.util';
import { OrgService } from './org.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgMeetingsService, KIND_TITLES, RETRO_MIN_GAP_DAYS, isValidCron, parseAttendees, parseMinutes, type Attendee, type MeetingKind, type MeetingStatus } from './org-meetings.service';

export type CalendarStatus = MeetingStatus | 'upcoming';

export interface CalendarMeeting {
  /** The meeting id, or `cadence:<cadenceId>:<iso>` for an expanded occurrence. */
  id: string;
  source: 'meeting' | 'cadence';
  meetingId: string | null;
  cadenceId: string | null;
  kind: string;
  title: string;
  unitId: string | null;
  unitName: string | null;
  channelId: string | null;
  channelSlug: string | null;
  status: CalendarStatus;
  /** When it starts (started, scheduled, or the cron's next fire). */
  at: string;
  endedAt: string | null;
  facilitator: { id: string; name: string } | null;
  attendees: Array<{ kind: 'agent' | 'human'; id: string; name: string }>;
  minutesPath: string | null;
  summary: string;
  cron: string | null;
  threadRootId: string | null;
  decisions: number;
  actions: number;
  rounds: number;
  usd: number;
  /** Tokens the meeting's turns and minutes call used (docs/meetings.md "Cost"). */
  tokensIn: number;
  tokensOut: number;
}

export interface CalendarResponse { from: string; to: string; now: string; hasOrg: boolean; meetings: CalendarMeeting[] }

/** The widest range one request may cover. */
export const CALENDAR_MAX_DAYS = 93;
/** Occurrences per cadence, at most (an every-minute cron stays bounded). */
export const CALENDAR_MAX_PER_CADENCE = 200;
const DAY_MS = 24 * 60 * 60_000;

const values = (field: string, lo: number, hi: number): number[] => {
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) if (matchField(field, v)) out.push(v);
  return out;
};

/**
 * The instants in [from, to) a five-field cron matches, server-local, with
 * the same field semantics as `cronMatches` (all fields ANDed). Walks days,
 * not minutes; at most `max` results.
 */
export function expandCron(expr: string, from: Date, to: Date, max = CALENDAR_MAX_PER_CADENCE): Date[] {
  if (!isValidCron(expr) || !(from < to)) return [];
  const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
  const minutes = values(mi, 0, 59);
  const hours = values(h, 0, 23);
  if (!minutes.length || !hours.length) return [];
  const out: Date[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let guard = 0; day < to && guard < 400; guard++, day.setDate(day.getDate() + 1)) {
    if (!matchField(dom, day.getDate()) || !matchField(mon, day.getMonth() + 1) || !matchField(dow, day.getDay())) continue;
    for (const hh of hours) {
      for (const mm of minutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
        if (at < from || at >= to) continue;
        out.push(at);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** Retros fire on every second matching day: drop occurrences closer than
 *  RETRO_MIN_GAP_DAYS to the one before (starting from the last run). */
export function retroGap(dates: Date[], lastRunAt: string | null): Date[] {
  let last = lastRunAt ? new Date(lastRunAt).getTime() : null;
  const out: Date[] = [];
  for (const d of dates) {
    if (last !== null && d.getTime() - last < RETRO_MIN_GAP_DAYS * DAY_MS) continue;
    out.push(d); last = d.getTime();
  }
  return out;
}

function parseDate(raw: string | undefined, fallback: Date, name: string): Date {
  if (!raw) return fallback;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date (yyyy-mm-dd or ISO)`);
  return d;
}

@Injectable()
export class MeetingsCalendarService {
  /** Test seam: the clock. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly units: OrgUnitsService,
    private readonly meetings: OrgMeetingsService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async list(workspaceId: string, q: { unitId?: string; channel?: string; from?: string; to?: string } = {}): Promise<CalendarResponse> {
    const now = this.now();
    const from = parseDate(q.from, new Date(now.getTime() - 30 * DAY_MS), 'from');
    let to = parseDate(q.to, new Date(now.getTime() + 30 * DAY_MS), 'to');
    if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) to = new Date(to.getTime() + DAY_MS); // a date "to" includes that day
    if (!(from < to)) throw new BadRequestException('from must be before to');
    if (to.getTime() - from.getTime() > CALENDAR_MAX_DAYS * DAY_MS) throw new BadRequestException(`the range may cover at most ${CALENDAR_MAX_DAYS} days`);
    const base = { from: from.toISOString(), to: to.toISOString(), now: now.toISOString() };
    const org = await this.org.byWorkspace(workspaceId);
    if (!org) return { ...base, hasOrg: false, meetings: [] };

    let channelId: string | null = null;
    if (q.channel) {
      const c = (await this.db.select({ id: channelsTable.id }).from(channelsTable)
        .where(and(eq(channelsTable.workspaceId, workspaceId), or(eq(channelsTable.id, q.channel), eq(channelsTable.slug, q.channel.replace(/^#/, ''))))).limit(1))[0];
      if (!c) throw new NotFoundException(`no channel ${q.channel}`);
      channelId = c.id;
    }
    const allUnits = await this.units.units(org.id).catch(() => [] as OrgUnit[]);
    const unitById = new Map(allUnits.map((u) => [u.id, u]));
    const unitName = (u: OrgUnit | undefined | null) => (u ? (u.parentUnitId === null ? 'Company' : u.name) : null);
    const slugs = new Map((await this.db.select({ id: channelsTable.id, slug: channelsTable.slug }).from(channelsTable).where(eq(channelsTable.workspaceId, workspaceId))).map((c) => [c.id, c.slug]));
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const rows = (await this.meetings.list(org.id, { unitId: q.unitId || null, limit: 500 }))
      .filter((m) => !channelId || m.channelId === channelId);
    const humanIds = new Set<string>();
    for (const m of rows) for (const a of parseAttendees(m.attendees)) if (a.kind === 'human') humanIds.add(a.id);

    // Upcoming: the cadences' fires from now (or `from`) to `to`.
    const ws = await this.workspaces.get(workspaceId).catch(() => null);
    const kinds = new Set<string>(this.meetings.limitsFor(org).kinds);
    const cadences = (await this.meetings.cadences(org.id)).filter((c) => c.enabled === 1 && kinds.has(c.kind)
      && (!q.unitId || c.unitId === q.unitId) && (!channelId || unitById.get(c.unitId)?.channelId === channelId));
    const unitAttendees = new Map<string, Attendee[]>();
    const upcoming: Array<{ c: typeof cadences[number]; at: Date; unit: OrgUnit }> = [];
    const start = from > now ? from : now;
    for (const c of cadences) {
      const unit = unitById.get(c.unitId);
      if (!unit || unit.archivedAt || !(start < to)) continue;
      if (!(await this.meetings.cadenceAllowed(org, c.kind, ws?.orgMode)).ok) continue;
      let dates = expandCron(c.cron, start, to);
      if (c.kind === 'retro') dates = retroGap(expandCron(c.cron, start, to, CALENDAR_MAX_PER_CADENCE * 2), c.lastRunAt).slice(0, CALENDAR_MAX_PER_CADENCE);
      if (!dates.length) continue;
      if (!unitAttendees.has(unit.id)) {
        const list = await this.meetings.unitAttendees(org.id, unit).catch(() => [] as Attendee[]);
        unitAttendees.set(unit.id, list);
        for (const a of list) if (a.kind === 'human') humanIds.add(a.id);
      }
      for (const at of dates) upcoming.push({ c, at, unit });
    }
    const people = new Map<string, string>();
    if (humanIds.size) {
      for (const r of await this.db.select({ id: accounts.id, name: accounts.name, email: accounts.email }).from(accounts).where(inArray(accounts.id, [...humanIds])).catch(() => [])) {
        people.set(r.id, r.name?.trim() || (r.email ? r.email.split('@')[0] : 'person'));
      }
    }
    const named = (list: Attendee[]) => list.map((a) => ({ kind: a.kind, id: a.id, name: a.kind === 'agent' ? names.get(a.id) ?? a.id.slice(0, 8) : people.get(a.id) ?? 'person' }));
    const facilitator = (id: string | null) => (id ? { id, name: names.get(id) ?? id.slice(0, 8) } : null);

    const out: CalendarMeeting[] = [];
    const fromIso = from.toISOString(); const toIso = to.toISOString();
    for (const m of rows) {
      const at = m.startedAt ?? m.scheduledFor ?? m.createdAt;
      if (at < fromIso || at >= toIso) continue;
      const minutes = parseMinutes(m.minutes);
      const unit = m.unitId ? unitById.get(m.unitId) : null;
      out.push({
        id: m.id, source: 'meeting', meetingId: m.id, cadenceId: null, kind: m.kind, title: m.title || KIND_TITLES[m.kind as MeetingKind] || 'Meeting',
        unitId: m.unitId, unitName: unitName(unit), channelId: m.channelId, channelSlug: m.channelId ? slugs.get(m.channelId) ?? null : null,
        status: m.status as MeetingStatus, at, endedAt: m.endedAt, facilitator: facilitator(m.facilitatorAgentId), attendees: named(parseAttendees(m.attendees)),
        minutesPath: m.minutesPath ?? null, summary: m.summary || minutes.summary || '', cron: null, threadRootId: m.threadRootId,
        decisions: minutes.decisions.length, actions: minutes.actions.length, rounds: m.rounds, usd: m.usd, tokensIn: m.tokensIn ?? 0, tokensOut: m.tokensOut ?? 0,
      });
    }
    for (const { c, at, unit } of upcoming) {
      const iso = at.toISOString();
      // A prepared meeting (docs/meetings.md "Before") stands for its occurrence.
      if (rows.some((m) => m.createdBy === 'cadence' && m.unitId === unit.id && m.kind === c.kind && m.scheduledFor && Math.abs(Date.parse(m.scheduledFor) - at.getTime()) < 60_000)) continue;
      const lead = c.kind === 'board' ? org.chiefOfStaffAgentId : unit.leadAgentId;
      out.push({
        id: `cadence:${c.id}:${iso}`, source: 'cadence', meetingId: null, cadenceId: c.id, kind: c.kind, title: `${KIND_TITLES[c.kind as MeetingKind] ?? c.kind} · ${unitName(unit)}`,
        unitId: unit.id, unitName: unitName(unit), channelId: unit.channelId, channelSlug: unit.channelId ? slugs.get(unit.channelId) ?? null : null,
        status: 'upcoming', at: iso, endedAt: null, facilitator: facilitator(lead ?? null), attendees: named(unitAttendees.get(unit.id) ?? []),
        minutesPath: null, summary: '', cron: c.cron, threadRootId: null, decisions: 0, actions: 0, rounds: 0, usd: 0, tokensIn: 0, tokensOut: 0,
      });
    }
    out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.unitName ?? '').localeCompare(b.unitName ?? '')));
    return { ...base, hasOrg: true, meetings: out };
  }
}

/** `GET /api/workspaces/:id/meetings` — the list and calendar (docs/meetings.md). */
@Controller('workspaces/:id/meetings')
export class WorkspaceMeetingsController {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly calendar?: MeetingsCalendarService,
  ) {}

  @Get()
  async list(@Param('id') id: string, @Query('unitId') unitId?: string, @Query('channel') channel?: string, @Query('from') from?: string, @Query('to') to?: string): Promise<CalendarResponse> {
    if (this.config.get<boolean>('companiesEnabled') === false || !this.calendar) {
      const now = new Date();
      return { from: now.toISOString(), to: now.toISOString(), now: now.toISOString(), hasOrg: false, meetings: [] };
    }
    return this.calendar.list(id, { unitId, channel, from, to });
  }
}
