/**
 * The per-agent status every overview shares (docs/home.md "Team",
 * docs/mission-control.md): Home's team grid, an agent's own Dashboard
 * (`GET /api/agents/:id/overview`) and the org mission control
 * (`GET /api/workspaces/:id/org/mission-control`) all read it from here, so
 * an agent is never "working" on one screen and "blocked" on another.
 *
 * The state, in order of precedence:
 *
 *  - **error** — the latest turn failed (a model name the provider rejects, a
 *    key that fails), an unread loop error or budget stop since it last ran,
 *    or a no-progress breaker on one of its tasks;
 *  - **paused** — its seat, or the whole company, is paused;
 *  - **blocked** — nothing in progress and a task of its own is blocked;
 *  - **working** — a task in progress or claimed, a review it owes, a task on
 *    its own board marked doing, or a turn running right now;
 *  - **idle** — none of the above.
 *
 * A degraded provider is listed as an error but does not by itself turn the
 * agent red: the turn falls back to another provider.
 *
 * Read-only and model-free. `deriveState` and `blockerOf` are pure.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { chatSessions, chatTurns, heartbeatState } from '../database/schema';
import type { AgentsService } from '../agents/agents.service';
import type { ProviderHealthService } from '../ai/provider-health';
import type { Organization } from '../org/org.service';
import type { OrgTask, OrgTasksService } from '../org/org-tasks.service';
import { liveTurns as defaultLive, type LiveTurn, type LiveTurnRegistry } from '../chats/live-turns';
import type { HomeAgent, HomeAgentError, HomeAgentState } from './home.types';

const DAY_MS = 24 * 60 * 60_000;
/** Errors older than this no longer mark an agent as failing. */
export const ERROR_WINDOW_MS = 2 * DAY_MS;
/** A task still counts as "in flight" in these statuses (the WIP count, org-tasks.service WIP_STATUSES). */
export const OPEN_STATUSES = ['todo', 'claimed', 'in_progress', 'blocked'] as const;

export type AgentRow = Awaited<ReturnType<AgentsService['list']>>[number];
type MemberLike = { agentId: string; status: string; title: string; reportsToAgentId?: string | null };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const parseList = (raw: string | null | undefined): string[] => {
  try { const v = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
};

/** What a blocked task waits on, as far as the board says. */
export interface BlockerInfo {
  /** The latest blocker line, in words. */
  reason: string;
  /** `ceo` = you (an escalation to the owner); `agent` = a member it escalated to or
   *  whose task it waits on; `task` = a task with no assignee; `unknown` = a free-text blocker. */
  waitsOn: { kind: 'ceo' | 'agent' | 'task' | 'unknown'; id: string | null; name: string; taskId: string | null };
  /** When it was blocked, as near as the row says (its last update). */
  since: string;
}

/**
 * Read a blocked task's blockers (org-tasks.service `escalate`, `escalateTo`,
 * free-text lines, task ids) and unmet dependencies into one answer: the
 * latest reason, and who or what it waits on. Pure.
 */
export function blockerOf(t: Pick<OrgTask, 'id' | 'blockers' | 'dependsOn' | 'updatedAt'>, ctx: {
  tasksById: Map<string, Pick<OrgTask, 'id' | 'title' | 'status' | 'assigneeAgentId'>>;
  names: Map<string, string>;
  /** A pending CEO escalation card exists for this task. */
  escalatedToCeo?: boolean;
}): BlockerInfo {
  const lines = parseList(t.blockers);
  const byPrefix = (id: string) => ctx.tasksById.get(id) ?? [...ctx.tasksById.values()].find((x) => id.length >= 8 && x.id.startsWith(id));
  const idByName = (name: string) => [...ctx.names.entries()].find(([, n]) => n.toLowerCase() === name.trim().toLowerCase())?.[0] ?? null;
  const since = t.updatedAt;
  for (const line of lines.slice().reverse()) {
    const to = /^escalated to (.+?): ([\s\S]*)$/.exec(line);
    if (to) {
      const id = idByName(to[1]);
      return { reason: clip(to[2], 240), waitsOn: { kind: 'agent', id, name: id ? ctx.names.get(id)! : to[1], taskId: null }, since };
    }
    const ceo = /^escalated: ([\s\S]*)$/.exec(line);
    if (ceo) return { reason: clip(ceo[1], 240), waitsOn: { kind: 'ceo', id: null, name: 'You', taskId: null }, since };
    const dep = /^[0-9a-f-]{8,}$/i.test(line.trim()) ? byPrefix(line.trim()) : undefined;
    if (dep && dep.status !== 'done' && dep.status !== 'cancelled') return taskWait(dep, ctx.names, since, `Waits on "${clip(dep.title, 120)}"`);
  }
  for (const id of parseList(t.dependsOn)) {
    const dep = byPrefix(id);
    if (dep && dep.status !== 'done' && dep.status !== 'cancelled') return taskWait(dep, ctx.names, since, `Waits on "${clip(dep.title, 120)}"`);
  }
  const last = lines.at(-1) ?? '';
  if (ctx.escalatedToCeo) return { reason: clip(last || 'Escalated to you', 240), waitsOn: { kind: 'ceo', id: null, name: 'You', taskId: null }, since };
  return { reason: clip(last, 240), waitsOn: { kind: 'unknown', id: null, name: '', taskId: null }, since };
}

function taskWait(dep: Pick<OrgTask, 'id' | 'title' | 'assigneeAgentId'>, names: Map<string, string>, since: string, reason: string): BlockerInfo {
  const who = dep.assigneeAgentId;
  return who
    ? { reason, waitsOn: { kind: 'agent', id: who, name: names.get(who) ?? who.slice(0, 8), taskId: dep.id }, since }
    : { reason, waitsOn: { kind: 'task', id: null, name: dep.title, taskId: dep.id }, since };
}

/**
 * What to do about an error, when the message makes it obvious, and where
 * (`tab` is an agent-page tab: 'Settings:General', 'Work:Schedule', …).
 * Pure; null when there is nothing better to say than the message.
 */
export function fixHint(e: Pick<HomeAgentError, 'kind' | 'message'>): { text: string; tab: string | null } | null {
  const m = e.message.toLowerCase();
  const rounds = /tool round limit \((\d+)\)/.exec(m);
  if (rounds) return { text: `It used all ${rounds[1]} tool rounds in one turn. Split the work into smaller steps, or raise the server's MAX_TOOL_ROUNDS.`, tab: null };
  if (/token ceiling|budget reached/.test(m)) return { text: 'The loop ran out of its token budget. Raise the loop budget or clear its conversation.', tab: 'Work:Schedule' };
  if (e.kind === 'budget' || /monthly budget|budget stop|over budget/.test(m)) return { text: 'Its spending cap stopped it. Raise its monthly budget or wait for the month to turn.', tab: null };
  if (e.kind === 'breaker') return { text: 'It keeps running without moving the task. Answer on the task, split it, or reassign it.', tab: null };
  if (/api key|unauthori[sz]ed|\b401\b|invalid x-api-key|authentication/.test(m)) return { text: 'The provider refused the key. Check the provider key in Settings.', tab: null };
  if (/model/.test(m) && /not found|rejected|does not exist|unknown|invalid|unsupported|\b404\b/.test(m)) return { text: 'The provider does not accept this model. Pick another one.', tab: 'Settings:General' };
  if (/rate.?limit|\b429\b|overloaded|\b529\b/.test(m)) return { text: 'The provider is rate-limiting or overloaded. It tries again on its next run.', tab: null };
  if (/could not poll|connection|reconnect/.test(m)) return { text: 'A connection it reads from failed. Reconnect it in Settings.', tab: 'Settings:Skills & tools' };
  return null;
}

/**
 * The one error the page leads with: a red one before a degraded provider,
 * one that says what to do before one that does not, a specific message
 * before a generic one, then the newest. Pure; null without errors.
 */
export function primaryError<E extends Pick<HomeAgentError, 'kind' | 'message' | 'at'>>(errors: E[]): E | null {
  if (errors.length === 0) return null;
  const generic = (e: E) => /recorded no reason|the last turn failed/i.test(e.message);
  const score = (e: E) => (e.kind === 'provider' ? 0 : 8) + (fixHint(e) ? 4 : 0) + (generic(e) ? 0 : 2);
  return errors.slice().sort((x, y) => score(y) - score(x) || y.at.localeCompare(x.at))[0];
}

/** The state from the facts, in the precedence the header lists. Pure. */
export function deriveState(f: { errors: HomeAgent['errors']; paused: boolean; blocked: boolean; doing: string; live: boolean }): HomeAgentState {
  if (f.errors.some((e) => e.kind === 'turn' || e.kind === 'breaker' || e.kind === 'loop' || e.kind === 'budget')) return 'error';
  if (f.paused) return 'paused';
  if (f.blocked) return 'blocked';
  if (f.doing || f.live) return 'working';
  return 'idle';
}

/** Home's agent tile plus what the overviews add. */
export interface AgentStatus extends HomeAgent {
  /** A turn running right now (in this process), with its current tool call. */
  live: LiveTurn | null;
  /** When the current task started, as near as the board says (its claim, else its last update). */
  doingSince: string | null;
  /** Its blocked org tasks, each with what it waits on. */
  blocked: Array<{ taskId: string; title: string; blocker: BlockerInfo }>;
  /** Of those, the ones waiting on you (the CEO). */
  waitingOnYou: number;
  /** Open org tasks (the WIP count). */
  open: number;
  lastRunAt: string | null;
  /** Its seat in the company: active | paused | null outside one. */
  memberStatus: string | null;
  reportsToAgentId: string | null;
}

export interface StatusDeps {
  db: DrizzleDb;
  agents: AgentsService;
  providerHealth?: ProviderHealthService;
  tasks?: OrgTasksService;
  live?: LiveTurnRegistry;
}

export interface StatusInput {
  workspaceId: string;
  org: Organization | null;
  /** The company is on (organization mode, companies enabled). */
  orgOn: boolean;
  agents: AgentRow[];
  orgTasks: OrgTask[];
  members: MemberLike[];
  /** Task ids with a pending escalation card to the CEO. */
  ceoEscalations?: Set<string>;
  now: Date;
}

/** Every live (not terminated) agent's status, in the order of `input.agents`. */
export async function agentStatuses(deps: StatusDeps, input: StatusInput): Promise<AgentStatus[]> {
  const { db, agents: agentsSvc } = deps;
  const { workspaceId, org, orgOn, agents, orgTasks, members, now } = input;
  const memberOf = new Map(members.map((m) => [m.agentId, m]));
  const cutoff = new Date(now.getTime() - ERROR_WINDOW_MS).toISOString();
  // The latest turn per agent: an errored one (a model the provider rejects, a key that fails) is loud.
  const sessions = await db.select({ id: chatSessions.id, agentId: chatSessions.agentId }).from(chatSessions).where(eq(chatSessions.workspaceId, workspaceId));
  const agentOfSession = new Map(sessions.filter((s) => s.agentId).map((s) => [s.id, s.agentId as string]));
  const latestTurn = new Map<string, { sessionId: string; status: string; error: string | null; createdAt: string }>();
  if (agentOfSession.size > 0) {
    const turns = await db.select({ sessionId: chatTurns.sessionId, status: chatTurns.status, error: chatTurns.error, createdAt: chatTurns.createdAt })
      .from(chatTurns).where(and(inArray(chatTurns.sessionId, [...agentOfSession.keys()]), gte(chatTurns.createdAt, cutoff)));
    for (const t of turns) {
      const agentId = agentOfSession.get(t.sessionId)!;
      const cur = latestTurn.get(agentId);
      if (!cur || t.createdAt > cur.createdAt) latestTurn.set(agentId, t);
    }
  }
  const beats = agents.length
    ? await db.select({ agentId: heartbeatState.agentId, lastBeatAt: heartbeatState.lastBeatAt, lastRunAt: heartbeatState.lastRunAt }).from(heartbeatState).where(inArray(heartbeatState.agentId, agents.map((a) => a.id))).catch(() => [])
    : [];
  const beatOf = new Map(beats.map((b) => [b.agentId, b]));
  const degraded = deps.providerHealth ? deps.providerHealth.list(workspaceId) : [];
  const runs = org && deps.tasks ? await deps.tasks.runs(org.id, { limit: 200 }).catch(() => []) : [];
  const live = (deps.live ?? defaultLive).byAgent(workspaceId);
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const tasksById = new Map(orgTasks.map((t) => [t.id, t]));

  const out: AgentStatus[] = [];
  for (const a of agents) {
    const m = memberOf.get(a.id);
    if (m?.status === 'terminated') continue;
    const errors: HomeAgent['errors'] = [];
    const lt = latestTurn.get(a.id);
    const events = await agentsSvc.listEvents(a.id, 20);
    // A failed turn that recorded no message of its own: the loop that ran it
    // says why ("tool round limit (24) reached"), read or not.
    const explainedBy = lt && lt.status === 'error' && !lt.error?.trim()
      ? events.find((e) => e.kind === 'loop_error' && e.body && (e.sessionId === lt.sessionId || Math.abs(Date.parse(e.createdAt) - Date.parse(lt.createdAt)) < 60 * 60_000))
      : undefined;
    if (lt && lt.status === 'error') {
      errors.push({ kind: 'turn', message: clip(lt.error?.trim() || explainedBy?.body || 'The last turn failed and recorded no reason', 280), at: lt.createdAt, sessionId: lt.sessionId });
    }
    const lastGood = events.find((e) => e.kind === 'loop_run');
    for (const e of events.filter((x) => (x.kind === 'loop_error' || x.kind === 'budget_stop') && x.createdAt >= cutoff && !x.readAt).slice(0, 2)) {
      if (e.kind === 'loop_error' && lastGood && lastGood.createdAt > e.createdAt) continue; // recovered since
      if (e === explainedBy) continue; // already the turn's reason
      errors.push({ kind: e.kind === 'budget_stop' ? 'budget' : 'loop', message: clip(`${e.title}${e.body ? `: ${e.body}` : ''}`, 280), at: e.createdAt, sessionId: e.sessionId || null });
    }
    const mine = orgTasks.filter((t) => t.assigneeAgentId === a.id);
    for (const t of mine.filter((x) => x.noProgressCount >= 2 && x.status !== 'done' && x.status !== 'cancelled').slice(0, 1)) {
      errors.push({ kind: 'breaker', message: `No progress after ${t.noProgressCount} runs on "${clip(t.title, 80)}"`, at: t.lastRunAt ?? t.updatedAt, taskId: t.id });
    }
    const providerKey = a.provider || '';
    for (const p of degraded.filter((d) => providerKey && (d.provider === providerKey || providerKey.startsWith(d.provider)))) {
      errors.push({ kind: 'provider', message: `${p.provider} is ${p.state}${p.lastError ? `: ${clip(p.lastError, 200)}` : ''}`, at: p.since });
    }

    const doingTask = mine.filter((t) => t.status === 'in_progress' || t.status === 'claimed').sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0]
      ?? orgTasks.filter((t) => t.status === 'in_review' && t.reviewerAgentId === a.id)[0];
    const blockedTasks = mine.filter((t) => t.status === 'blocked');
    const blockedTask = blockedTasks[0];
    const blockedRows = blockedTasks.map((t) => ({ taskId: t.id, title: t.title, blocker: blockerOf(t, { tasksById, names, escalatedToCeo: input.ceoEscalations?.has(t.id) }) }));
    let doing = '';
    let taskId: string | null = null;
    if (doingTask) { doing = doingTask.status === 'in_review' ? `Reviewing "${doingTask.title}"` : doingTask.title; taskId = doingTask.id; }
    else if (blockedTask) {
      const why = blockedRows[0].blocker;
      const reason = why.reason;
      doing = `Blocked on "${blockedTask.title}"${reason ? `: ${clip(reason, 120)}` : ''}`; taskId = blockedTask.id;
    }
    else {
      const own = (await agentsSvc.listTasks(a.id)).filter((t) => t.status === 'doing' || t.status === 'blocked').sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
      if (own) doing = own.status === 'blocked' ? `Blocked on "${own.title}"` : own.title;
    }
    const paused = m?.status === 'paused' || Boolean(orgOn && org?.status === 'paused');
    const blocked = !doingTask && (Boolean(blockedTask) || doing.startsWith('Blocked'));
    const liveTurn = live.get(a.id) ?? null;
    const state = deriveState({ errors, paused, blocked, doing, live: Boolean(liveTurn) });
    const beat = beatOf.get(a.id);
    const lastRun = runs.filter((r) => r.agentId === a.id).map((r) => r.startedAt).sort().at(-1) ?? null;
    const lastActiveAt = [liveTurn?.toolAt ?? liveTurn?.startedAt ?? null, lt?.createdAt ?? null, beat?.lastRunAt ?? null, lastRun, events.find((e) => e.kind === 'loop_run')?.createdAt ?? null]
      .filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    out.push({
      id: a.id, name: a.name, emoji: a.emoji, colors: a.colors, title: m?.title || a.role || '', state, doing, taskId,
      lastActiveAt, lastBeatAt: beat?.lastBeatAt ?? null, errors, isChief: Boolean(org?.chiefOfStaffAgentId && org.chiefOfStaffAgentId === a.id),
      live: liveTurn,
      doingSince: doingTask && doingTask.status !== 'in_review' ? doingTask.claimedAt ?? doingTask.updatedAt : null,
      blocked: blockedRows,
      waitingOnYou: blockedRows.filter((b) => b.blocker.waitsOn.kind === 'ceo').length,
      open: mine.filter((t) => (OPEN_STATUSES as readonly string[]).includes(t.status)).length,
      lastRunAt: beat?.lastRunAt ?? lastRun ?? null,
      memberStatus: m?.status ?? null,
      reportsToAgentId: m?.reportsToAgentId ?? null,
    });
  }
  return out;
}

const TEAM_ORDER: Record<HomeAgentState, number> = { error: 0, blocked: 1, working: 2, paused: 3, idle: 4 };

/** Home's order: the chief first, then failing, blocked, working, paused and idle, then by name. */
export function sortTeam<T extends Pick<HomeAgent, 'isChief' | 'state' | 'name'>>(list: T[]): T[] {
  return list.slice().sort((x, y) => Number(y.isChief) - Number(x.isChief) || TEAM_ORDER[x.state] - TEAM_ORDER[y.state] || x.name.localeCompare(y.name));
}

/** The Home tile: the shared status without the overview extras. */
export function toHomeAgent(s: AgentStatus): HomeAgent {
  return { id: s.id, name: s.name, emoji: s.emoji, colors: s.colors, title: s.title, state: s.state, doing: s.doing, taskId: s.taskId, lastActiveAt: s.lastActiveAt, lastBeatAt: s.lastBeatAt, errors: s.errors, isChief: s.isChief };
}
