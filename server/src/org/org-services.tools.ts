/**
 * The service tools (docs/services.md), offered to org members as a
 * ToolProviderHook beside the runtime's matrix, and the lines a service
 * puts in a member's context when something waits on it (a request to
 * answer or route, a counter-proposal, a breach, an ask that keeps coming
 * without a service) — nothing when nothing does.
 *
 *  - `org_services` (read, every member): the catalog by department with
 *    fields, SLAs and metrics; library=true the starter templates;
 *    request=SR-n one request with its thread; mine=true your requests;
 *  - `org_request_service` (every member): request a service — or name only
 *    the department for an unlisted need, or neither for the chief to route;
 *  - `org_service_respond`: the provider accepts / declines / negotiates;
 *    the requester agrees / counters / withdraws; the chief routes;
 *  - `org_service_author` (the chief: any; a head: its unit's; anyone else
 *    proposes): create, adopt a template, change, retire or restore.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgUnitsService } from './org-units.service';
import { OrgServicesService, type OrgServiceRequest, type ThreadEntry } from './org-services.service';
import { metricsLine, type ServiceField } from './service-model';

const SVC = 'The service name as org_services lists it, e.g. bug-fix.';
const REQ = 'The request key, e.g. SR-4.';
const FIELDS_SCHEMA = { type: 'array', description: '[{name (snake_case), label, type: text | number | date | url | choice | boolean, required, options[] (choice), description}] — what the requester must give to start; at most 12.', items: { type: 'object' } };

const TOOLS: AiToolSpec[] = [
  { name: 'org_services', description: 'The service catalog (read-only): what each department offers other functions, the fields a request needs, who answers, the accept and resolve SLAs and the metrics. unit filters by department; library: true lists the starter templates; request: SR-n shows one request and its thread; mine: true your own requests.', inputSchema: { type: 'object', properties: { unit: { type: 'string' }, library: { type: 'boolean' }, request: { type: 'string', description: REQ }, mine: { type: 'boolean' }, org: { type: 'string' } } } },
  { name: 'org_request_service', description: 'Ask another department for work. Name the service (org_services) and give its fields: it is routed to the providing department with no triage and its accept SLA starts. A need no service covers: name only the department (unit); neither: the chief routes it. Refused, with what is missing, when a required field is absent or malformed.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: SVC }, unit: { type: 'string', description: 'The providing department, for a need no service covers.' }, title: { type: 'string', description: 'What you need, in one line.' }, fields: { type: 'object', description: 'The service\'s fields by name.' }, why: { type: 'string', description: 'What it unblocks or which key result it moves.' }, neededBy: { type: 'string', description: 'yyyy-mm-dd' }, serves: { type: 'string', description: 'The project (P-3) or goal it serves.' }, org: { type: 'string' } }, required: ['title', 'why'] } },
  { name: 'org_service_respond', description: 'Answer a service request. Provider: accept (due: the date you commit to), decline (reason, alternative), negotiate (due and/or scope you can do instead). Requester, on a counter: agree, negotiate, withdraw (withdraw also any time before delivery). Chief, on a request naming no service: route (unit or service). Every answer is kept on the request.', inputSchema: { type: 'object', properties: { request: { type: 'string', description: REQ }, answer: { type: 'string', enum: ['accept', 'decline', 'negotiate', 'agree', 'withdraw', 'route'] }, due: { type: 'string', description: 'yyyy-mm-dd' }, reason: { type: 'string' }, alternative: { type: 'string' }, scope: { type: 'string' }, note: { type: 'string' }, unit: { type: 'string' }, service: { type: 'string' }, org: { type: 'string' } }, required: ['request', 'answer'] } },
  { name: 'org_service_author', description: 'Create or change a service of your department\'s catalog, with the reason (what the requests showed: repeats, breaches, declines). template adopts one from the library; service plus the fields to change edits it (a new version); retire / restore. SLAs default to the company\'s; process links one whose first step is "accept" (default: the standard intake). The chief changes any department\'s, a head its own; anyone else\'s change is a proposal, and service.editApproval decides which changes wait for your manager.', inputSchema: { type: 'object', properties: { service: { type: 'string', description: `${SVC} Omit to create one.` }, template: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, fields: FIELDS_SCHEMA, ownerRole: { type: 'string', description: 'Who answers: head, or a title in the department.' }, process: { type: 'string' }, acceptSlaHours: { type: 'number' }, resolveSlaHours: { type: 'number' }, unit: { type: 'string', description: 'The providing department (default: yours as a head).' }, retire: { type: 'boolean' }, restore: { type: 'boolean' }, reason: { type: 'string' }, org: { type: 'string' } }, required: ['reason'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_services']);

const fieldWords = (fs: ServiceField[]) => fs.map((f) => `${f.name}${f.required ? '*' : ''}${f.type === 'choice' ? ` (${(f.options ?? []).join('|')})` : f.type !== 'text' ? ` (${f.type})` : ''}`).join(', ') || 'none';

@Injectable()
export class OrgServicesTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly services: OrgServicesService,
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
    if (ctx?.audit) return TOOLS.filter((t) => READ.has(t.name));
    if (ctx?.aux) return [];
    return (await this.memberships(session.agentId)).length ? TOOLS : [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }

  private readonly attention = new Map<string, { at: number; lines: string[] }>();

  /** Only what waits on this member; nothing otherwise (the prompt does not grow for an idle catalog). */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit || ctx?.aux) return null;
    const lines: string[] = [];
    for (const m of await this.memberships(session.agentId)) {
      const key = `${m.orgId}:${session.agentId}`;
      let hit = this.attention.get(key);
      if (!hit || Date.now() - hit.at > 60_000) { hit = { at: Date.now(), lines: await this.services.attentionFor(m.orgId, session.agentId).catch(() => []) }; this.attention.set(key, hit); }
      lines.push(...hit.lines);
    }
    return lines.length ? `Service requests waiting on you (org_services request=SR-n; answer with org_service_respond): ${lines.join('; ')}.` : null;
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

  private async describeRequest(orgId: string, r: OrgServiceRequest): Promise<string> {
    const svc = r.serviceId ? await this.services.get(orgId, r.serviceId).catch(() => null) : null;
    const unit = r.providerUnitId && this.units ? await this.units.get(orgId, r.providerUnitId).catch(() => null) : null;
    const thread = JSON.parse(r.thread || '[]') as ThreadEntry[];
    const fields = JSON.parse(r.fields || '{}') as Record<string, string>;
    const counter = r.counter ? JSON.parse(r.counter) as { due?: string; scope?: string; note?: string } : null;
    return [
      `${r.key} "${r.title}" — ${r.status}; ${svc ? `${svc.title} v${r.serviceVersion ?? svc.version}` : 'unlisted'} → ${unit?.name ?? (r.status === 'triage' ? 'the chief to route' : 'the company')}; requested by ${await this.nameOf(r.requester)} ${r.createdAt.slice(0, 16)}.`,
      `Why: ${r.why}${r.neededBy ? ` Needed by ${r.neededBy.slice(0, 10)}.` : ''}${r.servesLabel ? ` Serves ${r.servesKind} ${r.servesLabel}.` : ''}`,
      `Fields: ${Object.entries(fields).map(([k, v]) => `${k}=${v.slice(0, 80)}`).join(', ') || 'none'}`,
      `SLA: answer by ${r.acceptDueAt?.slice(0, 16) ?? '—'}${r.acceptBreachedAt ? ' (breached)' : ''}; deliver by ${(r.committedDue ?? r.resolveDueAt)?.slice(0, 16) ?? '—'}${r.resolveBreachedAt ? ' (breached)' : ''}${r.breaches ? `; ${r.breaches} breach(es)` : ''}.`,
      counter ? `Counter-proposal: ${[counter.due ? `by ${counter.due.slice(0, 10)}` : '', counter.scope ?? '', counter.note ?? ''].filter(Boolean).join('; ')}` : '',
      r.declineReason ? `Declined: ${r.declineReason}` : '',
      `Thread:\n${thread.slice(-10).map((e) => `- ${e.at.slice(0, 16)} ${e.action} by ${e.by}${e.due ? ` due ${e.due.slice(0, 10)}` : ''}${e.reason ? ` — ${e.reason}` : ''}${e.scope ? ` scope: ${e.scope}` : ''}${e.note ? ` (${e.note})` : ''}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }

  private async nameOf(actor: string): Promise<string> {
    if (!actor.startsWith('agent:')) return actor === 'user' ? 'the CEO' : actor.startsWith('human:') ? 'a person' : actor;
    return (await this.agents.get(actor.slice(6)).catch(() => null))?.name ?? 'a member';
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const actor = `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const ctx = this.runtime?.runningCtx(session.id);
    const progressed = () => { if (ctx) ctx.progress = true; this.attention.clear(); };
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    const unitId = async (): Promise<string | null | undefined> => {
      if (!str('unit') || !this.units) return undefined;
      const q = str('unit').replace(/^#/, '').toLowerCase();
      const u = (await this.units.units(org.id)).find((x) => x.id === str('unit') || x.name.toLowerCase() === q || x.slug === q);
      if (!u) throw new Error(`refused: no department "${str('unit')}"`);
      return u.parentUnitId ? u.id : null;
    };
    switch (name) {
      case 'org_services': {
        if (str('request')) return this.describeRequest(org.id, await wrap(() => this.services.request(org.id, str('request'))));
        if (input.library) {
          const lib = await this.services.library(org.id);
          return ['Starter services (adopt with org_service_author template=<id> and your reason; SLAs start from the company\'s):', ...lib.map((t) => `- ${t.id}: ${t.title} — ${t.summary} [${t.unitName ? `fits ${t.unitName}` : 'no matching department'}${t.adopted ? '; adopted' : ''}] fields: ${fieldWords(t.fields)}`)].join('\n');
        }
        if (input.mine) {
          const rows = (await this.services.requests(org.id, { limit: 100 })).filter((r) => r.requesterAgentId === agentId).slice(0, 20);
          return rows.length ? rows.map((r) => `- ${r.key} "${r.title}" ${r.status}${r.committedDue ? ` due ${r.committedDue.slice(0, 10)}` : ''}`).join('\n') : 'You have made no service requests.';
        }
        const u = await unitId();
        const rows = (await this.services.overview(org.id)).filter((s) => s.status === 'active' && (u === undefined || s.unitId === u));
        if (!rows.length) return `No services${u !== undefined ? ' in that department' : ''} yet. For a need, org_request_service with unit (the department) and no service; heads adopt starters with org_services library: true.`;
        const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
        return rows.map((s) => `- ${s.name} "${s.title}" (${s.unitName}; answered by ${s.ownerAgentId ? names.get(s.ownerAgentId) ?? 'the head' : 'the chief'}): accept ${s.acceptSlaHours}h, resolve ${s.resolveSlaHours}h; fields: ${fieldWords(s.fieldList)}; ${metricsLine(s.metrics)}${s.description ? ` — ${s.description.slice(0, 120)}` : ''}`).join('\n');
      }
      case 'org_request_service': {
        const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields) ? input.fields as Record<string, unknown> : {};
        const r = await wrap(() => this.services.requestService(org.id, { service: str('service') || undefined, unit: str('unit') || undefined, title: str('title'), fields, why: str('why'), neededBy: str('neededBy') || null, serves: str('serves') || null }, actor));
        progressed();
        return r.note;
      }
      case 'org_service_respond': {
        const r = await wrap(() => this.services.respond(org.id, str('request'), { answer: str('answer'), due: str('due') || undefined, reason: str('reason') || undefined, alternative: str('alternative') || undefined, scope: str('scope') || undefined, note: str('note') || undefined, unit: str('unit') || undefined, service: str('service') || undefined }, actor));
        await this.services.settle();
        progressed();
        return r.note;
      }
      case 'org_service_author': {
        if (input.retire || input.restore) {
          const r = await wrap(() => this.services.retire(org.id, str('service'), str('reason'), actor, { restore: Boolean(input.restore) }));
          progressed();
          return r.note;
        }
        const num = (k: string) => (typeof input[k] === 'number' ? input[k] as number : typeof input[k] === 'string' && str(k) ? Number(str(k)) : undefined);
        const r = await wrap(async () => this.services.author(org.id, {
          service: str('service') || undefined, template: str('template') || undefined, name: str('name') || undefined, title: str('title') || undefined,
          description: typeof input.description === 'string' ? input.description : undefined, fields: input.fields, ownerRole: str('ownerRole') || undefined,
          process: 'process' in input ? (str('process') || null) : undefined, acceptSlaHours: num('acceptSlaHours'), resolveSlaHours: num('resolveSlaHours'), unitId: await unitId(), reason: str('reason'),
        }, actor));
        progressed();
        return r.note;
      }
    }
    throw new Error(`unknown tool ${name}`);
  }
}
