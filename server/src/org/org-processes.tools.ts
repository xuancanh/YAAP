/**
 * The process tools (docs/processes.md), offered to org members as a
 * ToolProviderHook beside the runtime's matrix, and the two things a
 * process does to a member's turn without a tool call: the step card in the
 * context of a run that works a process task, and the refusal of a tool the
 * step denies.
 *
 *  - `org_processes` / `org_process` / `org_process_run` / `org_process_metrics`
 *    (read, every member): the list with health, one process (graph, versions
 *    with diffs, runs), one run's steps, the metrics (a review by the owner);
 *  - `org_process_start` (every member): start a run by hand;
 *  - `org_process_next` / `org_step_choose` (the performer of a dynamic stage):
 *    what is available, choose a step or an ad-hoc one, finish the stage;
 *  - `org_step_output` / `org_process_deviate` (the step's owner): record an
 *    output; skip a SHOULD (logged) or ask to waive a MUST (a card);
 *  - `org_process_author` / `org_process_rollback` / `org_process_retire`
 *    (the chief: any; a head: its unit's; anyone else proposes): a new version
 *    with the reason, a rollback, a retirement — the boundary and
 *    `process.editApproval` decide whether it applies at once;
 *  - `org_process_cancel` (the owner, the chief): stop a run (its done
 *    steps' compensations then run);
 *  - `org_process_rollout` (the owner): promote or roll back a ramped
 *    version, or change its share of new runs.
 * `org_processes suggestions=true` lists the processes the engine suggests
 * from repeated work and the revisions it suggests; `org_process_metrics`
 * shows conformance apart from outcomes, and a ramp's comparison.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgTasksService } from './org-tasks.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { OrgProcessesService } from './org-processes.service';
import { PROCESS_TEMPLATES } from './process-templates';
import { backEdges, describeTriggers, nodesOf, type ProcessDef } from './process-model';
import { taskRef } from '../common/task-keys';
import { EVIDENCE_PROP } from './claims-model';

const PROC = 'The process name as org_processes lists it, e.g. release-checklist.';
const RUN = 'The run key, e.g. PR-4. Defaults to the run of the task you are working.';
const TASK = 'The task key (e.g. ENG-12). Defaults to the task you were woken for.';

const DEF_SCHEMA = {
  type: 'object',
  description: 'The definition: { title, description, category: operating | delivery, owner: head | chief, triggers: [{kind: manual} | {kind: cadence, cron} | {kind: event, event: incident_opened | project_now | task_created, severity?, class?}], stages: [{id, title, mode: strict | dynamic}], nodes: [{id, title, kind: task | approval | wait | subprocess | meeting, stage, why, lane: owner | chief | head | initiator | <title>, outcome, doneWhen, must[], should[], may[] (≤ 9 items), deny[] (tools), outputs: [{name, required}], required (dynamic checkpoint), availableWhen: {after[], vars[], equals{}}, approver: manager | ceo, question, waitHours, process (subprocess), meetingKind, attendees[] (lanes or unit), agenda (meeting), compensate (id of a compensation: true step that undoes it if the run fails), slaHours, maxAttempts, playbook}], edges: [{from, to, when: "var == value", loopMax}] }. Edges only in strict stages; every edge that closes a loop needs loopMax.',
};

const TOOLS: AiToolSpec[] = [
  { name: 'org_processes', description: 'The company\'s processes (read-only): each with its mode (strict | dynamic | mixed), owner, version, triggers, runs, completion rate, cycle time, deviation rate, conformance and health (healthy | watch | revise | new). library: true lists the built-in templates instead; suggestions: true the processes and revisions suggested from repeated work, with drafts.', inputSchema: { type: 'object', properties: { library: { type: 'boolean' }, suggestions: { type: 'boolean' }, org: { type: 'string' } } } },
  { name: 'org_process', description: 'One process (read-only): its stages and steps (strict edges or dynamic availability, MUST items, checkpoints), its versions with author, reason and diff, and its recent runs.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, org: { type: 'string' } }, required: ['process'] } },
  { name: 'org_process_run', description: 'One process run (read-only): every step with its state, task, outputs and deviations, the run\'s variables and its event log.', inputSchema: { type: 'object', properties: { run: { type: 'string', description: RUN }, org: { type: 'string' } } } },
  { name: 'org_process_metrics', description: 'A process\'s metrics over its recent runs: outcomes (runs, completion, cycle time, deviation and rework per step, SLA breaches, health) and, apart, conformance (open MUST items, waivers, SHOULD skips, ad-hoc and out-of-order steps), plus a ramped version\'s comparison. Reading it as the owner (or the chief) records the review.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, org: { type: 'string' } }, required: ['process'] } },
  { name: 'org_process_start', description: 'Start a run of a process by hand, pinned to its active version: its steps become tasks for their lanes (or, in a dynamic stage, a task for the performer to choose them). vars fill the brief templates (e.g. {release: "v2.3"}). Refused for a retired process or beyond the company\'s open-run limit.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, title: { type: 'string', description: 'What this run is for, e.g. "Release v2.3".' }, vars: { type: 'object', description: 'Inputs the steps\' briefs name as ${name}.' }, project: { type: 'string', description: 'The project it serves (P-3), when it serves one.' }, org: { type: 'string' } }, required: ['process'] } },
  { name: 'org_process_next', description: 'In a dynamic stage you perform: the steps available now (with their checkpoints), the ones under way and the checkpoints left. finish: true closes the stage — refused, with what is missing, while a checkpoint is undone or a step is still under way.', inputSchema: { type: 'object', properties: { run: { type: 'string', description: RUN }, finish: { type: 'boolean' }, org: { type: 'string' } } } },
  { name: 'org_step_choose', description: 'Choose the next step of a dynamic stage you perform: a step id from org_process_next (it becomes its own task — pass assignee for someone else\'s lane), or adHoc {title, outcome, doneWhen} for a step the process does not define (logged as a deviation; refused where the company runs only defined steps). The run moves to the process\'s newest version first when that is safe.', inputSchema: { type: 'object', properties: { run: { type: 'string', description: RUN }, step: { type: 'string', description: 'The step id.' }, adHoc: { type: 'object', properties: { title: { type: 'string' }, outcome: { type: 'string' }, doneWhen: { type: 'string' }, lane: { type: 'string' } } }, assignee: { type: 'string', description: 'Member name to perform it (default: its lane).' }, reason: { type: 'string', description: 'Why (required for an ad-hoc step).' }, org: { type: 'string' } } } },
  { name: 'org_step_output', description: 'Record an output of the process step you are working (e.g. rollback, decision, verdict): later steps see it on their card and the process\'s edges branch on it; a required output is checked when you hand the step to review.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'snake_case, as the step card names it.' }, value: { type: 'string' }, taskId: { type: 'string', description: TASK }, evidence: EVIDENCE_PROP, org: { type: 'string' } }, required: ['name', 'value'] } },
  { name: 'org_process_deviate', description: 'Deviate from the step card: level should (or may) skips an item — logged, the run goes on; level must asks the owner of the standard (your manager) to waive a MUST item — a decision card; you are woken when it is decided. item is the checklist id (s2), or step:<id> for a dynamic stage\'s checkpoint. A step everyone deviates from is flagged for revision.', inputSchema: { type: 'object', properties: { level: { type: 'string', enum: ['should', 'must', 'may'] }, item: { type: 'string' }, reason: { type: 'string', description: 'Why it does not fit this run.' }, alternative: { type: 'string', description: 'What you do instead.' }, taskId: { type: 'string', description: TASK }, org: { type: 'string' } }, required: ['level', 'item', 'reason'] } },
  { name: 'org_process_author', description: 'Create or change a process: a new immutable version with your reason (what the runs showed — deviations, failures, cycle time). Pass template to instantiate one from the library (org_processes library: true), or def for the full definition (to change one: read it with org_process, edit, pass it back with process). The chief changes any process; a head its unit\'s; anyone else\'s edit is a proposal. Whether your edit applies at once or waits for your manager\'s approval is the company\'s setting (process.editApproval); a version of a process with a track record may ramp on a share of new runs first. The result says which.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: `${PROC} Omit to create a new one.` }, name: { type: 'string', description: 'A new process\'s slug.' }, template: { type: 'string' }, unit: { type: 'string', description: 'A new process\'s owning department (name or #slug; default: yours as a head, the company as the chief).' }, def: DEF_SCHEMA, reason: { type: 'string' }, ramp: { type: 'number', description: '% of new runs on the new version while it is compared (0 = all at once; default: process.rampPercent).' }, org: { type: 'string' } }, required: ['reason'] } },
  { name: 'org_process_rollback', description: 'Roll a process back: a new version with an older version\'s definition (version history stays). Same approval rules as an edit.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, version: { type: 'number' }, reason: { type: 'string' }, org: { type: 'string' } }, required: ['process', 'version', 'reason'] } },
  { name: 'org_process_retire', description: 'Retire a process (no new runs; open runs finish on their version), or restore: true to bring a retired one back.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, reason: { type: 'string' }, restore: { type: 'boolean' }, org: { type: 'string' } }, required: ['process', 'reason'] } },
  { name: 'org_process_cancel', description: 'Cancel a process run and its open step tasks (the process owner or the chief); its done steps\' compensations then run.', inputSchema: { type: 'object', properties: { run: { type: 'string', description: RUN }, reason: { type: 'string' }, org: { type: 'string' } }, required: ['run', 'reason'] } },
  { name: 'org_process_rollout', description: 'Decide a ramped version (the process owner): promote (every new run), rollback (no more runs), or percent (its share of new runs). org_process_metrics shows the comparison.', inputSchema: { type: 'object', properties: { process: { type: 'string', description: PROC }, action: { type: 'string', enum: ['promote', 'rollback', 'percent'] }, percent: { type: 'number' }, reason: { type: 'string' }, org: { type: 'string' } }, required: ['process', 'action'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_processes', 'org_process', 'org_process_run', 'org_process_metrics', 'org_step_output', 'org_process_deviate']);

const MEMBER_GUIDE = 'Processes (docs/processes.md): the company\'s standing procedures — org_processes lists them. When a task is a process step, its step card (below the brief) says why the step exists, what earlier steps produced, the MUST / SHOULD / MAY items and the exit; MUST items are ticked on the task\'s checklist (org_task_steps) before org_request_review, outputs are recorded with org_step_output, and an item that does not fit is skipped or waived with org_process_deviate, never silently.';

@Injectable()
export class OrgProcessesTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly processes: OrgProcessesService,
    private readonly tasks: OrgTasksService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
    @Optional() private readonly units?: OrgUnitsService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => READ.has(t.name) && t.name.startsWith('org_process') && t.name !== 'org_process_deviate');
    if (ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? TOOLS : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }

  private readonly attention = new Map<string, { at: number; lines: string[] }>();

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ms = await this.memberships(session.agentId);
    if (!ms.length) return null;
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit || ctx?.aux) return null;
    if (ctx?.taskId) {
      const card = await this.processes.stepCardFor(ctx.orgId, ctx.taskId).catch(() => null);
      if (card) return card;
    }
    const lines = [MEMBER_GUIDE];
    for (const m of ms) {
      const org = await this.org.get(m.orgId).catch(() => null);
      if (!org) continue;
      const isChief = org.chiefOfStaffAgentId === session.agentId;
      const isHead = !isChief && Boolean(this.units && await this.units.ledBy(org.id, session.agentId).catch(() => null));
      if (!isChief && !isHead) continue;
      const key = `${org.id}:${session.agentId}`;
      let hit = this.attention.get(key);
      if (!hit || Date.now() - hit.at > 5 * 60_000) { hit = { at: Date.now(), lines: await this.processes.attentionFor(org.id, session.agentId).catch(() => []) }; this.attention.set(key, hit); }
      if (hit.lines.length) lines.push(`Your processes needing attention: ${hit.lines.join('; ')}. Improve a process from what its runs show (org_process_metrics, then org_process_author with the reason).`);
    }
    return lines.join('\n');
  }

  /** A step's denied tools are refused, not executed; the turn goes on. */
  async refuseCall(session: ChatSession, call: AiToolCall): Promise<string | null> {
    const ctx = this.runtime?.runningCtx(session.id);
    if (!ctx?.taskId) return null;
    const { deny, label } = await this.processes.deniedTools(ctx.orgId, ctx.taskId);
    if (!deny.includes(call.name)) return null;
    return `Refused: ${call.name} is not used in ${label} (a MUST rule of the step). Do the step without it; if it cannot be done without it, say so on the task and escalate it (org_escalate) so the process owner decides — the rule changes only with the process.`;
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const ms = await this.memberships(agentId);
    if (ms.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of ms) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (ms.length > 1) throw new Error(`you belong to ${ms.length} organizations — pass org: <name>`);
    return this.org.get(ms[0].orgId);
  }

  private async memberRef(orgId: string, v: unknown): Promise<string> {
    const q = String(v ?? '').trim().toLowerCase();
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const m = (await this.org.members(orgId)).find((x) => x.status === 'active' && (x.agentId === q || (q.length >= 6 && x.agentId.startsWith(q)) || (names.get(x.agentId) ?? '').toLowerCase() === q));
    if (!m) throw new Error(`no active member "${String(v ?? '')}"`);
    return m.agentId;
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const actor = `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const ctx = this.runtime?.runningCtx(session.id);
    const progressed = () => { if (ctx) ctx.progress = true; };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    const taskOf = async () => {
      const ref = str('taskId');
      if (ref) return (await this.tasks.resolve(org.id, ref)).id;
      if (ctx?.taskId) return ctx.taskId;
      throw new Error('name the task (taskId): you were not woken for one');
    };
    const runOf = async () => {
      if (str('run')) return str('run');
      if (ctx?.taskId) { const s = await this.processes.stepOfTask(org.id, ctx.taskId); if (s) return s.runId; }
      throw new Error('name the run (its key, e.g. PR-4): the task you are working is not a process step');
    };
    switch (name) {
      case 'org_processes': {
        if (input.library) return ['The built-in library (instantiate with org_process_author template=<id> and your reason):', ...PROCESS_TEMPLATES.map((t) => `- ${t.id}: ${t.summary} [${t.def.category}; ${describeTriggers(t.def.triggers)}]`)].join('\n');
        if (input.suggestions) {
          const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
          const open = await this.processes.suggestions(org.id, { status: 'open' });
          if (!open.length) return 'No open suggestions: no work repeats without a process, and no step is deviated from enough to revise.';
          const lines = ['Suggested from repeated work (each is its owner\'s task: refine and org_process_author, or cancel the task with why):'];
          for (const sg of open) {
            const t = sg.taskId ? await this.tasks.get(org.id, sg.taskId).catch(() => null) : null;
            lines.push(`- ${sg.title} [${sg.kind}, seen ${sg.count}×; owner ${sg.ownerAgentId ? names.get(sg.ownerAgentId) ?? 'member' : 'the chief'}${t ? `; ${taskRef(t)}` : ''}] — ${sg.summary}${sg.draft ? `\n  draft: ${sg.draft}` : ''}`);
          }
          return lines.join('\n');
        }
        const rows = await this.processes.overview(org.id);
        if (!rows.length) return 'No processes yet. org_processes library: true lists the templates.';
        return rows.map((p) => {
          const m = p.metrics;
          return `- ${p.name} "${p.title}" v${p.version} — ${p.mode}, ${p.category}, ${p.status}; owner ${p.ownerName} (${p.unitName}); ${describeTriggers(p.triggers)}; runs ${m.runs} (${m.active} open)${m.completionRate !== null ? `, ${Math.round(m.completionRate * 100)}% completed` : ''}${m.cycleHoursP50 !== null ? `, cycle ${m.cycleHoursP50.toFixed(1)}h` : ''}${m.deviationRate !== null ? `, deviation ${Math.round(m.deviationRate * 100)}%` : ''}; health ${m.health}${m.health !== 'healthy' && m.health !== 'new' ? ` (${m.why})` : ''}${p.conformance.rate !== null ? `; conformance ${Math.round(p.conformance.rate * 100)}%` : ''}${p.reviewDue ? '; review due' : ''}${p.pendingVersion ? `; v${p.pendingVersion} pending approval` : ''}${p.rollout ? `; v${p.rollout.candidateVersion} ramping on ${p.rollout.percent}% (${p.rollout.verdict})` : ''}`;
        }).join('\n');
      }
      case 'org_process': {
        const d = await wrap(() => this.processes.detail(org.id, str('process'))) as { process: { name: string; title: string; version: number; status: string; ownerName: string; unitName: string }; def: ProcessDef | null; versions: Array<{ version: number; status: string; author: string; reason: string; diff: string[]; createdAt: string }>; runs: Array<{ key: string; title: string; status: string; version: number; stage: string; startedAt: string }> };
        const p = d.process;
        return [
          `${p.name} "${p.title}" v${p.version} (${p.status}) — owner ${p.ownerName} (${p.unitName}).`,
          d.def ? describeDef(d.def) : 'No active version.',
          `Versions:\n${d.versions.slice(0, 8).map((v) => `- v${v.version} ${v.status} by ${v.author} (${v.createdAt.slice(0, 10)}): ${v.reason}${v.diff.length ? ` — ${v.diff.slice(0, 6).join('; ')}` : ''}`).join('\n')}`,
          `Recent runs:\n${d.runs.slice(0, 10).map((r) => `- ${r.key} "${r.title}" ${r.status} (v${r.version}, stage ${r.stage}, ${r.startedAt.slice(0, 16)})`).join('\n') || '(none yet)'}`,
          d.def ? `To change it: org_process_author {process: "${p.name}", def: <the full definition, edited>, reason}.` : '',
        ].filter(Boolean).join('\n');
      }
      case 'org_process_run': {
        const run = await wrap(async () => this.processes.run(org.id, await runOf()));
        const d = await this.processes.detail(org.id, run.processId) as { runs: Array<{ id: string; steps: Array<{ nodeId: string; title: string; attempt: number; status: string; current: number; taskKey: string | null; outputs: Record<string, string>; deviations: unknown[]; outcome: string }>; vars: Record<string, string> }> };
        const r = d.runs.find((x) => x.id === run.id);
        const events = await this.processes.events(org.id, { runId: run.id, limit: 20 });
        return [
          `${run.key} "${run.title}" — ${run.status}, v${run.version}, stage ${run.stage}${run.note ? ` (${run.note})` : ''}.`,
          `Variables: ${Object.entries(r?.vars ?? {}).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ') || 'none'}`,
          `Steps:\n${(r?.steps ?? []).map((s) => `- ${s.nodeId}${s.attempt > 1 ? ` #${s.attempt}` : ''} "${s.title}" ${s.status}${s.current ? '' : ' (sent back)'}${s.taskKey ? ` ${s.taskKey}` : ''}${s.outcome && s.outcome !== s.status ? ` → ${s.outcome}` : ''}${Object.keys(s.outputs).length ? ` · outputs ${Object.keys(s.outputs).join(', ')}` : ''}${s.deviations.length ? ` · ${s.deviations.length} deviation(s)` : ''}`).join('\n')}`,
          `Events:\n${events.slice(0, 12).map((e) => `- ${e.at.slice(11, 16)} ${e.activity}${e.nodeId ? ` ${e.nodeId}` : ''} by ${e.actor}`).join('\n')}`,
        ].join('\n');
      }
      case 'org_process_metrics': {
        const p = await wrap(() => this.processes.get(org.id, str('process')));
        const owner = (await this.processes.overview(org.id)).find((x) => x.id === p.id)?.ownerAgentId;
        const m = await this.processes.metrics(org.id, p.id, { markReviewed: owner === agentId || org.chiefOfStaffAgentId === agentId ? actor : undefined });
        const c = await this.processes.conformance(org.id, p.id);
        const r = await this.processes.rollout(org.id, p.id);
        const pc = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
        return [
          `${p.title}: ${m.runs} run(s) (${m.active} open, ${m.done} done, ${m.failed} failed, ${m.cancelled} cancelled); health ${m.health} — ${m.why}.`,
          `Outcomes: completion ${pc(m.completionRate)}; cycle time (median) ${m.cycleHoursP50 === null ? '—' : `${m.cycleHoursP50.toFixed(1)}h`}; deviation ${pc(m.deviationRate)}; rework ${pc(m.reworkRate)}; SLA breaches ${m.slaBreaches}.`,
          `Per step:\n${m.steps.map((s) => `- ${s.nodeId}: ${s.executions} run(s), deviation ${Math.round(s.deviationRate * 100)}%, rework ${s.rework}, failures ${s.failures}${s.hoursP50 !== null ? `, ${s.hoursP50.toFixed(1)}h median` : ''}`).join('\n') || '(no steps executed yet)'}`,
          `Conformance (did runs follow the definition): ${c.verdict} — ${c.why}; ${pc(c.rate)} of ${c.checked} step(s), ${c.conformantRuns}/${c.runs} run(s) fully; open MUST ${c.mustOpen}, waivers ${c.waivers}${c.waiversPending ? ` (+${c.waiversPending} pending)` : ''}, SHOULD skips ${c.shouldSkips}, ad-hoc ${c.adHoc}, out of order ${c.outOfOrder}.`,
          r ? `Ramp: v${r.candidateVersion} on ${r.percent}% of new runs vs v${r.stableVersion} — ${r.verdict}: ${r.why}. ${r.rows.map((x) => `${x.metric} ${x.metric === 'cycle' ? `${x.stable?.toFixed(1) ?? '—'}h → ${x.candidate?.toFixed(1) ?? '—'}h` : `${pc(x.stable)} → ${pc(x.candidate)}`}${x.worse ? ' (worse)' : ''}`).join('; ')}.${r.auto ? ' The engine applies the verdict.' : ' org_process_rollout decides it.'}` : '',
          m.health === 'revise' ? 'A standard nobody follows is the standard\'s problem: change the step (org_process_author with the reason), or split it.' : '',
        ].filter(Boolean).join('\n');
      }
      case 'org_process_start': {
        const projectId = str('project') ? (await this.org.projects(org.id)).find((p) => p.key?.toLowerCase() === str('project').toLowerCase() || p.id === str('project'))?.id ?? null : null;
        const run = await wrap(() => this.processes.start(org.id, str('process'), { title: str('title') || undefined, vars: (input.vars && typeof input.vars === 'object' ? input.vars : {}) as Record<string, unknown>, projectId, initiator: actor, trigger: { kind: 'manual' } }));
        await this.processes.settle();
        progressed();
        const steps = (await this.processes.steps(org.id, run.id)).filter((s) => s.status === 'active');
        const keys: string[] = [];
        for (const s of steps) if (s.taskId) { const t = await this.tasks.get(org.id, s.taskId).catch(() => null); if (t) keys.push(`${taskRef(t)} (${s.nodeId})`); }
        return `Started ${run.key} "${run.title}" (v${run.version}). ${keys.length ? `Steps under way: ${keys.join(', ')}.` : run.status === 'done' ? 'It completed at once.' : 'Waiting on its first step.'}`;
      }
      case 'org_process_next': {
        const ref = await wrap(runOf);
        if (input.finish) {
          const run = await wrap(() => this.processes.finishStage(org.id, ref, actor));
          progressed();
          return `Stage finished. ${run.key} is ${run.status}${run.status === 'running' ? `, now in stage ${run.stage}` : ''}.`;
        }
        const info = await wrap(() => this.processes.nextFor(org.id, ref));
        return [
          `${info.run.key} stage "${info.stage.title}" (${info.stage.mode}).`,
          info.stage.mode === 'strict' ? 'A strict stage: the engine materialises its steps; nothing to choose.' : '',
          info.available.length ? `Available:\n${info.available.map((n) => `- ${n.id}: ${n.title}${n.required ? ' (checkpoint)' : ''}${n.lane ? ` — lane ${n.lane}` : ''}`).join('\n')}` : 'Nothing available now.',
          info.active.length ? `Under way: ${info.active.map((a) => `${a.nodeId}${a.taskKey ? ` ${a.taskKey}` : ''}`).join(', ')}` : '',
          info.missing.length ? `Checkpoints left: ${info.missing.map((n) => n.id).join(', ')}` : info.stage.mode === 'dynamic' ? 'All checkpoints done: org_process_next finish=true closes the stage.' : '',
        ].filter(Boolean).join('\n');
      }
      case 'org_step_choose': {
        const ref = await wrap(runOf);
        const adHoc = input.adHoc && typeof input.adHoc === 'object' ? input.adHoc as { title: string; outcome?: string; doneWhen?: string; lane?: string } : undefined;
        const assignee = str('assignee') ? await this.memberRef(org.id, str('assignee')) : undefined;
        const r = await wrap(() => this.processes.choose(org.id, ref, { node: str('step') || undefined, adHoc, assignee, reason: str('reason') || undefined }, actor));
        progressed();
        return `${r.adopted ? `The run moved to v${r.adopted}. ` : ''}Chose ${r.step.nodeId}${r.task ? `: ${taskRef(r.task)} "${r.task.title}"` : ''}${adHoc ? ' (ad-hoc, logged as a deviation)' : ''}.`;
      }
      case 'org_step_output': {
        const taskId = await wrap(taskOf);
        // Evidence-gated claims (docs/evidence.md): later steps build on an output.
        const claim = await this.tasks.evidence?.check(org.id, { cls: 'step_output', actor, tool: 'org_step_output', text: String(input.value ?? ''), value: str('name'), evidence: input.evidence, context: { taskId } }) ?? null;
        const r = await wrap(() => this.processes.setOutput(org.id, taskId, str('name'), String(input.value ?? ''), actor));
        await claim?.commit('step_output', `${r.step.id}:${str('name').trim()}`);
        progressed();
        return `Recorded ${str('name')}${r.declared ? '' : ' (the step does not declare it; later steps still see it)'}.${claim ? ` ${claim.note}` : ''}`;
      }
      case 'org_process_deviate': {
        const taskId = await wrap(taskOf);
        const lvl = str('level') === 'must' ? 'must' : str('level') === 'may' ? 'may' : 'should';
        const r = await wrap(() => this.processes.deviate(org.id, taskId, { level: lvl, item: str('item'), reason: str('reason'), alternative: str('alternative') }, actor));
        progressed();
        return r.note;
      }
      case 'org_process_author': {
        let unitId: string | null | undefined;
        if (str('unit') && this.units) {
          const q = str('unit').replace(/^#/, '').toLowerCase();
          const u = (await this.units.units(org.id)).find((x) => x.id === str('unit') || x.name.toLowerCase() === q || x.slug === q);
          if (!u) throw new Error(`refused: no department "${str('unit')}"`);
          unitId = u.parentUnitId ? u.id : null;
        }
        const ramp = typeof input.ramp === 'number' && Number.isFinite(input.ramp) ? input.ramp : undefined;
        const r = await wrap(() => this.processes.author(org.id, { process: str('process') || undefined, name: str('name') || undefined, template: str('template') || undefined, def: input.def, unitId, reason: str('reason'), ramp }, actor));
        progressed();
        return r.note;
      }
      case 'org_process_rollback': {
        const r = await wrap(() => this.processes.rollback(org.id, str('process'), Number(input.version), str('reason'), actor));
        progressed();
        return r.note;
      }
      case 'org_process_retire': {
        if (input.restore) { const p = await wrap(() => this.processes.restore(org.id, str('process'), str('reason'), actor)); progressed(); return `${p.title} is ${p.status}.`; }
        const r = await wrap(() => this.processes.retire(org.id, str('process'), str('reason'), actor));
        progressed();
        return r.note;
      }
      case 'org_process_cancel': {
        const run0 = await wrap(() => this.processes.run(org.id, str('run')));
        const owner = (await this.processes.overview(org.id, { includeRetired: true })).find((x) => x.id === run0.processId)?.ownerAgentId;
        if (agentId !== org.chiefOfStaffAgentId && agentId !== owner && agentId !== run0.ownerAgentId) throw new Error('refused: the process owner or the chief cancels a run');
        const run = await wrap(() => this.processes.cancel(org.id, run0.id, str('reason') || 'cancelled', actor));
        progressed();
        return `${run.key} is ${run.status}.${run.compensation === 'running' ? ' Its done steps are being undone (compensation tasks, latest first).' : ''}`;
      }
      case 'org_process_rollout': {
        const action = str('action');
        const reason = str('reason') || 'the comparison';
        const p = action === 'promote' ? await wrap(() => this.processes.promote(org.id, str('process'), reason, actor))
          : action === 'rollback' ? await wrap(() => this.processes.rollbackRamp(org.id, str('process'), reason, actor))
            : action === 'percent' ? await wrap(() => this.processes.setRamp(org.id, str('process'), Number(input.percent), actor))
              : null;
        if (!p) throw new Error('refused: action is promote, rollback or percent');
        progressed();
        return p.candidateVersionId ? `${p.title}: v${p.version} stable, the ramped version takes ${p.rampPct}% of new runs.` : `${p.title}: v${p.version} takes every new run.`;
      }
    }
    throw new Error(`unknown tool ${name}`);
  }
}

/** The definition as text for the model: stages, steps, edges or availability. */
export function describeDef(def: ProcessDef): string {
  const lines = [`${def.category}; ${describeTriggers(def.triggers)}${def.description ? ` — ${def.description}` : ''}`];
  for (const st of def.stages) {
    lines.push(`Stage ${st.id} "${st.title}" (${st.mode}):`);
    const back = st.mode === 'strict' ? backEdges(def, st.id) : [];
    for (const n of nodesOf(def, st.id)) {
      const extra = [
        n.kind !== 'task' ? `${n.kind}${n.kind === 'meeting' ? ` ${n.meetingKind ?? 'adhoc'} with ${(n.attendees ?? ['unit']).join('/')}` : ''}` : '', n.lane ? `lane ${n.lane}` : '', n.required ? 'checkpoint' : '', n.compensate ? `undone by ${n.compensate}` : '',
        n.must?.length ? `MUST ${n.must.length}` : '', n.should?.length ? `SHOULD ${n.should.length}` : '', n.deny?.length ? `deny ${n.deny.join('/')}` : '',
        n.slaHours ? `SLA ${n.slaHours}h` : '', n.availableWhen?.after?.length ? `after ${n.availableWhen.after.join('+')}` : '',
      ].filter(Boolean).join(', ');
      lines.push(`  - ${n.id} "${n.title}"${extra ? ` [${extra}]` : ''}`);
    }
    for (const e of def.edges.filter((x) => nodesOf(def, st.id).some((n) => n.id === x.from))) lines.push(`  ${e.from} → ${e.to}${e.when ? ` when ${e.when}` : ''}${back.some((b) => b.from === e.from && b.to === e.to) ? ` (loop ≤ ${e.loopMax ?? '?'})` : ''}`);
  }
  const comps = def.nodes.filter((n) => n.compensation);
  if (comps.length) lines.push(`If a run fails or is cancelled (latest done step first): ${comps.map((n) => `${n.id} "${n.title}" undoes ${def.nodes.filter((x) => x.compensate === n.id).map((x) => x.id).join('/')}`).join('; ')}`);
  return lines.join('\n');
}
