/**
 * Foundry for the chief of staff and the heads (docs/foundry.md §4.7,
 * docs/plugins.md §3.8), offered as a ToolProviderHook beside the runtime's
 * matrix so it works the same in every session kind:
 *
 *  - `org_foundry_search` (read): kits and plugins — what each brings,
 *    what is installed;
 *  - `org_foundry_detail` (read): one kit's or plugin's detail: operations
 *    with the class yaam treats them as, skills, guidance, UI it adds,
 *    seats, policies;
 *  - `org_foundry_installed` (read): what the company is built from, with
 *    health (suspended interfaces, partial kits) and updates waiting;
 *  - `org_foundry_propose`: propose installing, upgrading or removing a
 *    kit or plugin. It never installs: it writes a `kit_change` /
 *    `plugin_change` card (CEO-reserved) carrying the plan the owner would
 *    see. Only when the owner set the workspace's trust policy to
 *    `first_party`, in an autonomous company, does the chief's install or
 *    upgrade of a first-party item apply at once (audited, the owner told);
 *    a removal is always a card.
 *
 * It also binds the rest of the kit and contribution machinery to the
 * company: the guidance block every agent's turn carries (bounded,
 * attributed, logged with provenance first), who an audienced skill
 * reaches, the kits' seats (hired through the org's own hire path), the
 * appliers of the two card kinds, and the briefing's "Installed" line.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { contextProvenance } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { canonicalJson, sha256 } from '../actions/action-classes';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { AgentsService } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { PluginsService } from '../plugins/plugins.service';
import { audienceReaches, renderGuidance, type GuidanceNote, type Viewer } from '../plugins/contributions';
import { compareVersions } from '../plugins/semver';
import type { GuidanceDef } from '../plugins/manifest';
import { KitsService, type KitChoices } from '../foundry/kits.service';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgApprovalsService } from './org-approvals.service';
import { OrgBriefingService } from './org-briefing.service';
import { headFunction } from './heads';
import { roleById } from './roles/catalog';

const CARD = {
  recommend: { type: 'string', enum: ['approve', 'deny', 'modify'], description: 'What you recommend the CEO does with the card.' },
  alternatives: { type: 'array', items: { type: 'string' }, description: 'The alternatives you considered, one line each (e.g. "do nothing: …", "a plugin instead of the whole kit: …").' },
  confidence: { type: 'number', description: 'Your confidence (0–1) that this is the right call.' },
};
const TOOLS: AiToolSpec[] = [
  { name: 'org_foundry_search', description: 'Search Foundry for what the company could add (read-only): kits (a use case — interfaces, providers, seats, playbooks, guidance) and plugins (interfaces, providers, consumers — the operations, skills, guidance and dashboard cards they bring), each marked installed or available. Use it when a goal needs a capability the company lacks (no CRM for a sales goal, no helpdesk for a support goal).', inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Words to match: a capability (crm, invoices, incidents), a function (sales, finance) or a name.' }, shelf: { type: 'string', enum: ['all', 'kits', 'plugins'] }, fn: { type: 'string', description: 'Only kits of this business function (engineering, cs, sales, marketing, finance, people, legal).' }, org: { type: 'string' } } } },
  { name: 'org_foundry_detail', description: 'One kit or plugin in detail (read-only): for a plugin, every operation with the class yaam treats it as (read, internal_write, external_reversible, external_irreversible, money) and which are two-key, its skills, guidance notes and UI elements; for a kit, its interfaces and recommended providers, seats, playbooks, guidance, requested policies, rhythm and measures, and its install here.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'kit or plugin id, e.g. revenue@yaam or crm@yaam.' }, org: { type: 'string' } }, required: ['id'] } },
  { name: 'org_foundry_installed', description: 'What the company is built from (read-only): installed kits (status, partial reasons, health per interface, updates waiting) and plugins (active, suspended and why, pending updates).', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
  { name: 'org_foundry_propose', description: 'Propose installing, upgrading or removing a kit or plugin. It writes a decision card for the CEO with the full plan (new plugins and the classes of their operations, the provider per interface, seats, policies, playbooks, guidance); nothing installs until the CEO approves. Pick providers per interface (or "later"), and seats to fill, for a kit. why is required: the goal or gap it serves.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['kit', 'plugin'] }, id: { type: 'string' }, action: { type: 'string', enum: ['install', 'upgrade', 'remove'] }, providers: { type: 'object', description: 'Kit installs: { <interface>: <provider plugin id> | "later" }; default is the first available recommendation.', additionalProperties: { type: 'string' } }, seats: { type: 'object', description: 'Kit installs: { <seat key>: true | false } for recommended and optional seats.', additionalProperties: { type: 'boolean' } }, why: { type: 'string' }, ...CARD, org: { type: 'string' } }, required: ['kind', 'id', 'action', 'why', 'recommend', 'alternatives'] } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_foundry_search', 'org_foundry_detail', 'org_foundry_installed']);

@Injectable()
export class OrgFoundryTools implements ToolProviderHook {
  private readonly logger = new Logger(OrgFoundryTools.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly org: OrgService,
    private readonly runtime: OrgRuntimeService,
    private readonly approvals: OrgApprovalsService,
    private readonly plugins: PluginsService,
    private readonly kits: KitsService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
    @Optional() skills?: SkillsService,
    @Optional() briefing?: OrgBriefingService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
    skills?.setAudienceFilter(async (ws, agentId, aud) => audienceReaches(aud, await this.viewer(ws, agentId)));
    briefing?.setCapabilities((ws) => this.capabilitiesLine(ws));
    approvals.onApply('kit_change', (orgId, payload, a) => this.applyKit(orgId, payload, `approval:${a.id}`));
    approvals.onApply('plugin_change', (orgId, payload, a) => this.applyPlugin(orgId, payload, `approval:${a.id}`));
    kits.people = {
      chief: async (ws) => { const o = await this.org.byWorkspace(ws); return o && o.status === 'active' ? o.chiefOfStaffAgentId : null; },
      existing: async (ws, role) => {
        const o = await this.org.byWorkspace(ws);
        const title = roleById(role)?.title.toLowerCase();
        if (!o || !title) return null;
        const m = (await this.org.members(o.id)).find((x) => x.status === 'active' && x.title.toLowerCase() === title);
        if (!m) return null;
        const a = await this.agents.get(m.agentId).catch(() => null);
        return { agentId: m.agentId, name: a?.name ?? m.agentId.slice(0, 8) };
      },
      hire: async (ws, seat, by) => {
        const o = await this.org.byWorkspace(ws);
        if (!o) throw new Error('no company');
        const payload = await this.approvals.prepareHire(o.id, { templateOrPack: `role:${seat.role}`, title: seat.title, reportsToAgentId: seat.reportsToAgentId ?? undefined, requestedBy: by });
        const r = await this.approvals.applyHire(o.id, payload, 'user', by);
        return { agentId: r.agentId, name: r.name };
      },
    };
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  // ---- who is asking ----

  /** The viewer an audience is matched against: chief, head, member, functions (its own and its manager's). */
  async viewer(workspaceId: string, agentId?: string): Promise<Viewer> {
    const none: Viewer = { member: false, chief: false, head: false, functions: [] };
    if (!agentId) return none;
    const o = await this.org.byWorkspace(workspaceId).catch(() => null);
    if (!o || o.status === 'archived') return none;
    const me = await this.org.member(o.id, agentId).catch(() => null);
    const chief = o.chiefOfStaffAgentId === agentId;
    if (!me && !chief) return none;
    const head = !chief && Boolean(await this.runtime.headOf(o.id, agentId).catch(() => null));
    const mgr = me?.reportsToAgentId ? await this.org.member(o.id, me.reportsToAgentId).catch(() => null) : null;
    const fns = [headFunction(me?.title), headFunction(mgr?.title)].filter((x): x is string => Boolean(x));
    return { member: true, chief, head, functions: [...new Set(fns)] };
  }

  // ---- ToolProviderHook ----

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime.runningCtx(session.id);
    if (ctx?.audit || ctx?.aux) return [];
    const v = await this.viewer(session.workspaceId, session.agentId);
    if (v.chief || v.head) return [...TOOLS];
    return [];
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name) || name === 'org_foundry_propose'; }

  /** The guidance block: notes from installed plugins and kits that reach this agent, attributed, bounded, logged first. */
  async contextFor(session: ChatSession): Promise<string | null> {
    if (!session.agentId) return null;
    const run = this.runtime.runningCtx(session.id);
    if (run?.audit) return null;
    const rows = await this.plugins.contributionRows(session.workspaceId, ['guidance']).catch(() => []);
    if (rows.length === 0) return null;
    const v = await this.viewer(session.workspaceId, session.agentId);
    const notes: GuidanceNote[] = [];
    for (const r of rows) {
      const g = JSON.parse(r.spec) as GuidanceDef;
      if (!audienceReaches(g.audience, v)) continue;
      notes.push({ ownerKind: r.ownerKind === 'kit' ? 'kit' : 'plugin', ownerId: r.ownerId, version: r.version, id: g.id, title: g.title, text: g.text, audience: g.audience });
    }
    const out = renderGuidance(notes);
    if (!out.included.length) return null;
    // Model-visible means logged: a note whose provenance cannot be written is withheld.
    const logged: GuidanceNote[] = [];
    for (const n of out.included) {
      const text = canonicalJson({ id: n.id, title: n.title, text: n.text });
      try {
        await this.db.insert(contextProvenance).values({
          accountId: currentAccountId(), id: newId(), workspaceId: session.workspaceId, sessionId: session.id, turnId: null, sourceKind: 'guidance',
          pluginId: n.ownerId, pluginVersion: n.version, contributionId: `${n.ownerId}#${n.id}`, contentHash: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), untrusted: 0, createdAt: nowIso(),
        }).onConflictDoNothing();
        logged.push(n);
      } catch (err) { this.logger.warn(`guidance provenance for ${n.ownerId}#${n.id}: ${err instanceof Error ? err.message : err}`); }
    }
    return logged.length === out.included.length ? out.text : renderGuidance(logged).text || null;
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    const ws = org.workspaceId;
    const v = await this.viewer(ws, agentId);
    if (!v.chief && !v.head) throw new Error(`${name} is for the chief of staff and the function heads`);
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    switch (name) {
      case 'org_foundry_search': return this.search(ws, str('q'), str('shelf') || 'all', str('fn'));
      case 'org_foundry_detail': return this.detail(ws, str('id'));
      case 'org_foundry_installed': return this.installed(ws);
      case 'org_foundry_propose': return this.propose(org, agentId, v.chief, input);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  // ---- the reads ----

  private async search(ws: string, q: string, shelf: string, fn: string): Promise<string> {
    const needle = q.toLowerCase();
    const lines: string[] = [];
    if (shelf !== 'plugins') {
      for (const k of await this.kits.shelf(ws, { q: q || undefined, fn: fn || undefined })) {
        const inst = k.installed as { version: string; status: string } | null;
        lines.push(`- [kit] ${String(k.name)} (${String(k.id)}${k.version ? ` ${String(k.version)}` : ''}) — ${String(k.summary ?? k.blurb ?? '').slice(0, 140)} Interfaces: ${(k.interfaces as Array<{ name: string; optional?: boolean }>).map((i) => `${i.name}${i.optional ? '?' : ''}`).join(', ')}. Seats: ${(k.seats as string[]).join(', ') || 'none'}. ${inst ? `INSTALLED (${inst.status}, ${inst.version})` : k.installable ? 'available' : 'coming soon (not installable yet)'}`);
      }
    }
    if (shelf !== 'kits') {
      for (const p of await this.plugins.catalogView(ws)) {
        const hay = `${String(p.id)} ${String(p.name)} ${String(p.description)}`.toLowerCase();
        if (needle && !needle.split(/\s+/).some((w) => hay.includes(w))) continue;
        lines.push(`- [plugin] ${String(p.name)} (${String(p.id)} ${String(p.version)}; ${(p.roles as string[]).join('+')}) — ${String(p.description).slice(0, 140)} ${p.installed ? `INSTALLED (${String(p.installedVersion ?? '')})` : 'available'}`);
      }
    }
    if (!lines.length) return `Nothing in Foundry matches "${q}". Try a broader word (a function like sales, or a capability like invoices).`;
    return [`Foundry${q ? ` — "${q}"` : ''} (${lines.length}):`, ...lines.slice(0, 30), lines.length > 30 ? `… ${lines.length - 30} more; narrow with q.` : '', 'Read one with org_foundry_detail; propose with org_foundry_propose (a card for the CEO).'].filter(Boolean).join('\n');
  }

  private async detail(ws: string, id: string): Promise<string> {
    if (!id) throw new Error('id is required');
    const kitIds = new Set((await this.kits.catalog()).keys());
    const full = id.includes('@') ? id : `${id}@yaam`;
    if (kitIds.has(full)) {
      const d = await this.kits.detail(ws, full);
      const inst = d.install as { version: string; status: string; statusReason: string } | null;
      const recs = (d.recommends as { providers?: Record<string, Array<{ id: string; why: string }>> }).providers ?? {};
      return [
        `Kit ${String(d.name)} (${full} ${String(d.version)}) — ${String(d.summary)}`,
        `Interfaces: ${(d.interfaces as Array<{ name: string; optional?: boolean }>).map((i) => `${i.name}${i.optional ? ' (optional)' : ''}${recs[i.name]?.length ? ` via ${recs[i.name].map((r) => r.id).join(' | ')}` : ''}`).join('; ')}`,
        `Seats: ${(d.roles as Array<{ key: string; title: string; role: string; hire: string }>).map((r) => `${r.title} [${r.key}, role:${r.role}, ${r.hire}]`).join('; ') || 'none'}`,
        `Playbooks: ${(d.playbookList as Array<{ name: string; description: string }>).map((p) => `${p.name} — ${p.description}`).join('; ') || 'none'}`,
        `Guidance: ${(d.guidanceNotes as GuidanceDef[]).map((g) => `${g.title} (for ${g.audience.join(', ')})`).join('; ') || 'none'}`,
        `Policies (raise only): ${(d.policyList as Array<{ match: { operation?: string; changeKind?: string }; require: string; why: string }>).map((p) => `${p.match.operation ?? p.match.changeKind} → ${p.require}`).join('; ') || 'none'}`,
        `Rhythm: ${(d.cadences as string[]).join('; ') || '—'}. Measures: ${(d.metrics as string[]).join('; ') || '—'}`,
        inst ? `Installed here: ${inst.version}, ${inst.status}${inst.statusReason ? ` — ${inst.statusReason}` : ''}` : 'Not installed here.',
      ].join('\n');
    }
    const r = await this.plugins.review(ws, { firstParty: full }).catch(async () => this.plugins.review(ws, { registry: { id: full } }));
    const ifaces = r.interfaces as Array<{ name: string; operations: Array<{ canonical: string; effectiveClass: string; twoKeyByFloor: boolean }> }>;
    const c = r.contributions as { skills: Array<{ name: string; description: string; audience: string[] }>; guidance: GuidanceDef[]; ui: Record<string, Array<{ id: string; title?: string; placement?: string; operation?: string | null }>> };
    const installed = await this.plugins.summary(ws, full);
    const ui = Object.entries(c.ui).flatMap(([k, xs]) => xs.map((x) => `${k.replace(/s$/, '')} "${x.title ?? x.id}"${x.placement ? ` on ${x.placement}` : ''}${x.operation ? ` (${x.operation})` : ''}`));
    return [
      `Plugin ${String(r.name)} (${full} ${String(r.version)}; ${(r.roles as string[]).join('+')}; tier ${String(r.tier)}) — ${String(r.description)}`,
      ...ifaces.map((i) => `Interface ${i.name}: ${i.operations.map((o) => `${o.canonical}=${o.effectiveClass}${o.twoKeyByFloor ? ' (two-key)' : ''}`).join(', ')}`),
      (r.provides as Array<{ interface: string }>).length ? `Provides: ${(r.provides as Array<{ interface: string }>).map((p) => p.interface).join(', ')}` : '',
      `Requires: ${((r.requires as { interfaces?: string[] }).interfaces ?? []).join(', ') || 'nothing'}`,
      `Skills: ${c.skills.map((s) => `${s.name} — ${s.description} (for ${s.audience.join(', ')})`).join('; ') || 'none'}`,
      `Guidance: ${c.guidance.map((g) => `${g.title}: ${g.text}`).join(' | ') || 'none'}`,
      `UI: ${ui.join('; ') || 'none'}`,
      (r.blockers as string[]).length ? `Blockers here: ${(r.blockers as string[]).join('; ')}` : '',
      installed ? `Installed here: ${String(installed.version)}, ${String(installed.status)}${installed.suspendedReason ? ` — ${String(installed.suspendedReason)}` : ''}` : 'Not installed here.',
    ].filter(Boolean).join('\n');
  }

  private async installed(ws: string): Promise<string> {
    const kits = await this.kits.list(ws);
    const plugins = await this.plugins.list(ws);
    const cat = await this.plugins.catalog();
    const lines = [
      `Kits (${kits.length}):`,
      ...(kits.length ? kits.map((k) => `- ${String(k.name)} ${String(k.version)}: ${String(k.status)}${k.statusReason ? ` — ${String(k.statusReason)}` : ''}; ${(k.health as Array<{ interface: string; boundTo: string | null; healthy: boolean }>).map((h) => `${h.interface} ${h.healthy ? `→ ${h.boundTo}` : 'UNBOUND or unhealthy'}`).join(', ')}${k.update ? `; update ${String((k.update as { version: string }).version)} available` : ''}`) : ['- none']),
      `Plugins (${plugins.length}):`,
      ...(plugins.length ? plugins.map((p) => {
        const latest = cat.get(String(p.id))?.manifest.version;
        return `- ${String(p.id)} ${String(p.version)}: ${String(p.status)}${p.suspendedReason ? ` — ${String(p.suspendedReason)}` : ''}${p.pendingUpdate ? '; an update waits on the owner' : latest && compareVersions(latest, String(p.version)) > 0 ? `; ${latest} available` : ''}`;
      }) : ['- none']),
    ];
    return lines.join('\n');
  }

  // ---- proposals ----

  private async propose(org: Organization, agentId: string, isChief: boolean, input: Record<string, unknown>): Promise<string> {
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const kind = str('kind');
    const action = str('action');
    const why = str('why');
    if (kind !== 'kit' && kind !== 'plugin') throw new Error('kind is kit or plugin');
    if (!['install', 'upgrade', 'remove'].includes(action)) throw new Error('action is install, upgrade or remove');
    if (!why) throw new Error('why is required: the goal or gap this serves');
    const id = str('id').includes('@') ? str('id') : `${str('id')}@yaam`;
    const ws = org.workspaceId;
    const choices: KitChoices = {
      providers: input.providers && typeof input.providers === 'object' ? Object.fromEntries(Object.entries(input.providers as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined,
      seats: input.seats && typeof input.seats === 'object' ? Object.fromEntries(Object.entries(input.seats as Record<string, unknown>).filter(([, x]) => typeof x === 'boolean')) as Record<string, boolean> : undefined,
    };
    const payload: Record<string, unknown> = { kind, action, id, why, requestedBy: `agent:${agentId}` };
    let summary = '';
    let firstParty = id.endsWith('@yaam');
    if (kind === 'kit') {
      const d = await this.kits.detail(ws, id).catch(() => { throw new Error(`no kit ${id}; org_foundry_search lists them`); });
      payload.name = d.name;
      payload.version = d.version;
      const inst = d.install as { version: string; update: { version: string } | null } | null;
      if (action === 'install') {
        if (inst) throw new Error(`${id} is already installed (${inst.version})`);
        const plan = await this.kits.plan(ws, id, choices);
        if ((plan.blockers as string[]).length) return `Not proposed — the plan is blocked: ${(plan.blockers as string[]).join('; ')}`;
        payload.choices = choices;
        payload.plan = {
          providers: Object.fromEntries((plan.interfaces as Array<{ name: string; choice: string }>).map((i) => [i.name, i.choice])),
          newPlugins: (plan.plugins as Array<{ id: string; state: string }>).filter((p) => p.state === 'new').map((p) => p.id),
          seats: (plan.seats as Array<{ title: string; on: boolean; filledBy: { name: string } | null }>).filter((s) => s.on).map((s) => `${s.title}${s.filledBy ? ` (uses ${s.filledBy.name})` : ''}`),
          policies: (plan.policies as Array<{ require: string; match: { operation?: string; changeKind?: string } }>).map((p) => `${p.match.operation ?? p.match.changeKind} → ${p.require}`),
          playbooks: (plan.playbooks as Array<{ name: string }>).map((p) => p.name),
          outcome: plan.outcome,
        };
        summary = `new plugins ${(payload.plan as { newPlugins: string[] }).newPlugins.join(', ') || 'none'}; seats ${(payload.plan as { seats: string[] }).seats.join(', ') || 'none'}`;
      } else if (action === 'upgrade') {
        if (!inst) throw new Error(`${id} is not installed`);
        if (!inst.update) return `${id} is at the latest version (${inst.version}); nothing to propose.`;
        payload.from = inst.version;
        payload.version = inst.update.version;
      } else {
        if (!inst) throw new Error(`${id} is not installed`);
        payload.plan = await this.kits.uninstallPlan(ws, id);
      }
    } else {
      const cat = await this.plugins.catalog();
      const pkg = cat.get(id);
      const li = await this.plugins.installOf(ws, id);
      const live = li && li.install.status !== 'removed';
      payload.name = pkg?.manifest.name ?? id;
      payload.version = pkg?.manifest.version ?? '';
      firstParty = Boolean(pkg);
      if (action === 'install') {
        if (live) throw new Error(`${id} is already installed (${li!.manifest.version})`);
        const r = await this.plugins.review(ws, pkg ? { firstParty: id } : { registry: { id } }).catch((err: unknown) => { throw new Error(`no plugin ${id}: ${err instanceof Error ? err.message : String(err)}`); });
        if ((r.blockers as string[]).length) return `Not proposed — the install is blocked: ${(r.blockers as string[]).join('; ')}`;
        payload.version = r.version;
        payload.tier = r.tier;
        payload.classes = (r.interfaces as Array<{ operations: Array<{ canonical: string; effectiveClass: string }> }>).flatMap((i) => i.operations.map((o) => `${o.canonical}=${o.effectiveClass}`)).slice(0, 40);
        payload.bindUnbound = true;
        summary = `${String(r.name)} ${String(r.version)} (${String(r.tier)})`;
      } else if (action === 'upgrade') {
        if (!live) throw new Error(`${id} is not installed`);
        if (!pkg || compareVersions(pkg.manifest.version, li!.manifest.version) <= 0) return `${id} is at the latest version (${li!.manifest.version}); nothing to propose.`;
        payload.from = li!.manifest.version;
      } else if (!live) throw new Error(`${id} is not installed`);
    }
    // The workspace's trust policy (docs/foundry.md §4.7): first-party installs and upgrades by the chief may apply at once in an autonomous company.
    const settings = await this.plugins.workspaceSettings(ws);
    if (settings.agentInstalls === 'first_party' && isChief && action !== 'remove' && firstParty && await this.runtime.isAutonomous(org)) {
      const res = kind === 'kit' ? await this.applyKit(org.id, payload, `agent:${agentId} (trust policy: first_party)`) : await this.applyPlugin(org.id, payload, `agent:${agentId} (trust policy: first_party)`);
      await this.agents.addEvent(agentId, { kind: 'info', title: `Applied by the trust policy: ${action} ${kind} ${String(payload.name)}`.slice(0, 200), body: why.slice(0, 1_000), payload: JSON.stringify({ orgId: org.id, ...payload }), origin: 'user' }).catch(() => undefined);
      return `Applied at once under the workspace's trust policy (first-party ${action}s by the chief): ${action} ${kind} ${String(payload.name)} — ${JSON.stringify(res).slice(0, 400)}. The owner sees it in the plugin audit.`;
    }
    const a = await this.approvals.create(org.id, {
      kind: kind === 'kit' ? 'kit_change' : 'plugin_change', payload, requestedBy: isChief ? 'chief' : agentId,
      recommendation: `${action} ${kind} ${String(payload.name)}: ${why}`.slice(0, 600),
      card: { recommendedAction: str('recommend') || undefined, alternatives: input.alternatives, confidence: input.confidence },
    });
    return `Proposed: ${action} the ${kind} ${String(payload.name)}${summary ? ` (${summary})` : ''}. Card ${a.id.slice(0, 8)} waits on the CEO; nothing is installed until it is approved.`;
  }

  /** The `kit_change` card's applier, on the owner's approval. */
  async applyKit(orgId: string, payload: Record<string, unknown>, by: string): Promise<Record<string, unknown>> {
    const o = await this.org.get(orgId);
    const id = String(payload.id ?? '');
    if (payload.action === 'install') {
      const r = await this.kits.install(o.workspaceId, id, (payload.choices ?? {}) as KitChoices, { confirm: true, by });
      return { kit: id, status: (r.install as { status?: string } | undefined)?.status ?? r.status ?? 'installed' };
    }
    if (payload.action === 'upgrade') return this.kits.upgrade(o.workspaceId, id, { by });
    return this.kits.uninstall(o.workspaceId, id, { by });
  }

  /** The `plugin_change` card's applier: install (binding an unbound interface it provides), update or uninstall. */
  async applyPlugin(orgId: string, payload: Record<string, unknown>, by: string): Promise<Record<string, unknown>> {
    const o = await this.org.get(orgId);
    const ws = o.workspaceId;
    const id = String(payload.id ?? '');
    const first = Boolean((await this.plugins.catalog()).get(id));
    const source = first ? { firstParty: id } : { registry: { id } };
    if (payload.action === 'install') {
      const r = await this.plugins.install(ws, source, { confirm: true });
      const bound: string[] = [];
      const li = await this.plugins.installOf(ws, id);
      if (payload.bindUnbound && li) {
        const reg = await this.plugins.registry(ws);
        for (const p of li.manifest.provides ?? []) {
          const iface = p.interface.split('@')[0];
          if (reg.bindings.some((b) => b.interface === iface && b.scopeKind === 'workspace')) continue;
          await this.plugins.setBinding(ws, iface, { scopeKind: 'workspace', providerId: id }).then(() => bound.push(iface)).catch(() => undefined);
        }
      }
      return { plugin: id, installed: r.installed === true, bound, by };
    }
    if (payload.action === 'upgrade') return this.plugins.update(ws, id, source);
    return this.plugins.uninstall(ws, id);
  }

  /** The briefing's "Installed" line: kits, then plugins by short name. */
  private async capabilitiesLine(ws: string): Promise<string> {
    const kits = await this.kits.summaryLine(ws).catch(() => '');
    const plugins = (await this.plugins.list(ws).catch(() => [])).filter((p) => p.status !== 'disabled' && p.status !== 'frozen');
    if (!kits && !plugins.length) return '';
    const names = plugins.map((p) => `${String(p.id).split('@')[0]}${p.status === 'suspended' ? ' (suspended)' : ''}`);
    return [kits ? `kits ${kits}` : '', names.length ? `plugins ${names.slice(0, 8).join(', ')}${names.length > 8 ? ` +${names.length - 8}` : ''}` : ''].filter(Boolean).join('; ');
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const memberships = (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
    if (memberships.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of memberships) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (memberships.length > 1) throw new Error(`you belong to ${memberships.length} organizations — pass org: <name>`);
    return this.org.get(memberships[0].orgId);
  }
}
