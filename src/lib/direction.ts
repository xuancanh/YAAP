/** Direction's pure summaries (Overview, Vision, Goals, Roadmap, Decisions):
 *  the health of a key result and an objective, the "needs attention" list
 *  the CEO acts on, the vision's horizon, decision one-liners and filters,
 *  and plurals. The components render these; web-tests pin them. */
import type { OrgDecision, OrgIntentNode, ProgramMatrix, ProjectSummary } from './api';
import { checkInDue, decisionSource, flattenIntent } from './org';
import { appetiteUsed } from './roadmap';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';
export type Health = 'on_track' | 'at_risk' | 'off_track' | 'done' | 'unknown' | 'dropped';

/** "1 key result", "3 key results"; `many` for irregular plurals. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const HEALTH_LABEL: Record<Health, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Achieved', unknown: 'No signal yet', dropped: 'Abandoned' };
export const HEALTH_TONE: Record<Health, Tone> = { on_track: 'ok', at_risk: 'warn', off_track: 'bad', done: 'ok', unknown: 'muted', dropped: 'muted' };
const RANK: Record<Health, number> = { off_track: 0, at_risk: 1, unknown: 2, on_track: 3, done: 4, dropped: 5 };

/** A project's lead-reported health word as a Health. */
export function projectHealth(h: string | null | undefined): Health {
  return h === 'on_track' || h === 'at_risk' || h === 'off_track' ? h : 'unknown';
}

/** A key result's health: the at-risk flag (with pace behind it is off track), else its pace. */
export function krHealth(g: Pick<OrgIntentNode, 'status' | 'atRisk' | 'pace' | 'measured' | 'expected'>): Health {
  if (g.status === 'achieved') return 'done';
  if (g.status === 'abandoned') return 'dropped';
  const farBehind = g.pace === 'behind' && g.measured !== null && g.expected !== null && g.expected - g.measured >= 0.25;
  if (g.atRisk === 1) return g.pace === 'behind' || farBehind ? 'off_track' : 'at_risk';
  if (farBehind) return 'off_track';
  if (g.pace === 'behind') return 'at_risk';
  if (g.pace === 'onPace') return 'on_track';
  return 'unknown';
}

/** An objective's health: the worst of its active key results, else its own flag. */
export function objectiveHealth(o: OrgIntentNode): Health {
  if (o.status === 'achieved') return 'done';
  if (o.status === 'abandoned') return 'dropped';
  const krs = o.children.filter((c) => c.kind === 'key_result' && c.status === 'active');
  if (krs.length === 0) return o.atRisk === 1 ? 'at_risk' : o.progress > 0 ? 'on_track' : 'unknown';
  const worst = krs.map(krHealth).sort((a, b) => RANK[a] - RANK[b])[0];
  return o.atRisk === 1 && RANK[worst] > RANK.at_risk ? 'at_risk' : worst;
}

/** The objectives of an intent tree (under the vision when it is the root). */
export function objectivesOfTree(tree: OrgIntentNode[]): OrgIntentNode[] {
  const vision = tree.find((n) => n.kind === 'vision');
  return (vision ? vision.children : tree).filter((n) => n.kind !== 'vision');
}

/** A key result's value: "12 → 40 learners", null pieces as "?". */
export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '?';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return v.toFixed(Math.abs(v) < 10 ? 2 : 1);
}

/** The next check-in date of a key result (last check-in or creation + cadence). */
export function nextCheckIn(g: Pick<OrgIntentNode, 'lastCheckInAt' | 'createdAt' | 'checkInCadenceDays'>): Date | null {
  const t = Date.parse(g.lastCheckInAt ?? g.createdAt);
  return Number.isFinite(t) ? new Date(t + g.checkInCadenceDays * 86_400_000) : null;
}

export function shortDate(d: Date | string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string {
  if (!d) return '—';
  const x = typeof d === 'string' ? new Date(d.length <= 10 ? `${d}T00:00:00` : d) : d;
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleDateString(undefined, opts);
}

/** Relative day words: "today", "in 3 days", "4 days ago". */
export function inDays(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return '';
  const t = typeof d === 'string' ? Date.parse(d.length <= 10 ? `${d}T00:00:00` : d) : d.getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.round((t - now.getTime()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${plural(days, 'day')}` : `${plural(-days, 'day')} ago`;
}

/** The vision's horizon: days left and the share of the way from when it was set. */
export function horizonOf(v: { createdAt: string; dueAt: string | null } | null | undefined, now = new Date()): { daysLeft: number; elapsed: number; label: string } | null {
  if (!v?.dueAt) return null;
  const end = Date.parse(v.dueAt); const start = Date.parse(v.createdAt);
  if (!Number.isFinite(end)) return null;
  const daysLeft = Math.ceil((end - now.getTime()) / 86_400_000);
  const elapsed = Number.isFinite(start) && end > start ? Math.max(0, Math.min(1, (now.getTime() - start) / (end - start))) : 0;
  const when = new Date(end).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return { daysLeft, elapsed, label: daysLeft >= 0 ? `By ${when} · ${plural(daysLeft, 'day')} left` : `${when} has passed` };
}

// ---- needs attention ----

export type AttentionTarget = { pane: 'goals' | 'roadmap' | 'vision' | 'approvals'; focus?: { kind: 'goal' | 'project'; id: string } };
export interface AttentionItem { id: string; tone: Tone; kind: 'kr_risk' | 'checkin' | 'unowned_goal' | 'unowned_project' | 'appetite' | 'update' | 'late' | 'project_risk' | 'request' | 'no_vision'; title: string; why: string; go: string; target: AttentionTarget }

const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, info: 2, ok: 3, muted: 4 };

/** What the CEO should look at next across Direction, worst first. */
export function attentionItems(input: { intent: OrgIntentNode[]; projects: ProjectSummary[]; program?: ProgramMatrix | null; hasVision?: boolean }, now = new Date()): AttentionItem[] {
  const out: AttentionItem[] = [];
  const owners = new Map((input.program?.items ?? []).map((i) => [`${i.refType}:${i.id}`, i.owner]));
  if (input.hasVision === false) out.push({ id: 'vision', tone: 'warn', kind: 'no_vision', title: 'No vision written yet', why: 'The chief plans objectives from it; nothing below has a why until it exists.', go: 'Write it', target: { pane: 'vision' } });
  for (const g of flattenIntent(input.intent)) {
    if (g.status !== 'active' || g.kind === 'vision') continue;
    const goal = { pane: 'goals' as const, focus: { kind: 'goal' as const, id: g.id } };
    const owner = owners.get(`goal:${g.id}`);
    if (g.kind === 'key_result') {
      const h = krHealth(g);
      if (h === 'off_track' || h === 'at_risk') out.push({ id: `risk:${g.id}`, tone: h === 'off_track' ? 'bad' : 'warn', kind: 'kr_risk', title: `${HEALTH_LABEL[h]}: ${g.title}`, why: g.atRiskReason || (g.expected !== null && g.measured !== null ? `${Math.round(g.measured * 100)}% done where ${Math.round(g.expected * 100)}% was expected by now.` : 'Behind its pace.'), go: 'Review', target: goal });
      else if (checkInDue(g, now)) out.push({ id: `checkin:${g.id}`, tone: 'info', kind: 'checkin', title: `Check-in due: ${g.title}`, why: g.lastCheckInAt ? `Last check-in ${inDays(g.lastCheckInAt, now)}; due every ${plural(g.checkInCadenceDays, 'day')}.` : 'Never checked in.', go: 'Check in', target: goal });
    }
    if (!g.ownerAgentId && (!owner || owner.role === 'none' || owner.role === 'inactive')) out.push({ id: `owner:${g.id}`, tone: 'warn', kind: 'unowned_goal', title: `No owner: ${g.title}`, why: g.kind === 'key_result' ? 'Nobody checks in on this key result.' : 'Nobody owns this objective.', go: 'Assign', target: goal });
  }
  for (const p of input.projects) {
    if (p.kind !== 'project' || p.status === 'done' || p.status === 'cancelled') continue;
    const name = `${p.key ? `${p.key} ` : ''}${p.title}`;
    const project = { pane: 'roadmap' as const, focus: { kind: 'project' as const, id: p.id } };
    const owner = owners.get(`project:${p.id}`);
    if (p.lead?.kind === 'none' && (!owner || owner.role === 'none')) out.push({ id: `powner:${p.id}`, tone: 'warn', kind: 'unowned_project', title: `No lead: ${name}`, why: 'Nobody posts its health or breaks it into tasks.', go: 'Open', target: project });
    const used = p.appetite ? appetiteUsed(p.appetite) : null;
    if (p.appetite?.tripped || (used !== null && used >= 1)) out.push({ id: `app:${p.id}`, tone: 'bad', kind: 'appetite', title: `Over appetite: ${name}`, why: p.appetite?.tripped ? 'The breaker tripped: new task claims are paused until it is extended, cut or killed.' : `${Math.round((used ?? 0) * 100)}% of its appetite used.`, go: 'Decide', target: project });
    else if (p.late) out.push({ id: `late:${p.id}`, tone: 'bad', kind: 'late', title: `Past its target date: ${name}`, why: p.targetDate ? `Target was ${shortDate(p.targetDate)}.` : 'Past its target date.', go: 'Open', target: project });
    else if (p.lane === 'now' && (p.health === 'at_risk' || p.health === 'off_track')) out.push({ id: `health:${p.id}`, tone: p.health === 'off_track' ? 'bad' : 'warn', kind: 'project_risk', title: `${HEALTH_LABEL[p.health]}: ${name}`, why: p.healthAsk ? `${p.healthReason ? `${p.healthReason} ` : ''}Ask: ${p.healthAsk}` : p.healthReason || 'The lead called it at risk.', go: 'Open', target: project });
    if (p.update?.state === 'missing') out.push({ id: `upd:${p.id}`, tone: 'warn', kind: 'update', title: `Health update missing: ${name}`, why: `The lead posts one every ${plural(p.update.cadenceDays, 'day')}.`, go: 'Open', target: project });
  }
  for (const r of input.program?.requests ?? []) {
    if (r.status !== 'open' && r.status !== 'escalated') continue;
    out.push({ id: `req:${r.id}`, tone: r.overdue || r.status === 'escalated' ? 'warn' : 'info', kind: 'request', title: `${r.role} for ${r.projectKey ?? r.projectTitle} (${r.allocation}%)`, why: `${r.status === 'escalated' ? 'Escalated' : 'Waiting'} on ${r.headName}${r.overdue ? ', past its answer-by time' : ''}.`, go: 'Open', target: { pane: 'roadmap', focus: { kind: 'project', id: r.projectId } } });
  }
  return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

/** A project's next open milestone with a date. */
export function nextMilestone(p: Pick<ProjectSummary, 'milestones'>): { name: string; date: string } | null {
  const m = (p.milestones ?? []).filter((x) => !x.done && x.date).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))[0];
  return m ? { name: m.name, date: m.date! } : null;
}

// ---- decisions ----

const PREFIX = /^\s*([A-Za-z][A-Za-z _-]{1,40}):\s+/;

/** Markdown emphasis and backticks out, whitespace collapsed. */
export function plainText(s: string): string {
  return (s ?? '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

/** A decision as one readable line and the kind its title names ("hire", "escalation"…). */
export function decisionLine(d: Pick<OrgDecision, 'title' | 'decision'>): { kind: string | null; line: string } {
  const t = plainText(d.title || d.decision);
  const m = PREFIX.exec(t);
  if (!m) return { kind: null, line: t };
  const rest = t.slice(m[0].length);
  return { kind: m[1].trim().toLowerCase(), line: rest ? rest[0].toUpperCase() + rest.slice(1) : t };
}

export const SOURCE_LABEL: Record<string, string> = { meeting: 'Meeting', approval: 'Your call', cadence: 'Cadence change', autonomous: 'Chief, on its own' };

export interface DecisionFilter { q: string; source: string; decider: string; since: 'all' | '7d' | '30d' | '90d'; link: 'all' | 'goal' | 'project' | 'meeting' }

export function filterDecisions(rows: OrgDecision[], f: DecisionFilter, now = new Date()): OrgDecision[] {
  const q = f.q.trim().toLowerCase();
  const sinceDays = f.since === '7d' ? 7 : f.since === '30d' ? 30 : f.since === '90d' ? 90 : 0;
  return rows.filter((d) => {
    if (f.source !== 'all' && decisionSource(d) !== f.source) return false;
    if (f.decider !== 'all' && d.decidedBy !== f.decider) return false;
    if (sinceDays && now.getTime() - Date.parse(d.createdAt) > sinceDays * 86_400_000) return false;
    if (f.link === 'goal' && d.refType !== 'goal') return false;
    if (f.link === 'project' && d.refType !== 'project') return false;
    if (f.link === 'meeting' && !d.meetingId) return false;
    if (q && !`${d.title} ${d.decision} ${d.rationale} ${d.alternatives}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Decisions grouped under day headings ("Today", "Yesterday", "Mon, Nov 2"). */
export function groupByDay(rows: OrgDecision[], now = new Date()): Array<{ day: string; label: string; rows: OrgDecision[] }> {
  const key = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = key(now.toISOString()); const yday = key(new Date(now.getTime() - 86_400_000).toISOString());
  const out: Array<{ day: string; label: string; rows: OrgDecision[] }> = [];
  for (const r of rows) {
    const k = key(r.createdAt);
    let g = out.find((x) => x.day === k);
    if (!g) { g = { day: k, label: k === today ? 'Today' : k === yday ? 'Yesterday' : new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }), rows: [] }; out.push(g); }
    g.rows.push(r);
  }
  return out;
}

/** Is a decision easy to undo? Approval and cadence changes can be revised; the record says so when it can. */
export function reversibilityOf(d: Pick<OrgDecision, 'alternatives' | 'rationale' | 'decision'>): string | null {
  const m = /\b(irreversible|one-way door|two-way door|reversible|can be undone|cannot be undone)\b/i.exec(`${d.decision} ${d.rationale} ${d.alternatives}`);
  if (!m) return null;
  const w = m[1].toLowerCase();
  return w === 'irreversible' || w === 'one-way door' || w === 'cannot be undone' ? 'Hard to reverse' : 'Reversible';
}
