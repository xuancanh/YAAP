/**
 * Live turns — which agent is mid-turn right now, and on which tool call
 * (docs/mission-control.md "Live"). The turn loop records a turn when it
 * starts, each tool call as it begins, and drops the turn when it ends,
 * however it ends. The agent overview and the org mission control read it
 * to say "Working on … · writing org/sales/reports/2026-W45.md".
 *
 * In-process and best-effort: a process restart forgets it (the running
 * turn died with the process anyway), and on a multi-instance deployment
 * each instance sees its own turns. Nothing here is persisted; the
 * persisted record of a turn stays `chat_turns`.
 */

export interface LiveTurn {
  sessionId: string;
  turnId: string;
  agentId: string | null;
  workspaceId: string;
  /** user | loop | channel | org | … (TurnOrigin). */
  origin: string;
  /** The conversation's name ("Loop · heartbeat", a chat title). */
  sessionName: string;
  startedAt: string;
  /** The tool call in progress (or the last one started), null before the first. */
  tool: string | null;
  /** The call, in words: "writing reports/weekly.md". */
  toolLabel: string;
  toolAt: string | null;
  /** Tool calls started so far in this turn. */
  calls: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A tool call in a few words, for the status line. Pure. */
export function describeToolCall(tool: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = str(i.path) || str(i.file) || str(i.filename) || str(i.from);
  const name = tool.replace(/^mcp__[^_]+__/, '');
  if (/^fs_delete|delete_file/.test(name) && path) return clip(`deleting ${path}`, 120);
  if (/(^|_)(write|create|save)(_file)?$|^fs_write|write_file|^update_file|^fs_edit|edit_file|^patch/.test(name) && path) return clip(`writing ${path}`, 120);
  if (/^fs_read|read_file|^fs_list|list_files|^fs_search|grep/.test(name)) return clip(path ? `reading ${path}` : 'reading files', 120);
  if (/web_search|search_web/.test(name)) return clip(`searching the web${str(i.query) ? ` for "${str(i.query)}"` : ''}`, 120);
  if (/web_fetch|http_|fetch_url|browser/.test(name)) return clip(`browsing${str(i.url) ? ` ${str(i.url)}` : ''}`, 120);
  if (/gmail_send|send_email|mail_send/.test(name)) return 'sending an email';
  if (/^org_task_comment/.test(name)) return 'commenting on a task';
  if (/^org_task_update|^update_task/.test(name)) return clip(`updating a task${str(i.status) ? ` to ${str(i.status).replace(/_/g, ' ')}` : ''}`, 120);
  if (/^org_task_create|^add_task|^create_task/.test(name)) return clip(`creating a task${str(i.title) ? ` "${str(i.title)}"` : ''}`, 120);
  if (/^org_escalate/.test(name)) return 'escalating a task';
  if (/channel_post|post_message|send_message/.test(name)) return 'posting a message';
  if (/run_code|code_exec|sandbox|python|shell/.test(name)) return 'running code';
  if (name === 'update_dashboard') return 'updating its dashboard';
  if (/memory|remember|lesson/.test(name)) return 'updating its memory';
  return clip(`using ${name.replace(/_/g, ' ')}`, 120);
}

export class LiveTurnRegistry {
  private readonly turns = new Map<string, LiveTurn>();

  begin(t: Pick<LiveTurn, 'sessionId' | 'turnId' | 'agentId' | 'workspaceId' | 'origin' | 'sessionName'>, now = new Date()): void {
    this.turns.set(t.sessionId, { ...t, startedAt: now.toISOString(), tool: null, toolLabel: '', toolAt: null, calls: 0 });
  }

  tool(sessionId: string, tool: string, input: unknown, now = new Date()): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    t.tool = tool; t.toolLabel = describeToolCall(tool, input); t.toolAt = now.toISOString(); t.calls += 1;
  }

  end(sessionId: string): void { this.turns.delete(sessionId); }

  /** One live turn per agent of a workspace (the most recently active). */
  byAgent(workspaceId: string): Map<string, LiveTurn> {
    const out = new Map<string, LiveTurn>();
    for (const t of this.turns.values()) {
      if (t.workspaceId !== workspaceId || !t.agentId) continue;
      const cur = out.get(t.agentId);
      if (!cur || (t.toolAt ?? t.startedAt) > (cur.toolAt ?? cur.startedAt)) out.set(t.agentId, { ...t });
    }
    return out;
  }

  clear(): void { this.turns.clear(); }
}

/** The process-wide registry the turn loop writes and the overviews read. */
export const liveTurns = new LiveTurnRegistry();

/** One event of a running turn, as the turn loop yields it. */
export interface WatchedEvent { type: string; [k: string]: unknown }
export type WatchListener = (ev: WatchedEvent) => void;
export interface WatchStart { turnId: string; source: string; startedAt: string; replay: WatchedEvent[] }

/** Bounded replay per turn: enough for a long run's steps; token deltas
 *  are merged, so a turn's prose costs one event per block. */
const REPLAY_CAP = 1_500;

/**
 * TurnWatchRegistry — the events of every running turn, for watchers that
 * did not start it (docs/work-log.md "Intervening": the Work log's live view
 * of a heartbeat, a task run, a meeting round). The turn loop begins a watch
 * when a turn takes its session's lock, publishes every event it yields, and
 * ends it however the turn ends. A watcher that arrives mid-turn first gets
 * the replay (thinking and answer deltas merged; pending approvals kept), then
 * the live events, then `{ type: 'end' }`.
 *
 * In-process and best-effort, like `liveTurns`: on a multi-instance
 * deployment a watcher on another instance sees no live turn and the Work
 * log falls back to polling the run.
 */
export class TurnWatchRegistry {
  private readonly turns = new Map<string, { turnId: string; source: string; startedAt: string; events: WatchedEvent[]; listeners: Set<WatchListener> }>();

  begin(sessionId: string, turnId: string, source: string, now = new Date()): void {
    const prior = this.turns.get(sessionId);
    if (prior) for (const l of prior.listeners) safeCall(l, { type: 'end' });
    this.turns.set(sessionId, { turnId, source, startedAt: now.toISOString(), events: [], listeners: new Set() });
  }

  publish(sessionId: string, ev: WatchedEvent): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    const last = t.events.at(-1);
    if ((ev.type === 'thinking' || ev.type === 'answer') && last?.type === ev.type && typeof last.text === 'string' && typeof ev.text === 'string') {
      t.events[t.events.length - 1] = { ...last, text: last.text + ev.text };
    } else if (ev.type !== 'usage') {
      t.events.push(ev);
      if (t.events.length > REPLAY_CAP) {
        // drop the oldest event that is not an approval request
        const i = t.events.findIndex((e) => e.type !== 'approval_required');
        t.events.splice(i < 0 ? 0 : i, 1);
      }
    }
    for (const l of t.listeners) safeCall(l, ev);
  }

  end(sessionId: string): void {
    const t = this.turns.get(sessionId);
    if (!t) return;
    this.turns.delete(sessionId);
    for (const l of t.listeners) safeCall(l, { type: 'end' });
  }

  /** The running turn of a session: its replay, and a subscription to what
   *  follows. Null when no turn runs here (on this instance). */
  watch(sessionId: string, listener: WatchListener): { start: WatchStart; unsubscribe: () => void } | null {
    const t = this.turns.get(sessionId);
    if (!t) return null;
    t.listeners.add(listener);
    return {
      start: { turnId: t.turnId, source: t.source, startedAt: t.startedAt, replay: t.events.map((e) => ({ ...e })) },
      unsubscribe: () => { t.listeners.delete(listener); },
    };
  }

  running(sessionId: string): { turnId: string; startedAt: string } | null {
    const t = this.turns.get(sessionId);
    return t ? { turnId: t.turnId, startedAt: t.startedAt } : null;
  }

  clear(): void { this.turns.clear(); }
}

function safeCall(l: WatchListener, ev: WatchedEvent): void {
  try { l(ev); } catch { /* a watcher never breaks the turn */ }
}

/** The process-wide registry the turn loop publishes into. */
export const turnWatch = new TurnWatchRegistry();
