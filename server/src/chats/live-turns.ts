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
