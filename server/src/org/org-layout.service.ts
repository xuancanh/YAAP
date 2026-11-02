/**
 * OrgLayoutService — keeps the company's folder predictable
 * (docs/filesystem.md "Layout", server/src/files/layout.ts):
 *
 *  - **generated indexes**, written through WorkspaceFs by the `system`
 *    author and only when their text changed:
 *      /org/README.md          what lives where, the functions and units present
 *      /org/calendar.md        every ritual from the cadences, in words
 *      /org/rituals/<unit>.md  a unit's rituals, attendees and recent minutes
 *      /org/goals/README.md    the vision and the objectives
 *      /org/goals/<id8>-<slug>.md   an objective, its key results and check-ins
 *    README.md and calendar.md keep whatever follows their Notes marker, so
 *    the chief's planning timeline or an absence survives a regeneration;
 *  - **function folder stubs**: /org/<fn>/README.md, written once when the
 *    function's first member joins (at onboarding or a hire), never over a file;
 *  - **refresh on change**: it listens to the org audit log (every cadence,
 *    goal, check-in, unit, member and meeting change writes a row there) and
 *    refreshes the affected indexes, debounced per org;
 *  - **the boot migration**: files written under earlier conventions
 *    (`legacyTarget`: /org/meetings/<yyyy>/<day>-<unit>-<kind>.md →
 *    /org/meetings/<unit>/<yyyy>/<day>-<kind>.md, the leadership agenda beside it,
 *    the chief's reviews/board/staffing/learning files → /org/reports/) move
 *    with WorkspaceFs.move (metadata and revisions follow), never over a file
 *    (a `-2` suffix instead), and the links the server stored to them
 *    (org_meetings.minutesPath, the minutes' attachments in channel messages)
 *    are rewritten. Idempotent, logged, never throws. Links written as text
 *    in task comments, messages or other files are not rewritten.
 */
import { Inject, Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agents, channelMessages, channels, organizations, orgCadences, orgCheckins, orgGoals, orgMeetings, orgMembers, orgUnits } from '../database/schema';
import { WorkspaceFs, type FsActor } from '../files/workspace-fs.service';
import { AccountsService } from '../accounts/accounts.service';
import { FUNCTION_IDS, FUNCTION_LAYOUT, ORG_FUNCTIONS, functionOfRole, legacyTarget, localDay, orgPath, withNumber } from '../files/layout';
import { OrgAuditService, type AuditEntry } from './org-audit.service';
import { KIND_TITLES, type MeetingKind } from './org-meetings.service';
import { roleById } from './roles/catalog';
import { cadenceWords } from './cadence-words';
import { tunable } from './org-tunables';
import './chief-tunables';

export const LAYOUT_AUTHOR: FsActor = { kind: 'system', id: 'system', name: 'org index' };
/** Everything after this line in a generated README.md / calendar.md is kept. */
export const NOTES_MARKER = '<!-- notes: everything below this line is kept when the file is regenerated -->';
/** Debounce of the audit-driven refresh, per org. */
export const LAYOUT_DEBOUNCE_MS = 2_000;

type Org = typeof organizations.$inferSelect;
type Unit = typeof orgUnits.$inferSelect;
type Member = typeof orgMembers.$inferSelect;
type Cadence = typeof orgCadences.$inferSelect;
type Meeting = typeof orgMeetings.$inferSelect;
type Goal = typeof orgGoals.$inferSelect;
type Checkin = typeof orgCheckins.$inferSelect;

export type LayoutPart = 'index' | 'rhythm' | 'goals';
const ALL_PARTS: LayoutPart[] = ['index', 'rhythm', 'goals'];

/** Which indexes an audit action touches. */
export function partsFor(action: string): LayoutPart[] {
  if (/^(cadence_|meeting_end|meeting_cancel)/.test(action)) return ['rhythm'];
  if (/^(goal_|kr_source_|strategy_memo)/.test(action)) return ['goals'];
  if (/^(unit_|member_|chief_replace|human_|org_update|org_create|org_bootstrap)/.test(action)) return ALL_PARTS;
  return [];
}

// ---- rendering (pure) ----

const cell = (s: string): string => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const num = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? '—' : String(Number(n.toFixed(2))));
const pct = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
const day = (iso: string | null | undefined): string => (iso ? localDay(iso) : '—');
const KIND_PURPOSE: Record<string, string> = { standup: 'escalate: priority and stuck', weekly_review: 'inspect: the scorecard, exceptions only', retro: 'learn: what to change', board: 'decide: issues and decisions, scorecard first', planning: 'allocate: objectives and key results' };
const KIND_OUTPUT: Record<string, string> = { standup: 'blockers routed to owners', weekly_review: 'issues list, follow-ups', retro: 'lessons, playbook and charter changes', board: 'decisions in /org/decisions.md, owned to-dos', planning: 'objectives, key results, owners' };
const kindTitle = (k: string): string => KIND_TITLES[k as MeetingKind] ?? k;
const GENERATED = (from: string): string => `_Generated from ${from} and kept current — edits are overwritten the next time it changes._`;

/** Text with the kept tail of `current` (after NOTES_MARKER) appended. A file
 *  that predates the marker keeps its whole old text under the Notes. */
export function withNotes(generated: string, current: string | null, emptyNotes: string): string {
  let tail: string;
  if (current === null) tail = emptyNotes;
  else {
    const i = current.indexOf(NOTES_MARKER);
    tail = i >= 0 ? current.slice(i + NOTES_MARKER.length).replace(/^\n+/, '') : `${emptyNotes.trimEnd()}\n\n### Kept from before this file was generated\n\n${current.replace(/^(#{1,2}) /gm, '#### ').trim()}\n`;
  }
  return `${generated.trimEnd()}\n\n${NOTES_MARKER}\n\n${tail.trimEnd()}\n`;
}

/** The empty-cycle count: most recent held meetings in a row with no decision and no action. */
export function emptyCycles(held: Array<Pick<Meeting, 'minutes'>>): number {
  let n = 0;
  for (const m of held) {
    let x: { decisions?: unknown[]; actions?: unknown[] } = {};
    try { x = JSON.parse(m.minutes || '{}') as typeof x; } catch { /* unreadable: count as empty */ }
    if ((x.decisions?.length ?? 0) + (x.actions?.length ?? 0) > 0) break;
    n++;
  }
  return n;
}

export interface RhythmCtx {
  org: Pick<Org, 'name' | 'tunables'>;
  units: Array<Pick<Unit, 'id' | 'name' | 'slug' | 'leadAgentId' | 'parentUnitId'>>;
  cadences: Array<Pick<Cadence, 'unitId' | 'kind' | 'cron' | 'enabled'>>;
  /** Held meetings (status done), newest first. */
  meetings: Array<Pick<Meeting, 'unitId' | 'kind' | 'minutes' | 'minutesPath' | 'summary' | 'startedAt' | 'createdAt' | 'title'>>;
  members: Array<Pick<Member, 'agentId' | 'title' | 'reportsToAgentId' | 'status'>>;
  names: (agentId: string) => string;
}

const tun = (org: RhythmCtx['org'], key: string): number | string => { try { return tunable(org, key); } catch { return '—'; } };
const isRoot = (u: Pick<Unit, 'parentUnitId'>): boolean => u.parentUnitId === null;

function ritualRows(ctx: RhythmCtx, unitId: string): Array<{ c: RhythmCtx['cadences'][number]; held: RhythmCtx['meetings']; empty: number }> {
  const order = ['standup', 'weekly_review', 'board', 'retro', 'planning'];
  return ctx.cadences.filter((c) => c.unitId === unitId)
    .sort((a, b) => b.enabled - a.enabled || order.indexOf(a.kind) - order.indexOf(b.kind))
    .map((c) => { const held = ctx.meetings.filter((m) => m.unitId === unitId && m.kind === c.kind); return { c, held, empty: emptyCycles(held) }; });
}

export function renderCalendar(ctx: RhythmCtx): string {
  const lines = [
    `# Calendar — ${ctx.org.name}`, '',
    GENERATED('the ritual cadences (org_set_cadence, Settings → Workspace → Organization)'), '',
    `Every forum states one purpose, has an owner other than the chief, and leaves minutes. Times are server time. Pre-reads are due ${tun(ctx.org, 'chief.preReadHours')} h before (chief.preReadHours). A forum whose minutes stay empty — no decision, no action — for ${tun(ctx.org, 'chief.sunsetEmptyCycles')} cycles in a row is proposed for retirement (chief.sunsetEmptyCycles). Each unit's page is under /org/rituals/.`, '',
  ];
  if (!ctx.cadences.length) return `${[...lines, '_No rituals yet._'].join('\n')}\n`;
  lines.push('| Forum | Unit | When | Purpose | Owner | Output | Last held | Empty cycles |', '|---|---|---|---|---|---|---|---|');
  const units = [...ctx.units].sort((a, b) => Number(b.parentUnitId === null) - Number(a.parentUnitId === null) || a.name.localeCompare(b.name));
  for (const u of units) {
    const root = isRoot(u);
    for (const { c, held, empty } of ritualRows(ctx, u.id)) {
      const when = c.enabled ? `${cadenceWords(c.cron)} (\`${c.cron}\`)` : 'off';
      const owner = root ? 'CEO (the chief keeps the record)' : `lead of ${u.name} (${ctx.names(u.leadAgentId)})`;
      const last = held[0] ? (held[0].minutesPath ? `[${day(held[0].startedAt ?? held[0].createdAt)}](/${held[0].minutesPath})` : day(held[0].startedAt ?? held[0].createdAt)) : '—';
      lines.push(`| ${cell(kindTitle(c.kind))} | ${cell(`${u.name} (#${u.slug})`)} | ${cell(when)} | ${cell(KIND_PURPOSE[c.kind] ?? '')} | ${cell(owner)} | ${cell(KIND_OUTPUT[c.kind] ?? '')} | ${last} | ${held.length ? empty : '—'} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderRitual(ctx: RhythmCtx, unit: RhythmCtx['units'][number]): string {
  const root = isRoot(unit);
  const reports = ctx.members.filter((m) => m.status !== 'terminated' && m.reportsToAgentId === unit.leadAgentId);
  const lines = [
    `# Rituals — ${unit.name} (#${unit.slug})`, '',
    GENERATED('the unit\'s cadences, the org chart and its meetings'), '',
    `Lead: ${ctx.names(unit.leadAgentId)}${root ? ' (the chief keeps the record; the CEO owns the forums)' : ''}.`,
    `Attendees: ${[`${ctx.names(unit.leadAgentId)} (lead)`, ...reports.map((m) => `${ctx.names(m.agentId)}${m.title ? ` (${m.title})` : ''}`)].join(', ')}, and the people in #${unit.slug}.`,
    `Minutes: /${orgPath.meetingsOf(unit.slug)}/<yyyy>/.`, '',
  ];
  const rows = ritualRows(ctx, unit.id);
  if (!rows.length) lines.push('_No rituals for this unit._');
  else {
    lines.push('| Ritual | When | Purpose | Output | Last held | Empty cycles |', '|---|---|---|---|---|---|');
    for (const { c, held, empty } of rows) lines.push(`| ${cell(kindTitle(c.kind))} | ${cell(c.enabled ? `${cadenceWords(c.cron)} (\`${c.cron}\`)` : 'off')} | ${cell(KIND_PURPOSE[c.kind] ?? '')} | ${cell(KIND_OUTPUT[c.kind] ?? '')} | ${held[0] ? day(held[0].startedAt ?? held[0].createdAt) : '—'} | ${held.length ? empty : '—'} |`);
  }
  const recent = ctx.meetings.filter((m) => m.unitId === unit.id && m.minutesPath).slice(0, 5);
  if (recent.length) {
    lines.push('', '## Recent minutes', '');
    for (const m of recent) lines.push(`- [${day(m.startedAt ?? m.createdAt)} · ${cell(m.title || kindTitle(m.kind))}](/${m.minutesPath})${m.summary ? ` — ${cell(m.summary.split('\n')[0]).slice(0, 200)}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface GoalsCtx {
  org: Pick<Org, 'name'>;
  goals: Goal[];
  checkins: Checkin[];
  unitName: (unitId: string | null) => string;
  names: (agentId: string) => string;
}

const objectives = (goals: Goal[]): Goal[] => goals.filter((g) => g.kind === 'objective' && g.status !== 'draft')
  .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || a.createdAt.localeCompare(b.createdAt));
const keyResultsOf = (goals: Goal[], o: Goal): Goal[] => goals.filter((g) => g.kind === 'key_result' && g.parentGoalId === o.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
function krProgress(k: Goal): number | null {
  if (k.targetValue === null || k.currentValue === null) return null;
  const start = k.startValue ?? 0;
  const span = k.targetValue - start;
  return span === 0 ? (k.currentValue >= k.targetValue ? 1 : 0) : Math.max(0, Math.min(1, (k.currentValue - start) / span));
}

export function renderGoalsIndex(ctx: GoalsCtx): string {
  const vision = ctx.goals.find((g) => g.kind === 'vision' && g.status === 'active');
  const lines = [`# Goals — ${ctx.org.name}`, '', GENERATED('the intent tree (org_intent, org_set_goal, key result check-ins)'), ''];
  if (vision) lines.push(`**Vision.** ${vision.title}${vision.dueAt ? ` (by ${day(vision.dueAt)})` : ''}`, '', ...(vision.description ? [vision.description.trim(), ''] : []));
  const objs = objectives(ctx.goals);
  if (!objs.length) return `${[...lines, '_No objectives yet._'].join('\n')}\n`;
  lines.push('| Objective | Unit | Owner | Status | Key results | Mean progress | At risk | File |', '|---|---|---|---|---|---|---|---|');
  for (const o of objs) {
    const krs = keyResultsOf(ctx.goals, o);
    const prog = krs.map(krProgress).filter((x): x is number => x !== null);
    const mean = prog.length ? prog.reduce((a, b) => a + b, 0) / prog.length : null;
    lines.push(`| ${cell(o.title)} | ${cell(ctx.unitName(o.unitId))} | ${o.ownerAgentId ? cell(ctx.names(o.ownerAgentId)) : '—'} | ${o.status} | ${krs.length} | ${pct(mean)} | ${krs.filter((k) => k.atRisk).length || '—'} | [open](/${orgPath.goal(o)}) |`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderGoal(ctx: GoalsCtx, o: Goal): string {
  const krs = keyResultsOf(ctx.goals, o);
  const lines = [
    `# Objective: ${o.title}`, '',
    GENERATED('the intent tree (org_intent, org_set_goal, key result check-ins)'), '',
    `Status: **${o.status}** · unit ${ctx.unitName(o.unitId)} · owner ${o.ownerAgentId ? ctx.names(o.ownerAgentId) : '—'}${o.dueAt ? ` · due ${day(o.dueAt)}` : ''}`, '',
  ];
  if (o.description) lines.push(o.description.trim(), '');
  lines.push('## Key results', '');
  if (!krs.length) lines.push('_No key results yet._');
  else {
    lines.push('| Key result | Metric | Start | Current | Target | Progress | Confidence | At risk | Measured by | Last check-in |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const k of krs) {
      const unit = k.unitLabel ? ` ${k.unitLabel}` : '';
      lines.push(`| ${cell(k.title)} | ${cell(k.metric || '—')} | ${num(k.startValue)}${unit} | ${num(k.currentValue)}${unit} | ${num(k.targetValue)}${unit} | ${pct(krProgress(k))} | ${pct(k.confidence)} | ${k.atRisk ? cell(k.atRiskReason || 'yes') : '—'} | ${k.metricSourceId ? 'metric source' : 'check-ins'} | ${day(k.lastCheckInAt)} |`);
    }
    const withCheckins = krs.map((k) => ({ k, rows: ctx.checkins.filter((c) => c.goalId === k.id).slice(0, 5) })).filter((x) => x.rows.length);
    if (withCheckins.length) {
      lines.push('', '## Recent check-ins', '');
      for (const { k, rows } of withCheckins) {
        lines.push(`### ${k.title}`, '');
        for (const c of rows) lines.push(`- ${day(c.createdAt)}: ${num(c.currentValue)}${k.unitLabel ? ` ${k.unitLabel}` : ''} · confidence ${pct(c.confidence)} · ${c.actor.startsWith('agent:') ? ctx.names(c.actor.slice(6)) : c.actor}${c.note ? ` — ${cell(c.note).slice(0, 240)}` : ''}`);
        lines.push('');
      }
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export interface IndexCtx {
  org: Pick<Org, 'name'>;
  functions: Array<{ id: string; title: string; head: string | null; unit: string | null }>;
  units: Array<{ name: string; slug: string; lead: string }>;
}

export function renderOrgReadme(ctx: IndexCtx): string {
  const lines = [
    `# ${ctx.org.name} — the company folder`, '',
    '_The index of /org/: what lives where. Generated and kept current by the server (server/src/files/layout.ts) — add your own notes below the Notes line; they are kept._', '',
    '## How the company runs', '',
    '| Path | What it holds | Kept by |', '|---|---|---|',
    '| /org/operating-system.md | the operating profile as diagnosed, every derived parameter with its reason, decision rights, the communication default | the chief (seeded at onboarding) |',
    '| /org/calendar.md | every ritual: unit, when, purpose, owner, output, empty cycles | generated from the cadences |',
    '| /org/goals/ | the vision and one file per objective with its key results and check-ins | generated from the intent tree |',
    '| /org/rituals/<unit>.md | a unit\'s rituals, attendees and recent minutes | generated |',
    '| /org/meetings/<unit>/<yyyy>/ | minutes `<yyyy-mm-dd>-<kind>.md` and agendas `…-agenda.md` | written when a meeting ends; agendas by the chief |',
    '| /org/reports/ | the weekly review pack `<yyyy>-W<ww>.md`, monthly reviews `<yyyy-mm>-<topic>.md`, board update drafts `<yyyy-mm-dd>-board-update.md` | the chief |',
    '| /org/briefs/<yyyy-mm-dd>.md | the CEO\'s daily brief | the chief |',
    '| /org/planning/<yyyy>-Q<n>.md | the quarter\'s planning pack | the chief |',
    '| /org/proposals/<yyyy-mm-dd>-<slug>.md | proposals for the CEO (reorganisations, new rituals) | the chief |',
    '| /org/archive/<yyyy>/ | closed issues, resolved risks and old decisions | the chief |',
    '',
    '## The ledger', '',
    '| File | What it holds |', '|---|---|',
    '| /org/decisions.md | the decision log: one decider each |',
    '| /org/scorecard.md | 5–15 numbers with owner, target and on/off track |',
    '| /org/issues.md | the weekly meeting\'s issues list |',
    '| /org/risks.md | the risk register |',
    '| /org/handoffs.md | handoff SLAs between functions |',
    '| /org/values.md | values → mechanisms |',
    '',
    '## Functions', '',
    `One folder per job function, named like the market's functions (a role's id prefix, except \`cs-*\` → /org/customer/ and \`ops-*\` → /org/operations/): ${ORG_FUNCTIONS.map((f) => `\`${f.id}\` ${f.title}`).join(', ')}. Each holds README.md, ${FUNCTION_LAYOUT.cadence}, ${FUNCTION_LAYOUT.kpis}, ${FUNCTION_LAYOUT.team}, ${FUNCTION_LAYOUT.okrs}/<yyyy>-Q<n>.md, ${FUNCTION_LAYOUT.reports}/<yyyy>-W<ww>.md (the weekly report to the chief), ${FUNCTION_LAYOUT.audits}/<yyyy-mm>.md and ${FUNCTION_LAYOUT.processes}/; anything else the function needs goes in its own subfolder.`, '',
  ];
  if (ctx.functions.length) {
    lines.push('| Folder | Function | Head | Unit |', '|---|---|---|---|');
    for (const f of ctx.functions) lines.push(`| /org/${f.id}/ | ${cell(f.title)} | ${f.head ? cell(f.head) : 'no head yet'} | ${f.unit ? cell(f.unit) : '—'} |`);
  } else lines.push('_No function has members yet._');
  lines.push('', '## Units', '');
  if (ctx.units.length) {
    lines.push('| Unit | Lead | Rituals | Minutes |', '|---|---|---|---|');
    for (const u of ctx.units) lines.push(`| ${cell(u.name)} (#${u.slug}) | ${cell(u.lead)} | /${orgPath.ritual(u.slug)} | /${orgPath.meetingsOf(u.slug)}/ |`);
  } else lines.push('_No units yet._');
  lines.push(
    '', '## Company records (mirrors)', '',
    'Read-only mirrors of the records the agents keep with their tools: /org/playbooks/, /org/experiments/, /org/evals/, /org/outcomes.md, /org/metrics.md.', '',
    '## Elsewhere in the workspace', '',
    '- /channels/<slug>/ — a channel\'s files; `meetings/` holds the minutes of meetings in channels that are not a unit\'s.',
    '- /agents/<handle>/ — an agent\'s home: LESSONS.md, JOURNAL.md, knowledge/, apps/, work/ (drafts). Readable by all, written by its agent.',
    '- /uploads/ — files people attach in the composer.',
  );
  return `${lines.join('\n')}\n`;
}

export function renderFunctionReadme(fn: { id: string; title: string }, head: string | null): string {
  return [
    `# ${fn.title} — /org/${fn.id}/`, '',
    `The ${fn.title} function's shared folder. ${head ? `Head: ${head}.` : 'No head yet: the chief routes its work.'} Everyone in the company can read it; the function keeps it.`, '',
    '| Path | What it holds |', '|---|---|',
    `| ${FUNCTION_LAYOUT.cadence} | the function's rituals and who runs them |`,
    `| ${FUNCTION_LAYOUT.kpis} | the function's KPIs: definition, source, owner, target |`,
    `| ${FUNCTION_LAYOUT.team} | members, roles, the head's notes on each |`,
    `| ${FUNCTION_LAYOUT.okrs}/<yyyy>-Q<n>.md | the quarter's objectives and key results |`,
    `| ${FUNCTION_LAYOUT.reports}/<yyyy>-W<ww>.md | the weekly report to the chief: RAG, metrics against target, risks, asks |`,
    `| ${FUNCTION_LAYOUT.audits}/<yyyy-mm>.md | the monthly KPI and process audit |`,
    `| ${FUNCTION_LAYOUT.processes}/ | standing procedures, runbooks, checklists |`, '',
    'Anything else the function needs (pipelines, specs, accounts…) goes in its own subfolder here.', '',
    '_Written when the function\'s first member joined; the function owns this file from here._', '',
  ].join('\n');
}

// ---- the service ----

@Injectable()
export class OrgLayoutService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrgLayoutService.name);
  private readonly pending = new Map<string, { parts: Set<LayoutPart>; timer: ReturnType<typeof setTimeout> }>();
  private readonly running = new Set<Promise<unknown>>();
  /** Test seam: 0 refreshes on the next tick. */
  debounceMs = LAYOUT_DEBOUNCE_MS;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    @Optional() private readonly fs?: WorkspaceFs,
    @Optional() private readonly accounts?: AccountsService,
    @Optional() audit?: OrgAuditService,
  ) {
    audit?.onAppend((orgId, entry) => this.changed(orgId, entry));
  }

  /** Resolves when every scheduled or running refresh has settled (tests). */
  async idle(): Promise<void> {
    for (const [orgId, p] of [...this.pending]) { clearTimeout(p.timer); this.pending.delete(orgId); this.run(orgId, [...p.parts]); }
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** The audit hook: schedule a refresh of the indexes the action touches. */
  changed(orgId: string, entry: Pick<AuditEntry, 'action'>): void {
    const parts = partsFor(entry.action);
    if (!parts.length || !this.fs) return;
    const hit = this.pending.get(orgId);
    if (hit) { for (const p of parts) hit.parts.add(p); return; }
    const timer = setTimeout(() => { const p = this.pending.get(orgId); this.pending.delete(orgId); if (p) this.run(orgId, [...p.parts]); }, this.debounceMs);
    timer.unref?.();
    this.pending.set(orgId, { parts: new Set(parts), timer });
  }

  private run(orgId: string, parts: LayoutPart[]): void {
    const p = this.refresh(orgId, parts).catch((err) => this.logger.warn(`org index refresh failed: ${err instanceof Error ? err.message : err}`));
    this.running.add(p);
    void p.finally(() => this.running.delete(p));
  }

  /** Regenerate the org's indexes (all of them by default). Writes only what
   *  changed; returns the paths written. */
  async refresh(orgId: string, parts: LayoutPart[] = ALL_PARTS): Promise<string[]> {
    if (!this.fs) return [];
    const org = (await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1)).at(0);
    if (!org) return [];
    const ws = org.workspaceId;
    const want = new Set(parts);
    const written: string[] = [];
    const units = (await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId)).orderBy(asc(orgUnits.createdAt))).filter((u) => !u.archivedAt);
    const members = await this.db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId));
    const names = await this.agentNames([...members.map((m) => m.agentId), ...units.map((u) => u.leadAgentId), ...(org.chiefOfStaffAgentId ? [org.chiefOfStaffAgentId] : [])]);
    const nameOf = (id: string): string => names.get(id) ?? (id ? id.slice(0, 8) : '—');
    const put = async (path: string, text: string) => { if (await this.put(ws, path, text)) written.push(path); };

    if (want.has('rhythm') || want.has('index')) {
      const cadences = await this.db.select().from(orgCadences).where(eq(orgCadences.orgId, orgId));
      const meetings = await this.db.select().from(orgMeetings).where(and(eq(orgMeetings.orgId, orgId), eq(orgMeetings.status, 'done'))).orderBy(desc(orgMeetings.createdAt)).limit(400);
      const ctx: RhythmCtx = { org, units, cadences, meetings, members, names: nameOf };
      const current = await this.text(ws, orgPath.calendar);
      await put(orgPath.calendar, withNotes(renderCalendar(ctx), current, '## Notes\n\n_The chief\'s notes on the calendar: planning timelines, absences, retirement outcomes._\n'));
      for (const u of units) await put(orgPath.ritual(u.slug), renderRitual(ctx, u));
    }

    if (want.has('goals')) {
      const goals = await this.db.select().from(orgGoals).where(eq(orgGoals.orgId, orgId));
      const checkins = await this.db.select().from(orgCheckins).where(eq(orgCheckins.orgId, orgId)).orderBy(desc(orgCheckins.createdAt)).limit(2_000);
      const unitName = (id: string | null): string => (id ? units.find((u) => u.id === id)?.name ?? 'a unit' : 'the company');
      const ctx: GoalsCtx = { org, goals, checkins, unitName, names: nameOf };
      const objs = objectives(goals);
      if (objs.length || goals.some((g) => g.kind === 'vision')) {
        await put(orgPath.goalsIndex, renderGoalsIndex(ctx));
        const existing = (await this.fs.list(ws, orgPath.goalsDir).catch(() => [])).map((e) => e.path);
        for (const o of objs) {
          const path = orgPath.goal(o);
          await put(path, renderGoal(ctx, o));
          // A renamed objective: its file under the old title goes (reversibly).
          const prefix = path.slice(0, path.indexOf('-', orgPath.goalsDir.length + 1) + 1);
          for (const stale of existing.filter((p) => p !== path && p.startsWith(prefix))) await this.fs.delete(ws, stale, { by: LAYOUT_AUTHOR }).catch(() => undefined);
        }
      }
    }

    if (want.has('index')) {
      const live = members.filter((m) => m.status !== 'terminated');
      const fns = new Map<string, { head: string | null; unit: string | null }>();
      for (const m of live) {
        const role = roleById(m.title);
        const fn = functionOfRole(role?.id ?? null);
        if (!fn) continue;
        const entry = fns.get(fn) ?? { head: null, unit: null };
        if (role!.id.endsWith('-manager')) {
          entry.head = `${nameOf(m.agentId)} (${m.title})`;
          const u = units.find((x) => x.leadAgentId === m.agentId);
          entry.unit = u ? `${u.name} (#${u.slug})` : null;
        }
        fns.set(fn, entry);
      }
      // Function folders that exist already list too (a head may have left).
      const top = await this.fs.list(ws, orgPath.dir).catch(() => []);
      for (const e of top) { const seg = e.path.split('/'); if (seg.length > 2 && FUNCTION_IDS.includes(seg[1]) && !fns.has(seg[1])) fns.set(seg[1], { head: null, unit: null }); }
      const functions = ORG_FUNCTIONS.filter((f) => fns.has(f.id)).map((f) => ({ id: f.id, title: f.title, ...fns.get(f.id)! }));
      const unitsList = [...units].sort((a, b) => Number(b.parentUnitId === null) - Number(a.parentUnitId === null) || a.name.localeCompare(b.name)).map((u) => ({ name: u.name, slug: u.slug, lead: nameOf(u.leadAgentId) }));
      const current = await this.text(ws, orgPath.readme);
      await put(orgPath.readme, withNotes(renderOrgReadme({ org, functions, units: unitsList }), current, '## Notes\n'));
      // Function READMEs: once, never over a file (the function owns it).
      for (const f of functions) {
        const path = orgPath.functionFile(f.id, FUNCTION_LAYOUT.readme);
        if (top.some((e) => e.path === path) || await this.text(ws, path) !== null) continue;
        await this.fs.write(ws, path, Buffer.from(renderFunctionReadme(f, f.head), 'utf8'), { by: LAYOUT_AUTHOR, contentType: 'text/markdown', expectedVersion: 0 }).then(() => written.push(path)).catch(() => undefined);
      }
    }
    return written;
  }

  private async text(ws: string, path: string): Promise<string | null> {
    return (await this.fs!.read(ws, path).catch(() => null))?.body.toString('utf8') ?? null;
  }

  /** Write `text` at `path` unless it already says exactly that. */
  private async put(ws: string, path: string, text: string): Promise<boolean> {
    if ((await this.text(ws, path)) === text) return false;
    await this.fs!.write(ws, path, Buffer.from(text, 'utf8'), { by: LAYOUT_AUTHOR, contentType: 'text/markdown' });
    return true;
  }

  private async agentNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map();
    const rows = await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, uniq));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ---- the migration ----

  /** Move one org's files written under earlier conventions into the layout.
   *  Idempotent; never overwrites (a `-2`… suffix instead); never throws. */
  async migrate(orgId: string): Promise<{ moved: Array<[string, string]>; failed: number }> {
    const out = { moved: [] as Array<[string, string]>, failed: 0 };
    if (!this.fs) return out;
    try {
      const org = (await this.db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1)).at(0);
      if (!org) return out;
      const ws = org.workspaceId;
      const units = await this.db.select().from(orgUnits).where(eq(orgUnits.orgId, orgId));
      const rootSlug = units.find((u) => u.parentUnitId === null)?.slug ?? 'company';
      const files = await this.fs.list(ws, orgPath.dir);
      const taken = new Set(files.map((f) => f.path));
      for (const f of files) {
        const target = legacyTarget(f.path, { unitSlugs: units.map((u) => u.slug), rootSlug });
        if (!target || target === f.path) continue;
        let dest = target;
        for (let n = 2; taken.has(dest) || (await this.fs.read(ws, dest).catch(() => null)) !== null; n++) dest = withNumber(target, n);
        try {
          await this.fs.move(ws, f.path, dest, { by: LAYOUT_AUTHOR });
          taken.delete(f.path); taken.add(dest);
          out.moved.push([f.path, dest]);
        } catch (err) {
          out.failed++;
          this.logger.warn(`org layout: could not move /${f.path} → /${dest}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (out.moved.length) await this.relink(orgId, ws, out.moved);
    } catch (err) {
      this.logger.warn(`org layout migration of ${orgId} failed: ${err instanceof Error ? err.message : err}`);
    }
    return out;
  }

  /** Rewrite the links the server stored to moved files. */
  private async relink(orgId: string, ws: string, moved: Array<[string, string]>): Promise<void> {
    const map = new Map(moved);
    try {
      const rows = await this.db.select({ id: orgMeetings.id, minutesPath: orgMeetings.minutesPath }).from(orgMeetings).where(eq(orgMeetings.orgId, orgId));
      for (const r of rows) { const to = r.minutesPath ? map.get(r.minutesPath) : undefined; if (to) await this.db.update(orgMeetings).set({ minutesPath: to }).where(eq(orgMeetings.id, r.id)); }
    } catch (err) { this.logger.warn(`org layout: minutesPath relink failed: ${err instanceof Error ? err.message : err}`); }
    try {
      const chans = (await this.db.select({ id: channels.id }).from(channels).where(eq(channels.workspaceId, ws))).map((c) => c.id);
      if (!chans.length) return;
      for (const [from, to] of moved) {
        const hits = await this.db.select({ id: channelMessages.id, attachments: channelMessages.attachments }).from(channelMessages)
          .where(and(inArray(channelMessages.channelId, chans), like(channelMessages.attachments, `%${from.replace(/[%_\\]/g, '\\$&')}%`)));
        for (const h of hits) {
          let list: Array<{ path?: string }>;
          try { list = JSON.parse(h.attachments) as Array<{ path?: string }>; } catch { continue; }
          if (!Array.isArray(list) || !list.some((a) => a?.path === from)) continue;
          await this.db.update(channelMessages).set({ attachments: JSON.stringify(list.map((a) => (a?.path === from ? { ...a, path: to } : a))) }).where(eq(channelMessages.id, h.id));
        }
      }
    } catch (err) { this.logger.warn(`org layout: attachment relink failed: ${err instanceof Error ? err.message : err}`); }
  }

  // ---- boot ----

  onApplicationBootstrap(): void {
    if (!this.fs?.versioned) return;
    void this.bootAll().catch((err) => this.logger.warn(`org layout boot failed: ${err instanceof Error ? err.message : err}`));
  }

  /** Every account's organizations: migrate, then regenerate the indexes. */
  async bootAll(): Promise<{ moved: number; written: number }> {
    const total = { moved: 0, written: 0, failed: 0 };
    const one = async () => {
      let orgs: Array<{ id: string }>;
      try { orgs = await this.db.select({ id: organizations.id }).from(organizations); } catch { return; }
      for (const o of orgs) {
        const m = await this.migrate(o.id);
        total.moved += m.moved.length; total.failed += m.failed;
        total.written += (await this.refresh(o.id).catch((err) => { this.logger.warn(`org index refresh of ${o.id} failed: ${err instanceof Error ? err.message : err}`); return []; })).length;
      }
    };
    if (this.accounts) await this.accounts.forEachAccount(one);
    else await one();
    if (total.moved || total.failed) this.logger.log(`org layout migration: moved ${total.moved} file(s) into the layout${total.failed ? `, ${total.failed} could not move` : ''}`);
    if (total.written) this.logger.log(`org indexes: wrote ${total.written} file(s) under /org/`);
    return { moved: total.moved, written: total.written };
  }
}
