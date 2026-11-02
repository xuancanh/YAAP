/**
 * Home activity and Coming up, the pure parts (docs/home.md "Activity",
 * "Coming up"): what a loop run did, in words; routine runs collapsed into
 * one line per agent per day; rituals held by several units at the same time
 * merged into one row. Model-free and side-effect free so the tests pin them.
 */
import type { HomeActivity, HomeRun, HomeUpcoming } from './home.types';

/** One recorded tool call of a turn (chat_turns.toolCalls). */
export interface RunCall { tool: string; input?: Record<string, unknown> | null; isError?: boolean }

/** What one loop run did. `notable` is false for a run that only looked
 *  around and kept its own notes (the routine heartbeat). */
export interface RunSummary { notable: boolean; phrases: string[]; taskId: string | null }

/** Files an agent keeps for itself on every beat: writing them is bookkeeping, not news. */
const BOOKKEEPING = /^(journal|lessons|notes|memory|scratch|scratchpad|dashboard|todo|log)\.md$/i;
const FILE_WRITES = new Set(['fs_write', 'fs_edit', 'fs_append', 'fs_delete', 'fs_restore', 'slides_create']);
/** Company changes an agent can make from a beat (governance and proposals). */
const COMPANY_CHANGES: Record<string, string> = {
  org_hire_agent: 'proposed a hire', org_pause_agent: 'paused a member', org_terminate_agent: 'proposed a departure', org_reorg: 'proposed a reorg',
  org_tune: 'tuned the company', org_set_cadence: 'changed a cadence', org_set_routing: 'changed routing', org_set_scope: 'changed a scope',
  org_allocate_budget: 'allocated budget', org_update_member: 'updated a member', org_write_playbook: 'wrote a playbook',
  org_propose_strategy: 'proposed a strategy', org_propose_experiment: 'proposed an experiment', org_propose_metric_source: 'proposed a metric source',
  org_strategy_memo: 'wrote a strategy memo', org_report_incident: 'reported an incident', org_ack_signal: 'acknowledged a signal',
  org_set_goal: 'updated a goal', org_set_key_result: 'updated a key result', org_check_in: 'checked in on a goal', org_report: 'sent a report',
};
/** Outward tools (mail, calendar, drive exports, HTTP, the browser acting). */
const OUTWARD = /^(gmail_|msmail_|gcal_(create|update)|mscal_(create|update)|drive_export|msdrive_export|http_request|browser_act|tool_|mcp_|computer_)/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const short = (id: string): string => id.slice(0, 8);
const base = (p: string): string => p.split('/').filter(Boolean).at(-1) ?? p;

/** Describe a run from its tool calls; a failed call counts for nothing. */
export function describeRun(calls: RunCall[]): RunSummary {
  const phrases: string[] = [];
  const add = (p: string) => { if (!phrases.includes(p)) phrases.push(p); };
  const files = new Map<string, 'wrote' | 'edited' | 'deleted'>();
  let taskId: string | null = null;
  const moved: string[] = [];
  let created = 0;
  for (const c of calls) {
    if (!c || c.isError) continue;
    const input = c.input ?? {};
    const tool = c.tool;
    if (FILE_WRITES.has(tool)) {
      const path = str(input.path) || str(input.file);
      if (!path || BOOKKEEPING.test(base(path))) continue;
      files.set(path, tool === 'fs_delete' ? 'deleted' : tool === 'fs_write' || tool === 'slides_create' ? (files.get(path) ?? 'wrote') : (files.get(path) === 'wrote' ? 'wrote' : 'edited'));
      continue;
    }
    switch (tool) {
      case 'org_task_update': case 'update_task': {
        const status = str(input.status);
        if (!status) break; // a note on its own task: bookkeeping
        const id = str(input.taskId) || str(input.id);
        if (tool === 'org_task_update' && id && !taskId) taskId = id;
        moved.push(`${id ? `task ${short(id)}` : 'a task'} to ${status.replace(/_/g, ' ')}`);
        break;
      }
      case 'org_create_task': case 'add_task': case 'channel_make_task': case 'delegate_task': created++; break;
      case 'org_assign': add('assigned a task'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'org_review': add('reviewed a task'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'org_request_review': add('asked for a review'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'org_accept_task': add('took a task'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'org_escalate': add('escalated'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'org_task_comment': add('commented on a task'); if (!taskId && str(input.taskId)) taskId = str(input.taskId); break;
      case 'channel_post': add(`posted in #${str(input.channel) || 'a channel'}`); break;
      case 'org_message': add('sent a message'); break;
      default:
        if (COMPANY_CHANGES[tool]) add(COMPANY_CHANGES[tool]);
        else if (OUTWARD.test(tool)) add(`ran ${tool}`);
    }
  }
  const out: string[] = [];
  if (moved.length) out.push(moved.length === 1 ? `moved ${moved[0]}` : `moved ${moved.length} tasks`);
  if (created) out.push(created === 1 ? 'created a task' : `created ${created} tasks`);
  out.push(...phrases);
  if (files.size === 1) { const [[p, verb]] = [...files]; out.push(`${verb} ${base(p)}`); }
  else if (files.size > 1) out.push(`changed ${files.size} files`);
  return { notable: out.length > 0, phrases: out, taskId };
}

/** `Loop "heartbeat" ran` → `heartbeat`. */
export function loopNameOf(title: string): string {
  return /^Loop "(.+)" ran$/.exec(title)?.[1] ?? 'loop';
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The title of a notable run: "Heartbeat: moved task 91ef6d61 to blocked, posted in #company". */
export function runTitle(loop: string, s: RunSummary): string {
  return `${cap(loop)}: ${s.phrases.join(', ')}`;
}

/** The summary line of an agent's routine runs: "Writer · 10 heartbeat checks, nothing new". */
export function routineTitle(agent: string, loops: string[], count: number): string {
  const what = loops.length === 1 && loops[0] === 'heartbeat' ? `heartbeat check${count === 1 ? '' : 's'}`
    : loops.length === 1 ? `"${loops[0]}" run${count === 1 ? '' : 's'}` : `loop run${count === 1 ? '' : 's'}`;
  return `${agent} · ${count} ${what}, nothing new`;
}

/** How many raw runs a summary row carries for expanding. */
export const ROUTINE_ITEMS = 30;

/**
 * Collapse routine runs: one row per agent per (UTC) day, at its latest run,
 * carrying the raw runs for the page to expand. A day with a single routine
 * run still collapses (its line says "1 heartbeat check, nothing new").
 */
export function collapseRoutine(runs: Array<{ agentId: string; agentName: string; loop: string; run: HomeRun }>): HomeActivity[] {
  const groups = new Map<string, { agentId: string; agentName: string; loops: string[]; items: HomeRun[] }>();
  for (const r of runs) {
    const key = `${r.agentId}:${r.run.at.slice(0, 10)}`;
    const g = groups.get(key) ?? { agentId: r.agentId, agentName: r.agentName, loops: [], items: [] };
    if (!g.loops.includes(r.loop)) g.loops.push(r.loop);
    g.items.push(r.run);
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const items = g.items.sort((a, b) => b.at.localeCompare(a.at));
    return {
      id: `routine:${key}`, at: items[0].at, kind: 'agent' as const, title: routineTitle(g.agentName, g.loops, items.length), detail: '',
      actor: g.agentName, ref: { type: 'agent', id: g.agentId },
      runs: { count: items.length, loops: g.loops, from: items.at(-1)!.at, items: items.slice(0, ROUTINE_ITEMS) },
    };
  });
}

/**
 * Coming up, one row per thing: the same title at the same time is one row
 * (a ritual every unit holds at 16:00 on Friday), listing the units that
 * hold it. Rows keep the first one's id, kind and reference.
 */
export function mergeUpcoming(rows: HomeUpcoming[]): HomeUpcoming[] {
  const out: HomeUpcoming[] = [];
  const byKey = new Map<string, HomeUpcoming>();
  for (const r of rows) {
    const key = `${r.title.toLowerCase()}|${r.at}`;
    const seen = byKey.get(key);
    if (!seen) { const copy = { ...r, units: r.units ? [...r.units] : undefined }; byKey.set(key, copy); out.push(copy); continue; }
    for (const u of r.units ?? []) {
      seen.units = seen.units ?? [];
      if (!seen.units.includes(u)) seen.units.push(u);
    }
    if (seen.units?.length && seen.kind === 'ritual') seen.detail = seen.units.join(', ');
  }
  return out;
}
