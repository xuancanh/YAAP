/** Oversight's pure parts: an audit row read as a sentence ("The chief of
 *  staff hired Writer on its own: the queue was 3 days deep"), the category
 *  an action belongs to, and the audit filter. Web-tests pin these. */
import type { OrgAuditRow } from './api';

export type AuditCategory = 'goals' | 'work' | 'people' | 'money' | 'decisions' | 'system';
export const AUDIT_CATEGORY_LABEL: Record<AuditCategory, string> = { goals: 'Goals and vision', work: 'Tasks and projects', people: 'People and structure', money: 'Money', decisions: 'Decisions and reviews', system: 'Runs and system' };

const VERB: Record<string, string> = {
  goal_create: 'created a goal', goal_update: 'changed a goal', vision_set: 'set the vision', profile_set: 'revised the operating profile', strategy_memo: 'wrote the strategy memo', goal_at_risk_wake: 'flagged a goal at risk', checkin: 'checked in on a key result',
  task_create: 'created a task', task_update: 'changed a task', task_assign: 'assigned a task', task_assign_human: 'assigned a task to a person', task_claim: 'claimed a task', task_comment: 'commented on a task', task_steps: 'updated a task’s steps', task_unblocked: 'unblocked a task', task_escalate: 'escalated a task', task_check: 'ran a task’s checks', task_circular: 'found a circular wait',
  project_create: 'created a project', project_update: 'changed a project', project_done: 'finished a project', project_kill: 'killed a project', project_member_add: 'added a project member',
  unit_create: 'created a department', unit_rename: 'renamed a department', unit_archive: 'archived a department', unit_restore: 'restored a department', unit_reroot: 'moved a department', unit_task_key: 'set a department’s task key',
  pause_member: 'paused a member', pause_org: 'paused the company', org_mode: 'changed the company mode', charter_drift: 'noticed a charter change',
  spend_reserve: 'reserved spend for a run', spend_commit: 'settled a run’s spend', routing_set: 'changed model routing', resource_request: 'requested a resource', resource_decide: 'decided a resource request', resource_escalate: 'escalated a resource request', resource_withdraw: 'withdrew a resource request',
  approve: 'approved a card', decided: 'decided a card', decision_log: 'logged a decision', decision_hop: 'routed a decision', review: 'reviewed work', review_request: 'asked for a review', review_accept: 'accepted a review', review_request_changes: 'asked for changes', sent_back: 'sent work back', spotcheck: 'spot-checked work', spotcheck_cards: 'spot-checked cards',
  run_start: 'started a run', run_end: 'finished a run', rewake_scheduled: 'scheduled a re-wake', tune: 'tuned a threshold', tunable_set: 'set a tunable', signal_open: 'opened a signal', signal_ack: 'acknowledged a signal', signal_resolve: 'resolved a signal', meeting_skipped: 'skipped a meeting', note: 'left a note', supervised: 'acted under supervision', wip_override: 'overrode the WIP limit', freeze_class: 'froze a task class', slo_targets: 'set the SLO targets', next_work_ask: 'asked for next work', chief_review_start: 'started a structure review', reconcile_task: 'reconciled a task', program_pm_prompt: 'prompted a Program Manager',
};

export function auditCategory(action: string): AuditCategory {
  const a = action.replace(/^auto_/, '');
  if (/^(goal|vision|profile|strategy|checkin|kr_)/.test(a)) return 'goals';
  if (/^(task|project|milestone)/.test(a)) return 'work';
  if (/^(unit|member|pause_member|hire|fire|terminate|charter|org_mode|role|human)/.test(a) || /hire|reorg/.test(a)) return 'people';
  if (/^(spend|budget|routing|resource|allocation|capital|envelope)/.test(a)) return 'money';
  if (/^(approve|decided|decision|review|sent_back|spotcheck|veto|plan)/.test(a)) return 'decisions';
  return 'system';
}

/** Who did it, in words. */
export function actorWords(actor: string, agentName: (id: string) => string | undefined, humanName: (id: string) => string = (id) => id.slice(0, 8)): string {
  if (actor === 'user' || actor === 'ceo') return 'You';
  if (actor === 'chief') return 'The chief of staff';
  if (actor === 'system' || !actor) return 'The company';
  const ag = /^agent:(.+)$/.exec(actor);
  if (ag) return agentName(ag[1]) ?? `Agent ${ag[1].slice(0, 8)}`;
  const hu = /^human:(.+)$/.exec(actor);
  if (hu) return humanName(hu[1]);
  return agentName(actor) ?? actor;
}

function payloadOf(raw: string): Record<string, unknown> {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v as Record<string, unknown> : {}; } catch { return {}; }
}

/** An audit row as one sentence and its detail ("why" when the row carries one). */
/** Bookkeeping rows (a run started or ended, spend reserved or settled): hidden by default. */
export const ROUTINE_ACTIONS = new Set(['run_start', 'run_end', 'spend_reserve', 'spend_commit', 'rewake_scheduled']);

export function auditSentence(r: Pick<OrgAuditRow, 'actor' | 'action' | 'refType' | 'refId' | 'payload'>, agentName: (id: string) => string | undefined, humanName?: (id: string) => string, refName?: (refType: string, refId: string) => string | undefined): { text: string; detail: string; auto: boolean } {
  const auto = r.action.startsWith('auto_');
  const base = r.action.replace(/^auto_/, '');
  const p = payloadOf(r.payload);
  const verb = VERB[base] ?? `${base.replace(/_/g, ' ')}${r.refType ? ` (${r.refType.replace(/_/g, ' ')})` : ''}`;
  const name = ([p.title, p.name, p.key, p.projectKey].find((x) => typeof x === 'string' && x) as string | undefined) ?? (r.refId ? refName?.(r.refType, r.refId) : undefined);
  const what = name ? ` “${String(name).slice(0, 90)}”` : '';
  const text = `${actorWords(r.actor, agentName, humanName)} ${verb}${what}${auto ? ' on its own' : ''}`;
  const why = [p.decision, p.reason, p.rationale, p.why, p.note, p.summary].find((x) => typeof x === 'string' && x) as string | undefined;
  return { text, detail: why ? String(why).slice(0, 240) : '', auto };
}

export interface AuditFilter { q: string; category: AuditCategory | 'all'; actor: string; autoOnly: boolean; routine?: boolean }

export function filterAudit(rows: OrgAuditRow[], f: AuditFilter, agentName: (id: string) => string | undefined): OrgAuditRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.category !== 'all' && auditCategory(r.action) !== f.category) return false;
    if (f.actor !== 'all' && r.actor !== f.actor) return false;
    if (f.autoOnly && !r.action.startsWith('auto_')) return false;
    if (!f.routine && ROUTINE_ACTIONS.has(r.action.replace(/^auto_/, ''))) return false;
    if (q) { const s = auditSentence(r, agentName); if (!`${s.text} ${s.detail} ${r.action} ${r.refId}`.toLowerCase().includes(q)) return false; }
    return true;
  });
}

const NOUNS = new Set(['task', 'goal', 'project', 'member', 'budget', 'review', 'unit', 'meeting', 'plan', 'signal', 'approval', 'decision', 'incident', 'routing', 'resource']);
const PAST: Record<string, string> = { create: 'created', assign: 'assigned', escalate: 'escalated', accept: 'accepted', add: 'added', set: 'set', update: 'updated', claim: 'claimed', comment: 'commented on', request: 'requested', reject: 'rejected', close: 'closed', open: 'opened', resolve: 'resolved', ack: 'acknowledged', start: 'started', end: 'ended', rename: 'renamed', archive: 'archived', pause: 'paused', resume: 'resumed', approve: 'approved', decide: 'decided', withdraw: 'withdrew', kill: 'killed', done: 'finished' };

/** A replay line in words: actor ids become names, "task create task X (agent:…)" becomes "Task created: X, by Writer". */
export function replayTitle(title: string, agentName: (id: string) => string | undefined): string {
  let t = (title ?? '').replace(/\(agent:([0-9a-f-]{8,36})\)/gi, (_, id: string) => `, by ${agentName(id) ?? agentName(id.slice(0, 8)) ?? 'an agent'}`)
    .replace(/\(user\)/g, ', by you').replace(/\(chief\)/g, ', by the chief of staff')
    .replace(/\bagent ([0-9a-f]{8})[0-9a-f-]*/gi, (_, id: string) => agentName(id) ?? `agent ${id}`);
  const m = /^([a-z]+) ([a-z_]+) (.*)$/.exec(t);
  if (m && NOUNS.has(m[1]) && PAST[m[2]]) {
    const rest = m[3].startsWith(`${m[1]} `) ? m[3].slice(m[1].length + 1) : m[3];
    t = `${m[1][0].toUpperCase()}${m[1].slice(1)} ${PAST[m[2]]}: ${rest}`;
  }
  return t.replace(/ ,/g, ',');
}
