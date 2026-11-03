/**
 * OrgBriefingService — what every company member knows without asking
 * (docs/agent-data-access.md §7, docs/agent-memory.md §11).
 *
 * One compact block in the system prompt of every turn a member takes —
 * a chat with the owner, a heartbeat beat, a task run, a chief review, a
 * planning session, a meeting round, a channel wake — carrying the company
 * (name, one-line mission, vision, top values), the member's position
 * (title, unit, manager, reports, its projects and its part in them), the
 * key results with RAG, its projects' health and next milestone, its own
 * open work, recent decisions in its units and what is waiting on it. The
 * emphasis follows the role: the chief gets the portfolio and the
 * exceptions, a head its unit and its staffing gaps, a specialist its work
 * and its project. It ends with the tools that hold the detail.
 *
 * Bounded: `BRIEFING_BUDGET` characters, enforced by dropping the lowest
 * priority lines first and clipping as a last resort. Cached: one snapshot
 * of the company per org, invalidated by every audit append of that org
 * (every change to members, goals, projects, tasks, decisions and cards
 * is audited) and by a short TTL; the per-member render is cached on the
 * snapshot's generation with a shorter TTL (mentions are not audited).
 *
 * Scope follows OrgDataTools.viewer: company-level facts are every
 * member's; unit items (decisions, projects' detail) follow the viewer's
 * units. No money, no scopes, no other agent's memory or private details
 * ever enter the block.
 *
 * Standing context: the same facts that change slowly — mission, values,
 * the member's role, reporting line and projects — are written to
 * `knowledge/company.md` in the member's home when they change (a hire, a
 * reorg, a promotion to head, a project lead or a first task on a project),
 * so they survive outside prompts and are greppable with fs_* tools.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { agentEvents, orgApprovals, orgDecisions } from '../database/schema';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { StorageService } from '../storage/storage.service';
import { homeKey } from '../files/agent-home';
import { taskRef } from '../common/task-keys';
import { OrgService, type Organization, type OrgGoal, type OrgMember, type OrgProject } from './org.service';
import { OrgAuditService } from './org-audit.service';
import { OrgTasksService, type OrgTask } from './org-tasks.service';
import { OrgUnitsService, type OrgUnit } from './org-units.service';
import { OrgIntentService, paceOf } from './org-intent.service';
import { OrgRuntimeService, headFunction } from './org-runtime.service';
import { tunable } from './org-tunables';

/** The briefing's hard ceiling, in characters (the tests measure it). */
export const BRIEFING_BUDGET = 2_500;
/** How long a company snapshot lives without an audit append. */
export const SNAPSHOT_TTL_MS = 5 * 60_000;
/** How long one member's rendered block lives (mentions are not audited). */
export const RENDER_TTL_MS = 60_000;
/** The standing-context file in a member's home. */
export const COMPANY_NOTE = 'knowledge/company.md';

const OPEN = new Set(['backlog', 'waiting', 'todo', 'claimed', 'in_progress', 'in_review', 'blocked']);
const STATUS_RANK: Record<string, number> = { blocked: 0, in_progress: 1, in_review: 2, claimed: 3, todo: 4, waiting: 5, backlog: 6 };
const RAG_RANK: Record<string, number> = { red: 0, amber: 1, grey: 2, green: 3 };
const HEALTH_WORDS: Record<string, string> = { on_track: 'on track', at_risk: 'at risk', off_track: 'off track', '': 'no update yet' };

type Rag = 'red' | 'amber' | 'green' | 'grey';
interface Kr { goal: OrgGoal; rag: Rag; pct: number | null }
interface Snapshot {
  gen: number; at: number;
  org: Organization; vision: OrgGoal | null;
  members: OrgMember[]; names: Map<string, string>;
  units: OrgUnit[]; projects: OrgProject[]; krs: Kr[];
  tasks: OrgTask[];
  decisions: Array<{ title: string; unitId: string | null; createdAt: string }>;
  pending: Array<{ holder: string }>;
}
export type BriefingRole = 'chief' | 'head' | 'specialist';

/** The RAG rule of Home (home.service.ts `ragOf`): at risk red, behind amber, on pace green, no measure grey. */
function ragOf(atRisk: number | boolean, pace: string): Rag {
  if (atRisk) return 'red';
  if (pace === 'behind') return 'amber';
  if (pace === 'onPace') return 'green';
  return 'grey';
}
/** One line of at most `n` chars, cut at a word boundary when one is near. */
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '')}…`;
};
/** The first sentence of a mission, one line. */
export function oneLine(text: string, n = 160): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return clip(m ? m[1] : t, n);
}
/** The names of the top values: each line's (or item's) lead phrase. */
export function topValues(text: string, n = 3): string[] {
  return (text ?? '').split(/\n|;|•/).map((v) => v.replace(/^[\s*\-\d.)]+/, '').trim()).filter(Boolean)
    .map((v) => clip(v.split(/[:—–]| - /)[0].replace(/[.]+$/, ''), 40)).slice(0, n);
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
function milestones(p: OrgProject): Array<{ name: string; date: string; done: boolean }> {
  try { const v = JSON.parse(p.milestones || '[]') as unknown; return Array.isArray(v) ? v.map((m) => ({ name: String((m as { name?: unknown }).name ?? ''), date: String((m as { date?: unknown }).date ?? ''), done: Boolean((m as { done?: unknown }).done) })) : []; } catch { return []; }
}
function goalIdsOf(p: OrgProject): string[] {
  try { const v = JSON.parse(p.goalIds || '[]') as unknown; return Array.isArray(v) ? v.map(String) : []; } catch { return p.goalId ? [p.goalId] : []; }
}

@Injectable()
export class OrgBriefingService implements ToolProviderHook {
  private readonly logger = new Logger(OrgBriefingService.name);
  private readonly gens = new Map<string, number>();
  private readonly snaps = new Map<string, Snapshot>();
  private readonly renders = new Map<string, { gen: number; at: number; text: string }>();
  /** Fingerprint of the standing context last written per agent. */
  private readonly standing = new Map<string, string>();
  private readonly standingTimers = new Map<string, NodeJS.Timeout>();
  /** Snapshot builds, for the cache test. */
  builds = 0;
  /** Debounce before standing notes refresh after a structural change. */
  standingDebounceMs = 2_000;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly audit: OrgAuditService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly storage?: StorageService,
    @Optional() private readonly units?: OrgUnitsService,
    @Optional() private readonly intent?: OrgIntentService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    audit.onAppend((orgId, entry) => {
      this.gens.set(orgId, (this.gens.get(orgId) ?? 0) + 1);
      if (STANDING_ACTIONS.test(entry.action)) this.scheduleStanding(orgId);
    });
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  // ---- ToolProviderHook: context only ----

  async specsFor(): Promise<AiToolSpec[]> { return []; }
  owns(): boolean { return false; }
  isReadOnly(): boolean { return true; }
  async execute(): Promise<string> { throw new Error('the briefing offers no tools'); }

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    // The auditor's run and the aux runs other modules frame carry their own context.
    const run = this.runtime?.runningCtx(session.id);
    if (run?.audit || run?.aux) return null;
    return this.briefingFor(session.agentId).catch((err: unknown) => {
      this.logger.warn(`briefing for ${session.agentId} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
  }

  /** Every active membership's block, within the budget. */
  async briefingFor(agentId: string, now = new Date()): Promise<string | null> {
    const ms = (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
    const blocks: string[] = [];
    for (const m of ms) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (!org || org.status === 'archived') continue;
      blocks.push(await this.render(org.id, agentId, now));
    }
    if (blocks.length === 0) return null;
    const out = blocks.join('\n\n');
    return out.length > BRIEFING_BUDGET ? `${out.slice(0, BRIEFING_BUDGET - 1)}…` : out;
  }

  /** Drop the caches of an org (tests; an org deleted or archived). */
  invalidate(orgId: string): void { this.gens.set(orgId, (this.gens.get(orgId) ?? 0) + 1); }

  // ---- the snapshot ----

  private async snapshot(orgId: string, now: Date): Promise<Snapshot> {
    const gen = this.gens.get(orgId) ?? 0;
    const hit = this.snaps.get(orgId);
    if (hit && hit.gen === gen && now.getTime() - hit.at < SNAPSHOT_TTL_MS && hit.at <= now.getTime()) return hit;
    this.builds++;
    const org = await this.org.get(orgId);
    const tolerance = tunable(org, 'intent.paceTolerance');
    const goals = await this.org.goals(orgId);
    const krs: Kr[] = goals.filter((g) => g.kind === 'key_result' && g.status === 'active').map((g) => {
      const p = paceOf(g, now, tolerance);
      return { goal: g, rag: ragOf(g.atRisk, p.pace), pct: p.measured === null ? null : Math.round(p.measured * 100) };
    });
    const decisions = await this.db.select({ title: orgDecisions.title, unitId: orgDecisions.unitId, createdAt: orgDecisions.createdAt })
      .from(orgDecisions).where(eq(orgDecisions.orgId, orgId)).orderBy(desc(orgDecisions.createdAt)).limit(40);
    const pending = await this.db.select({ holder: orgApprovals.holder }).from(orgApprovals)
      .where(and(eq(orgApprovals.orgId, orgId), eq(orgApprovals.status, 'pending')));
    const snap: Snapshot = {
      gen, at: now.getTime(), org,
      vision: await this.intent?.vision(orgId).catch(() => null) ?? goals.find((g) => g.kind === 'vision' && g.status === 'active') ?? null,
      members: (await this.org.members(orgId)).filter((m) => m.status === 'active'),
      names: new Map((await this.agents.list()).map((a) => [a.id, a.name])),
      units: this.units ? await this.units.units(orgId) : [],
      projects: (await this.org.projects(orgId)).filter((p) => p.kind === 'project' && !['done', 'cancelled'].includes(p.status)),
      krs, tasks: (await this.tasks.list(orgId)).filter((t) => OPEN.has(t.status)),
      decisions, pending,
    };
    this.snaps.set(orgId, snap);
    return snap;
  }

  private async render(orgId: string, agentId: string, now: Date): Promise<string> {
    const key = `${orgId}:${agentId}`;
    const s = await this.snapshot(orgId, now);
    const hit = this.renders.get(key);
    if (hit && hit.gen === s.gen && now.getTime() - hit.at < RENDER_TTL_MS && hit.at <= now.getTime()) return hit.text;
    const v = viewOf(s, agentId);
    const unread = (await this.db.select({ kind: agentEvents.kind }).from(agentEvents)
      .where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.kind, 'mention'), isNull(agentEvents.readAt))).limit(50)).length;
    const text = briefingText(s, v, agentId, unread);
    this.renders.set(key, { gen: s.gen, at: now.getTime(), text });
    await this.writeStanding(s, agentId).catch((err: unknown) => this.logger.warn(`company note for ${agentId}: ${err instanceof Error ? err.message : err}`));
    return text;
  }

  // ---- standing context: knowledge/company.md ----

  private scheduleStanding(orgId: string): void {
    const prev = this.standingTimers.get(orgId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => { this.standingTimers.delete(orgId); void this.refreshStanding(orgId).catch(() => undefined); }, this.standingDebounceMs);
    t.unref?.();
    this.standingTimers.set(orgId, t);
  }

  /** Rewrite every active member's note whose standing changed. Returns the agents written. */
  async refreshStanding(orgId: string, now = new Date()): Promise<string[]> {
    if (!this.enabled()) return [];
    const s = await this.snapshot(orgId, now);
    const out: string[] = [];
    for (const m of s.members) if (await this.writeStanding(s, m.agentId)) out.push(m.agentId);
    return out;
  }

  /** The note's text for a member (no date in it, so it only changes when the standing does). */
  standingNote(s: Snapshot, agentId: string): string {
    const v = viewOf(s, agentId);
    const o = s.org;
    const lines = [
      `# ${o.name} — my standing context`,
      '',
      'Regenerated by the company when my role, reporting line or projects change; my own notes belong in other files under knowledge/.',
      '',
      '## The company',
      o.mission ? `- Mission: ${clip(o.mission, 600)}` : '- Mission: not written yet',
      s.vision ? `- Vision: ${clip(s.vision.title, 200)}${s.vision.dueAt ? ` (by ${day(s.vision.dueAt)})` : ''}` : '',
      topValues(o.values ?? '', 6).length ? `- Values: ${topValues(o.values ?? '', 6).join('; ')}` : '',
      '',
      '## My role',
      `- ${v.role === 'chief' ? 'Chief of staff' : v.me?.title || 'Member'}${v.role === 'head' ? ' (function head)' : ''}`,
      v.led ? `- I lead the unit ${v.led.name} (#${v.led.slug})` : v.home ? `- Unit: ${v.home.name}` : '',
      v.isChief ? '- I report to the CEO' : `- I report to ${v.nm(v.me?.reportsToAgentId)}`,
      v.reports.length ? `- My direct reports: ${v.reports.map((r) => `${v.nm(r.agentId)}${r.title ? ` (${r.title})` : ''}`).join(', ')}` : '- No direct reports',
      '',
      '## My projects',
      ...(v.myProjects.length ? v.myProjects.map((p) => `- ${p.key} "${clip(p.title, 80)}" — ${p.ownerAgentId === agentId ? 'I lead it' : 'I work on it'}`) : ['- None yet']),
      '',
      'Current numbers (health, key results, tasks) are in the briefing of every turn; the detail is in org_company, org_people, org_project <key> and org_intent.',
    ];
    return `${lines.filter((l, i, a) => l !== '' || (a[i - 1] ?? '') !== '').join('\n')}\n`;
  }

  /** Write the note when its content changed; true when written. */
  private async writeStanding(s: Snapshot, agentId: string): Promise<boolean> {
    if (!this.storage) return false;
    const text = this.standingNote(s, agentId);
    const sig = createHash('sha256').update(text).digest('hex').slice(0, 16);
    if (this.standing.get(agentId) === sig) return false;
    const agent = await this.agents.get(agentId).catch(() => null);
    if (!agent) return false;
    const key = homeKey(await this.agents.home(agent), COMPANY_NOTE);
    const current = await this.storage.get(key).catch(() => null);
    if (current && current.toString('utf8') === text) { this.standing.set(agentId, sig); return false; }
    await this.storage.put(key, Buffer.from(text, 'utf8'), 'text/markdown');
    this.standing.set(agentId, sig);
    return true;
  }
}

/** Audit actions after which a member's standing may have changed. */
const STANDING_ACTIONS = /^(member_|reorg|hire|terminate|unit_|project_create|project_update|task_create|org_update|profile|vision_|mission)/;

/** A member's view of the snapshot: its position and scope (OrgDataTools.viewer's rule). */
function viewOf(s: Snapshot, agentId: string) {
  const nm = (id: string | null | undefined) => (id ? s.names.get(id) ?? id.slice(0, 8) : 'nobody');
  const me = s.members.find((m) => m.agentId === agentId) ?? null;
  const isChief = s.org.chiefOfStaffAgentId === agentId;
  const root = s.units.find((u) => u.parentUnitId === null) ?? null;
  const led = s.units.find((u) => u.leadAgentId === agentId && u.parentUnitId !== null) ?? null;
  // The unit it sits in: the one led by the nearest unit-leading manager (OrgUnitsService.unitForAssignee).
  const byAgent = new Map(s.members.map((m) => [m.agentId, m]));
  let home: OrgUnit | null = root;
  for (let cur = me?.reportsToAgentId ?? null, i = 0; cur && i < 10; i++) {
    const u = s.units.find((x) => x.leadAgentId === cur);
    if (u) { home = u; break; }
    cur = byAgent.get(cur)?.reportsToAgentId ?? null;
  }
  const units = new Set<string>();
  if (isChief) for (const u of s.units) units.add(u.id);
  else {
    if (root) units.add(root.id);
    if (home) units.add(home.id);
    if (led) for (let q = [led.id]; q.length;) { const id = q.shift()!; units.add(id); for (const u of s.units) if (u.parentUnitId === id && !units.has(u.id)) q.push(u.id); }
  }
  const reports = s.members.filter((m) => m.reportsToAgentId === agentId);
  const head = !isChief && agentId !== s.org.auditorAgentId && (led !== null || (headFunction(me?.title) !== null && me?.reportsToAgentId === s.org.chiefOfStaffAgentId));
  const role: BriefingRole = isChief ? 'chief' : head ? 'head' : 'specialist';
  const mine = s.tasks.filter((t) => t.assigneeAgentId === agentId);
  const myProjects = s.projects.filter((p) => p.ownerAgentId === agentId || mine.some((t) => t.projectId === p.id));
  return { nm, me, isChief, role, root, led, home, units, reports, mine, myProjects };
}


type View = ReturnType<typeof viewOf>;

/** The block, in priority order; lines are dropped from the end of the priority list to fit. */
function briefingText(s: Snapshot, v: View, agentId: string, unreadMentions: number): string {
  const o = s.org;
  const { nm } = v;
  const lines: Array<{ p: number; text: string }> = [];
  const add = (p: number, text: string) => { if (text) lines.push({ p, text }); };

  add(0, `# Company briefing: "${o.name}"${o.status !== 'active' ? ` (${o.status})` : ''}`);
  const values = topValues(o.values ?? '');
  add(0, [o.mission ? `Mission: ${oneLine(o.mission)}` : 'Mission: not written yet.', s.vision ? `Vision: ${clip(s.vision.title, 100)}${s.vision.dueAt ? ` (by ${day(s.vision.dueAt)})` : ''}.` : ''].filter(Boolean).join(' '));
  if (values.length) add(2, `Values: ${values.join(' · ')}.`);

  // Position.
  const title = v.isChief ? 'the chief of staff' : v.me?.title ? `${v.me.title}` : 'a member';
  const unitBit = v.led ? `, head of ${v.led.name}` : v.home && v.home.parentUnitId !== null ? `, in ${v.home.name}` : '';
  const line = v.isChief ? 'reports to the CEO' : `reports to ${nm(v.me?.reportsToAgentId)}`;
  const reports = v.reports.length ? `; direct reports: ${v.reports.slice(0, 6).map((r) => nm(r.agentId)).join(', ')}${v.reports.length > 6 ? ` +${v.reports.length - 6}` : ''}` : '';
  // The projects it is on, with its part: lead, or contributor with its share of the open work.
  const on = v.myProjects.slice(0, 4).map((p) => {
    const n = v.mine.filter((t) => t.projectId === p.id).length;
    const all = s.tasks.filter((t) => t.projectId === p.id).length;
    return `${p.key} (${p.ownerAgentId === agentId ? 'lead' : 'contributor'}${n ? `, ${n}/${all} open tasks yours` : ''})`;
  });
  add(0, `You: ${title}${unitBit}; ${line}${reports}${on.length ? `; on ${on.join(', ')}${v.myProjects.length > 4 ? ', …' : ''}` : ''}.`);

  // Goals.
  const krLine = (k: Kr) => `- [${k.rag}] ${clip(k.goal.title, 50)}: ${fmtNum(k.goal.currentValue ?? k.goal.startValue)}/${fmtNum(k.goal.targetValue)}${k.goal.unitLabel ? ` ${k.goal.unitLabel}` : ''}${k.pct !== null ? ` (${k.pct}%)` : ''}${k.goal.dueAt ? `, due ${day(k.goal.dueAt)}` : ''}${k.goal.ownerAgentId === agentId ? ', yours' : ''}`;
  const rank = (a: Kr, b: Kr) => RAG_RANK[a.rag] - RAG_RANK[b.rag] || (a.goal.dueAt ?? '9').localeCompare(b.goal.dueAt ?? '9');
  const relevant = (k: Kr) => k.goal.ownerAgentId === agentId || v.myProjects.some((p) => goalIdsOf(p).includes(k.goal.id))
    || (v.role === 'head' && (v.reports.some((r) => r.agentId === k.goal.ownerAgentId) || (k.goal.unitId !== null && v.units.has(k.goal.unitId) && k.goal.unitId !== v.root?.id)));
  const krs = v.role === 'chief' ? [...s.krs].sort(rank) : [...s.krs.filter(relevant).sort(rank), ...s.krs.filter((k) => !relevant(k)).sort(rank)];
  const krN = v.role === 'chief' ? 5 : v.role === 'head' ? 4 : 3;
  if (krs.length) {
    add(1, `Key results (${s.krs.length}; red ${s.krs.filter((k) => k.rag === 'red').length}, amber ${s.krs.filter((k) => k.rag === 'amber').length}):`);
    krs.slice(0, krN).forEach((k, i) => add(i < 2 ? 1 : 3, krLine(k)));
  } else add(3, 'Key results: none set yet.');

  // Projects.
  const projLine = (p: OrgProject) => {
    const next = milestones(p).filter((m) => !m.done).sort((a, b) => a.date.localeCompare(b.date))[0];
    const open = s.tasks.filter((t) => t.projectId === p.id);
    return `- ${p.key} "${clip(p.title, 50)}" — ${HEALTH_WORDS[p.health] ?? p.health}${p.breakerAt ? ', breaker tripped' : ''}; lead ${p.ownerAgentId === agentId ? 'you' : nm(p.ownerAgentId)}${next ? `; next milestone "${clip(next.name, 30)}" ${day(next.date)}` : ''}${p.targetDate ? `; target ${day(p.targetDate)}` : ''}; ${open.length} open task(s)`;
  };
  const sev = (p: OrgProject) => (p.breakerAt ? 0 : p.health === 'off_track' ? 1 : p.health === 'at_risk' ? 2 : p.health === '' ? 3 : 4);
  if (v.role === 'chief') {
    const now = s.projects.filter((p) => p.lane === 'now');
    const count = (h: string) => now.filter((p) => p.health === h).length;
    add(1, `Portfolio: ${now.length} Now project(s) — ${count('on_track')} on track, ${count('at_risk')} at risk, ${count('off_track')} off track, ${count('')} without an update; ${s.projects.length - now.length} in Next/Later.`);
    [...now].sort((a, b) => sev(a) - sev(b)).filter((p) => sev(p) < 4).slice(0, 4).forEach((p, i) => add(i < 2 ? 1 : 3, projLine(p)));
  } else {
    const list = v.role === 'head'
      ? [...new Map([...v.myProjects, ...s.projects.filter((p) => p.unitId !== null && v.units.has(p.unitId) && p.unitId !== v.root?.id)].map((p) => [p.id, p])).values()]
      : v.myProjects;
    if (list.length) {
      add(1, v.role === 'head' ? `Your unit's projects (${list.length}):` : 'Your projects:');
      [...list].sort((a, b) => sev(a) - sev(b)).slice(0, v.role === 'head' ? 4 : 3).forEach((p, i) => add(i < 2 ? 1 : 3, projLine(p)));
    }
  }

  // Own work.
  const mine = [...v.mine].sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9));
  const blocked = mine.filter((t) => t.status === 'blocked').length;
  add(0, mine.length
    ? `Your open tasks: ${mine.length}${blocked ? ` (${blocked} blocked)` : ''} — ${mine.slice(0, 3).map((t) => `${taskRef(t)}${t.status === 'blocked' ? ' blocked' : t.status === 'in_progress' ? ' doing' : t.status === 'in_review' ? ' in review' : ''}`).join(', ')}${mine.length > 3 ? ', …' : ''}.`
    : 'Your open tasks: none.');

  // Role emphasis: the chief's exceptions, a head's staffing.
  if (v.role === 'chief') {
    const unassigned = s.tasks.filter((t) => !t.assigneeAgentId && t.status !== 'backlog').length;
    const backlog = s.tasks.filter((t) => t.status === 'backlog').length;
    const ceo = s.pending.filter((a) => a.holder === 'ceo').length;
    const stale = s.krs.filter((k) => !k.goal.lastCheckInAt).length;
    add(1, `Exceptions: ${s.tasks.filter((t) => t.status === 'blocked').length} blocked task(s), ${unassigned} unassigned, ${backlog} in backlog to triage; ${ceo} card(s) waiting on the CEO; ${stale} key result(s) never checked in.`);
  } else if (v.role === 'head') {
    const team = s.members.filter((m) => m.reportsToAgentId === agentId || (v.led && m.agentId !== agentId && s.units.find((u) => u.leadAgentId === m.reportsToAgentId)?.id === v.led.id));
    const unitTasks = s.tasks.filter((t) => t.unitId !== null && v.units.has(t.unitId) && t.unitId !== v.root?.id);
    const idle = team.filter((m) => !s.tasks.some((t) => t.assigneeAgentId === m.agentId));
    const unassigned = unitTasks.filter((t) => !t.assigneeAgentId).length;
    add(1, `Staffing: ${team.length} report(s)${idle.length ? `, idle: ${idle.slice(0, 4).map((m) => nm(m.agentId)).join(', ')}` : ', none idle'}; ${unassigned} unassigned task(s) in your unit; ${unitTasks.filter((t) => t.status === 'blocked').length} blocked.`);
  }

  // Decisions in the viewer's units (company-level ones are everyone's).
  const decisions = s.decisions.filter((d) => d.unitId === null || v.units.has(d.unitId)).slice(0, 3);
  if (decisions.length) add(2, `Recent decisions: ${decisions.map((d) => `"${clip(d.title, 60)}" (${day(d.createdAt)})`).join('; ')}.`);

  // Waiting on it.
  const cards = s.pending.filter((a) => a.holder === `agent:${agentId}` || (v.isChief && a.holder === 'chief')).length;
  const reviews = s.tasks.filter((t) => t.status === 'in_review' && t.reviewerAgentId === agentId);
  const waits = [
    cards ? `${cards} decision card(s) (org_decision_queue)` : '',
    reviews.length ? `${reviews.length} review(s): ${reviews.slice(0, 3).map((t) => taskRef(t)).join(', ')}` : '',
    unreadMentions ? `${unreadMentions} unread mention(s)` : '',
  ].filter(Boolean);
  add(0, `Waiting on you: ${waits.length ? waits.join('; ') : 'nothing'}.`);

  add(0, `More: org_company (mission, values, culture), org_people (chart), org_project <key>, org_intent (goals), org_task <key>, ws_catalog (every domain); your standing context is in ~/${COMPANY_NOTE}.`);

  // Fit the budget: drop the lowest-priority lines (latest first) until it fits.
  const fit = [...lines];
  const size = () => fit.reduce((n, l) => n + l.text.length + 1, 0);
  for (let p = 3; p > 0 && size() > BRIEFING_BUDGET; p--) {
    for (let i = fit.length - 1; i >= 0 && size() > BRIEFING_BUDGET; i--) if (fit[i].p === p) fit.splice(i, 1);
  }
  const text = fit.map((l) => l.text).join('\n');
  return text.length > BRIEFING_BUDGET ? `${text.slice(0, BRIEFING_BUDGET - 1)}…` : text;
}

function fmtNum(v: number | null | undefined): string { return v === null || v === undefined ? '?' : Number.isInteger(v) ? String(v) : v.toFixed(1); }
