/**
 * The dispatcher, `InterfaceToolProvider` (docs/plugins.md §4.3): offers
 * one tool per interface operation an agent may use (`<iface>_<op>`; the
 * canonical id `iface.op` everywhere else), runs the fixed policy stage
 * for each call, and executes admitted calls through the bound provider.
 *
 * The policy stage, in order (the turn loop runs the rest of the chain):
 *   resolve the binding (unbound → refused, candidates named) → the agent's
 *   grant → the change gate (apply and rollback name an approved record and
 *   hit its pinned bind) → classify (interface ⊔ provider ⊔ generic floors
 *   ⊔ classByInput) → owner and requested policies (raise only; an owner
 *   `deny` refuses) → budget and metering (per-call cap, rate, concurrency,
 *   the monthly envelope; the cost is reserved on the call's row).
 *
 * Deny by default: `execute` runs only calls the turn loop admitted after
 * that chain, re-checks the binding and the gate, validates input and
 * output against the interface, and logs every piece of plugin text it
 * hands a model (tool definitions, results) with provenance first — text it
 * cannot log is not returned. Interface tools never run freely and never
 * take the MCP read-only-hint path.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { actionLog, contextProvenance } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { ActionsService, type ActionRow, type PluginCallFields } from '../actions/actions.service';
import { canonicalJson, sha256, type ActionClass } from '../actions/action-classes';
import type { AiToolCall, AiToolSpec } from '../ai/ai-provider.interface';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type PolicyPreflight, type PolicyStageHook, type ToolExecCtx, type ToolProviderHook, type TurnOrigin } from '../chats/turn-loop.service';
import { resourceFields, type JsonSchema, type SchemaRefs } from './json-schema';
import type { OperationDef, Requirement } from './manifest';
import { classByInputOf, kindRequirement, maxClass, maxRequirement, mayRemember, staticClassOf } from './policy';
import { callProvider, ProviderError, refsOf } from './runtime';
import { PluginsService, toolName, type RegistryIface, type RegistryProvider, type WorkspaceRegistry } from './plugins.service';
import { ChangesService, MANUAL_KIND, type ChangeRow, type VerifyCheck } from './changes.service';
import { PluginAuditService } from './plugin-audit';
import { pluginsTunable } from './plugins-tunables';

const CHANGE_TOOLS: AiToolSpec[] = [
  { name: 'change_list', description: 'List change records in this workspace (id, kind, state, title, target). Change records track proposed changes through review, the apply gate, apply and verification.', inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'Only records in this state (proposed, reviewed, gated, approved, applied, verifying, verified, rolled_back, …).' } } } },
  { name: 'change_status', description: 'Read one change record: its state, requirement, reviews, keys and verify checks.', inputSchema: { type: 'object', required: ['changeId'], properties: { changeId: { type: 'string' } } } },
  { name: 'change_request_apply', description: 'Ask for the apply gate of a reviewed change record. It moves to gated; when its requirement needs a key, the owner decides, and the apply operation can run once the record is approved.', inputSchema: { type: 'object', required: ['changeId'], properties: { changeId: { type: 'string' } } } },
];
const CHANGE_TOOL_NAMES = new Set(CHANGE_TOOLS.map((t) => t.name));
const REG_TTL_MS = 3_000;

/** A JSON schema with its `$ref`s inlined, for the model. */
export function inlineSchema(schema: JsonSchema, refs: SchemaRefs, depth = 0): JsonSchema {
  if (depth > 10 || !schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref === '#resource' ? refs.resource : refs.defs?.[schema.$ref.slice(7)];
    return target ? inlineSchema(target, refs, depth + 1) : { type: 'string' };
  }
  const out: JsonSchema = { ...schema };
  if (schema.properties && typeof schema.properties === 'object') out.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, JsonSchema>).map(([k, v]) => [k, inlineSchema(v, refs, depth + 1)]));
  if (schema.items && typeof schema.items === 'object') out.items = inlineSchema(schema.items as JsonSchema, refs, depth + 1);
  return out;
}

interface Located { iface: RegistryIface; op: string; def: OperationDef }

/** A UI call the policy stage refused (a 400 with the reason). */
export class UiRefused extends Error {}

@Injectable()
export class InterfaceDispatcher implements ToolProviderHook, PolicyStageHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InterfaceDispatcher.name);
  /** sessionId\0tool\0canonical input → admitted executions left. */
  private readonly tickets = new Map<string, number>();
  /** providerId → calls in flight (the `concurrent` budget). */
  private readonly inflight = new Map<string, number>();
  private readonly regCache = new Map<string, { reg: WorkspaceRegistry; at: number }>();
  private timer?: NodeJS.Timeout;
  private detach?: () => void;
  readonly policyStage: PolicyStageHook = this;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly plugins: PluginsService,
    private readonly changes: ChangesService,
    private readonly audit: PluginAuditService,
    @Optional() private readonly actions?: ActionsService,
    @Optional() private readonly turns?: TurnLoopService,
    @Optional() private readonly accounts?: AccountsService,
  ) {
    plugins.onChange((ws) => this.regCache.delete(ws));
    changes.rollbackRunner = (rec) => this.runRollback(rec);
    changes.isBound = async (ws, iface) => {
      const reg = await this.reg(ws);
      return reg.bindings.some((b) => b.interface === iface && reg.providers.find((p) => p.row.id === b.providerId)?.healthy);
    };
    if (actions) {
      actions.onApproval = (row, half, outcome, by, requestId) => {
        void this.audit.append(row.workspaceId, {
          actor: half === 'asked' ? (row.agentId ? `agent:${row.agentId}` : 'system') : by,
          action: half === 'asked' ? 'approval_asked' : 'approval_decided', refType: 'action', refId: row.id,
          payload: { requestId, operation: row.operation, ...(half === 'asked' ? { why: by } : { outcome }) },
        }).catch(() => undefined);
        if (half === 'decided' && outcome !== 'allowed-once') void this.release(row.id);
      };
    }
  }

  onModuleInit(): void {
    this.detach = this.turns?.addToolProvider(this);
    this.timer = setInterval(() => { void this.sweepAll(); }, 60_000);
    this.timer.unref?.();
    void this.sweepAll();
  }

  onModuleDestroy(): void {
    this.detach?.();
    if (this.timer) clearInterval(this.timer);
    this.plugins.dispose();
  }

  private async reg(workspaceId: string): Promise<WorkspaceRegistry> {
    const hit = this.regCache.get(workspaceId);
    if (hit && Date.now() - hit.at < REG_TTL_MS) return hit.reg;
    const reg = await this.plugins.registry(workspaceId);
    this.regCache.set(workspaceId, { reg, at: Date.now() });
    return reg;
  }

  private locate(reg: WorkspaceRegistry, name: string): Located | null {
    for (const iface of reg.interfaces.values()) {
      if (!name.startsWith(`${iface.name}_`)) continue;
      const op = name.slice(iface.name.length + 1);
      const def = iface.def.operations[op];
      if (def) return { iface, op, def };
    }
    return null;
  }

  // ---- ToolProviderHook ----

  owns(name: string): boolean { return CHANGE_TOOL_NAMES.has(name) || this.plugins.knownTools.has(name); }

  isReadOnly(name: string): boolean {
    if (name === 'change_list' || name === 'change_status') return true;
    if (CHANGE_TOOL_NAMES.has(name)) return false;
    // Unknown here means "not yet seen": fail safe to not read-only.
    for (const reg of [...this.regCache.values()].map((x) => x.reg)) {
      const loc = this.locate(reg, name);
      if (loc) return staticClassOf(loc.op, loc.def, loc.iface.def).cls === 'read';
    }
    return false;
  }

  /** Plugin and interface operations never run freely (§4.3). */
  async runsFreely(): Promise<boolean> { return false; }

  queuesInLoops(name: string): boolean { return !this.isReadOnly(name); }

  async contextFor(): Promise<string | null> { return null; }

  /** Providers bound in a scope the agent can reach, healthy, granted at `level`. */
  private reachable(reg: WorkspaceRegistry, iface: RegistryIface, scope: { unitId: string | null; projectId: string | null }, grants: Map<string, string>, level: 'read' | 'write'): RegistryProvider[] {
    const out: RegistryProvider[] = [];
    for (const b of reg.bindings) {
      if (b.interface !== iface.name || b.major !== iface.major) continue;
      const ok = b.scopeKind === 'workspace' || b.scopeKind === 'resource' || (b.scopeKind === 'unit' && b.scopeRef === scope.unitId) || (b.scopeKind === 'project' && b.scopeRef === scope.projectId);
      if (!ok) continue;
      const p = reg.providers.find((x) => x.row.id === b.providerId);
      if (!p?.healthy) continue;
      const g = grants.get(p.install.id);
      if (!g || (level === 'write' && g !== 'write')) continue;
      out.push(p);
    }
    return out;
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    const reg = await this.reg(session.workspaceId);
    if (reg.interfaces.size === 0) return [];
    const scope = await this.plugins.scopeOf({ agentId: session.agentId, sessionId: session.id });
    const grants = new Map((await this.plugins.grantsOf(session.workspaceId, session.agentId)).map((g) => [g.installId, g.level]));
    const specs: AiToolSpec[] = [];
    let changeKinds = false;
    for (const iface of reg.interfaces.values()) {
      const refs = refsOf(iface.def);
      for (const [op, def] of Object.entries(iface.def.operations)) {
        const level = staticClassOf(op, def, iface.def).cls === 'read' ? 'read' : 'write';
        const providers = this.reachable(reg, iface, scope, grants, level).filter((p) => p.provides.operations[op]);
        if (providers.length === 0) continue;
        const input = inlineSchema(def.input, refs);
        const role = def.change?.role;
        if (role === 'apply' || role === 'rollback' || role === 'review' || role === 'update') {
          const props = { ...((input.properties ?? {}) as Record<string, unknown>), changeId: { type: 'string', description: 'The change record this call acts on.' } };
          input.properties = props;
          if (role === 'apply' || role === 'rollback') input.required = [...new Set([...((input.required as string[] | undefined) ?? []), 'changeId'])];
          changeKinds = true;
        }
        if (role === 'propose') changeKinds = true;
        const tail = role === 'apply' ? ` It applies a ${iface.name}.${def.change!.kind} change: pass the changeId of an approved change record.`
          : role === 'rollback' ? ` It rolls back an applied ${iface.name}.${def.change!.kind} change: pass its changeId.`
            : role === 'propose' ? ` It opens a ${iface.name}.${def.change!.kind} change record.` : '';
        const spec: AiToolSpec = { name: toolName(iface.name, op), description: `${def.semantics}${tail}`, inputSchema: input };
        // Model-visible means logged: a definition that cannot be logged is not offered.
        const logged = await this.provenance(session, 'tool_definition', iface.pluginId, iface.pluginVersion, `${iface.name}.${op}`, canonicalJson(spec), false);
        if (logged) specs.push(spec);
      }
    }
    if (changeKinds) specs.push(...CHANGE_TOOLS);
    return specs;
  }

  /** One provenance row per distinct text per session; false when it could not be written. */
  private async provenance(session: ChatSession, sourceKind: string, pluginId: string, pluginVersion: string, contributionId: string, text: string, untrusted: boolean): Promise<boolean> {
    try {
      await this.db.insert(contextProvenance).values({
        accountId: currentAccountId(), id: newId(), workspaceId: session.workspaceId, sessionId: session.id, turnId: null, sourceKind,
        pluginId, pluginVersion, contributionId, contentHash: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), untrusted: untrusted ? 1 : 0, createdAt: nowIso(),
      }).onConflictDoNothing();
      return true;
    } catch (err) {
      this.logger.warn(`provenance not logged for ${contributionId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ---- the policy stage ----

  private ticketKey(sessionId: string, name: string, input: Record<string, unknown>): string {
    return `${sessionId}\u0000${name}\u0000${canonicalJson(input)}`;
  }

  admit(session: ChatSession, name: string, input: Record<string, unknown>): void {
    const k = this.ticketKey(session.id, name, input);
    this.tickets.set(k, (this.tickets.get(k) ?? 0) + 1);
  }

  async preflight(session: ChatSession, call: AiToolCall, origin: TurnOrigin): Promise<PolicyPreflight | null> {
    if (CHANGE_TOOL_NAMES.has(call.name)) return null;
    const ws = session.workspaceId;
    const reg = await this.reg(ws);
    const loc = this.locate(reg, call.name);
    const refused = (why: string, fields: Partial<PluginCallFields> = {}): PolicyPreflight => ({ refuse: why, cls: 'external_reversible', requirement: 'trust', mayRemember: false, fields });
    if (!loc) return refused(`${call.name} is not an installed interface operation`);
    const { iface, op, def } = loc;
    const opId = `${iface.name}.${op}`;
    const base: Partial<PluginCallFields> = { operation: opId, interfaceVersion: iface.version, definitionHash: sha256(canonicalJson(def)) };
    if (!session.agentId) return refused('interface operations are for durable agents', base);
    // 1. resolve the binding
    const resource = this.resourceOf(def, call.input);
    const scope = await this.plugins.scopeOf({ agentId: session.agentId, sessionId: session.id });
    const res = this.plugins.resolveIn(reg, iface.name, { resource, ...scope });
    if (!res.ok) return refused(res.reason, base);
    const provider = res.provider;
    const fields: Partial<PluginCallFields> = { ...base, providerId: provider.row.id, bindingScope: res.scope, pluginVersion: `${provider.pluginId}@${provider.pluginVersion}`, packageDigest: provider.digest, tainted: 0 };
    if (!provider.provides.operations[op]) return refused(`${provider.pluginId} does not implement ${opId}`, fields);
    // 2. the agent's grant on that provider
    const st = staticClassOf(op, def, iface.def, provider.provides);
    const grant = (await this.plugins.grantsOf(ws, session.agentId)).find((g) => g.installId === provider.install.id);
    const need = st.cls === 'read' ? 'read' : 'write';
    if (!grant || (need === 'write' && grant.level !== 'write')) return refused(`this agent holds no ${need} grant on ${provider.pluginId}; the owner grants it per agent`, fields);
    // 3. classify
    let cls: ActionClass = maxClass(st.cls, classByInputOf(def, this.stripCore(call.input)));
    let requirement: Requirement = st.floor.twoKey ? 'two_key' : 'trust';
    // 4. the change gate
    const role = def.change?.role;
    const kindName = def.change ? `${iface.name}.${def.change.kind}` : null;
    let preKeyed: PolicyPreflight['preKeyed'] = null;
    let bind: Record<string, unknown> | null = null;
    if ((role === 'apply' || role === 'rollback') && kindName) {
      requirement = maxRequirement(requirement, kindRequirement(iface.def.changeKinds?.[def.change!.kind]));
      const fieldsOfInput = Object.keys((def.input.properties ?? {}) as Record<string, unknown>);
      const gate = await this.changes.gate(ws, call.input.changeId, role, kindName, this.stripCore(call.input), fieldsOfInput);
      if (!gate.ok) return refused(`the change gate refused ${opId}: ${gate.reason}`, fields);
      fields.changeId = gate.rec.id;
      bind = JSON.parse(gate.rec.bind || '{}') as Record<string, unknown>;
      requirement = maxRequirement(requirement, gate.rec.requirement as Requirement);
      preKeyed = gate.preKeyed;
    }
    // 5. owner and requested policies: they only raise; an owner deny refuses
    const raised = this.plugins.applyPolicies(reg, { cls, requirement }, { opId, resource, changeKind: kindName, bind: bind ?? this.stripCore(call.input) });
    if (raised.deny) return refused(`the owner's policy denies ${opId}: ${raised.deny}`, fields);
    cls = raised.cls;
    requirement = raised.requirement;
    // 6. budget and metering
    const cost = def.cost?.usd ?? 0;
    const budgets = provider.manifest.budgets ?? {};
    if (budgets.maxCostPerCallUsd !== undefined && cost > budgets.maxCostPerCallUsd) return refused(`${opId} costs $${cost} per call, over ${provider.pluginId}'s cap of $${budgets.maxCostPerCallUsd}`, fields);
    if (budgets.concurrent !== undefined && (this.inflight.get(provider.row.id) ?? 0) >= budgets.concurrent) return refused(`${provider.pluginId} already has ${budgets.concurrent} call(s) in flight; try again when one finishes`, fields);
    if (budgets.callsPerMinute !== undefined) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const n = (await this.db.select({ id: actionLog.id }).from(actionLog).where(and(eq(actionLog.providerId, provider.row.id), gte(actionLog.createdAt, since)))).length;
      if (n >= budgets.callsPerMinute) return refused(`${provider.pluginId} reached its ${budgets.callsPerMinute} calls per minute`, fields);
    }
    const org = this.actions ? await this.actions.trust.orgOf(ws) : null;
    const cap = pluginsTunable(org, 'plugins.monthlyUsd');
    const spent = await this.monthSpend(ws);
    if (spent + cost > cap + 1e-9) return refused(`the plugin envelope is spent: $${spent.toFixed(4)} of $${cap} this month (plugins.monthlyUsd)`, fields);
    fields.costUsd = cost;
    fields.costState = 'reserved';
    if (preKeyed) fields.approvalRequestId = preKeyed.requestId || null;
    void origin;
    return { cls, requirement, preKeyed, mayRemember: mayRemember(cls, role) && (requirement === 'trust' || requirement === 'cosign'), fields };
  }

  /** Metered spend this calendar month: reserved and settled plugin calls. */
  async monthSpend(workspaceId: string, now = new Date()): Promise<number> {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const rows = await this.db.select({ c: actionLog.costUsd, s: actionLog.costState }).from(actionLog)
      .where(and(eq(actionLog.workspaceId, workspaceId), isNotNull(actionLog.operation), gte(actionLog.createdAt, start), inArray(actionLog.costState, ['reserved', 'settled'])));
    return rows.reduce((a, r) => a + (r.c ?? 0), 0);
  }

  async settle(row: ActionRow, status: string): Promise<void> {
    if (!row.operation) return;
    if (status === 'succeeded' || status === 'failed') await this.db.update(actionLog).set({ costState: 'settled' }).where(eq(actionLog.id, row.id));
    else if (status === 'denied' || status === 'refused') await this.release(row.id);
    // held / staged: the reservation stands until the key settles or releases it
  }

  private async release(rowId: string): Promise<void> {
    await this.db.update(actionLog).set({ costState: 'released', costUsd: 0 }).where(and(eq(actionLog.id, rowId), isNotNull(actionLog.operation)));
  }

  private resourceOf(def: OperationDef, input: Record<string, unknown>): string | null {
    for (const f of resourceFields(def.input)) if (typeof input[f] === 'string') return input[f] as string;
    return null;
  }

  /** The call's input without the core's own fields. */
  private stripCore(input: Record<string, unknown>): Record<string, unknown> {
    const { changeId: _c, ...rest } = input;
    void _c;
    return rest;
  }

  // ---- declarative UI (§3.8): a person's query or action, through the same stage ----

  /**
   * Run an interface operation for a UI contribution, on behalf of a person
   * (never an agent): the binding resolves at workspace scope, the class is
   * the max rule with floors and `classByInput`, owner and requested
   * policies raise it or deny, and the plugin envelope and per-call cap
   * apply. A query must stay `read`. An action that is not `read` is the
   * owner's alone and runs only on an explicit confirmation (the owner's
   * click is the key for trust, cosign and owner-key requirements); a
   * two-key operation never runs from a button — it needs the second key an
   * agent's proposal and its change record carry. Apply and rollback of a
   * change record are refused here. Every call is audited.
   */
  async uiCall(workspaceId: string, opId: string, input: Record<string, unknown>, who: { actor: string; owner: boolean; confirmed: boolean; mode: 'query' | 'action'; source: string }):
    Promise<{ status: 'ok'; output: unknown; cls: ActionClass; requirement: Requirement } | { status: 'confirm'; cls: ActionClass; requirement: Requirement; reasons: string[] }> {
    const reg = await this.reg(workspaceId);
    const [ifn, op] = opId.split('.');
    const iface = reg.interfaces.get(ifn);
    const def = iface?.def.operations[op];
    const refuse = (why: string): never => { throw new UiRefused(why); };
    if (!iface || !def) refuse(`${opId} is not an installed interface operation`);
    const resource = this.resourceOf(def!, input);
    const res = this.plugins.resolveIn(reg, ifn, { resource, unitId: null, projectId: null });
    if (!res.ok) refuse(res.reason);
    const provider = (res as { provider: RegistryProvider }).provider;
    if (!provider.provides.operations[op]) refuse(`${provider.pluginId} does not implement ${opId}`);
    const role = def!.change?.role;
    if (role === 'apply' || role === 'rollback' || role === 'review') refuse(`${opId} moves a change record; that runs through the change gate, not a button`);
    const st = staticClassOf(op, def!, iface!.def, provider.provides);
    let cls: ActionClass = maxClass(st.cls, classByInputOf(def!, input));
    let requirement: Requirement = st.floor.twoKey ? 'two_key' : 'trust';
    const kindName = def!.change ? `${ifn}.${def!.change.kind}` : null;
    const raised = this.plugins.applyPolicies(reg, { cls, requirement }, { opId, resource, changeKind: kindName, bind: input });
    if (raised.deny) refuse(`the owner's policy denies ${opId}: ${raised.deny}`);
    cls = raised.cls;
    requirement = raised.requirement;
    if (who.mode === 'query' && cls !== 'read') refuse(`${opId} is classed ${cls}; a view may only read`);
    const cost = def!.cost?.usd ?? 0;
    const budgets = provider.manifest.budgets ?? {};
    if (budgets.maxCostPerCallUsd !== undefined && cost > budgets.maxCostPerCallUsd) refuse(`${opId} costs $${cost} per call, over ${provider.pluginId}'s cap`);
    const org = this.actions ? await this.actions.trust.orgOf(workspaceId) : null;
    const cap = pluginsTunable(org, 'plugins.monthlyUsd');
    if ((await this.monthSpend(workspaceId)) + cost > cap + 1e-9) refuse(`the plugin envelope is spent (plugins.monthlyUsd)`);
    if (cls !== 'read') {
      if (!who.owner) refuse(`${opId} is classed ${cls}; only the workspace owner runs it from a button`);
      if (cls === 'external_irreversible' || cls === 'money') requirement = 'two_key';
      if (requirement === 'two_key') refuse(`${opId} needs two keys (${st.floor.reasons.join('; ') || 'policy'}); ask an agent to propose it so the change record carries the second key`);
      if (!who.confirmed) return { status: 'confirm', cls, requirement, reasons: [...st.floor.reasons, ...(requirement !== 'trust' ? [`requires ${requirement.replace('_', ' ')}`] : [])] };
    }
    let output: unknown;
    try {
      output = await callProvider({ iface: iface!.def, op, input, pkg: provider.pkg });
    } catch (err) {
      await this.audit.append(workspaceId, { actor: who.actor, action: 'plugin_ui_call', refType: 'operation', refId: opId, payload: { source: who.source, cls, requirement, outcome: 'error', error: err instanceof Error ? err.message.slice(0, 200) : String(err) } });
      throw new UiRefused(`provider error from ${provider.pluginId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (who.mode === 'action' || cls !== 'read') {
      await this.audit.append(workspaceId, { actor: who.actor, action: 'plugin_ui_call', refType: 'operation', refId: opId, payload: { source: who.source, cls, requirement, provider: provider.pluginId, outcome: 'ok', costUsd: cost } });
    }
    return { status: 'ok', output, cls, requirement };
  }

  // ---- execution ----

  async execute(session: ChatSession, name: string, input: Record<string, unknown>, ctx?: ToolExecCtx): Promise<string> {
    if (CHANGE_TOOL_NAMES.has(name)) return this.changeTool(session, name, input);
    const k = this.ticketKey(session.id, name, input);
    const left = this.tickets.get(k) ?? 0;
    if (left <= 0) throw new Error(`refused: ${name} did not pass the policy stage (deny by default)`);
    if (left === 1) this.tickets.delete(k); else this.tickets.set(k, left - 1);
    const ws = session.workspaceId;
    this.regCache.delete(ws);
    const reg = await this.reg(ws);
    const loc = this.locate(reg, name);
    if (!loc) throw new Error(`${name} is no longer installed`);
    const { iface, op, def } = loc;
    const opId = `${iface.name}.${op}`;
    const resource = this.resourceOf(def, input);
    const scope = await this.plugins.scopeOf({ agentId: session.agentId, sessionId: session.id });
    const res = this.plugins.resolveIn(reg, iface.name, { resource, ...scope });
    if (!res.ok) throw new Error(`refused: ${res.reason}`);
    const provider = res.provider;
    const role = def.change?.role;
    const kindName = def.change ? `${iface.name}.${def.change.kind}` : null;
    const clean = this.stripCore(input);
    let rec: ChangeRow | null = null;
    if ((role === 'apply' || role === 'rollback') && kindName) {
      const gate = await this.changes.gate(ws, input.changeId, role, kindName, clean, Object.keys((def.input.properties ?? {}) as Record<string, unknown>));
      if (!gate.ok) throw new Error(`refused by the change gate: ${gate.reason}`);
      rec = gate.rec;
    }
    const by = session.agentId ? `agent:${session.agentId}` : 'system';
    this.inflight.set(provider.row.id, (this.inflight.get(provider.row.id) ?? 0) + 1);
    let output: unknown;
    try {
      output = await callProvider({ iface: iface.def, op, input: clean, pkg: provider.pkg, signal: ctx?.signal });
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : 'error';
      const msg = err instanceof Error ? err.message : String(err);
      if (rec && role === 'apply') await this.changes.applyFailed(ws, rec.id, { by, code, detail: msg }).catch(() => undefined);
      await this.settleByKey(session, name, input, 'settled');
      throw new Error(`provider error (${code}) from ${provider.pluginId}: ${msg}`, { cause: err });
    } finally {
      const n = (this.inflight.get(provider.row.id) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(provider.row.id); else this.inflight.set(provider.row.id, n);
    }
    const row = await this.rowByKey(session, name, input);
    if (row?.costState === 'reserved' && row.status !== 'started') await this.settleByKey(session, name, input, 'settled');
    let note = '';
    if (role && kindName && def.change) {
      note = await this.changeHook(session, reg, iface, def, kindName, role, clean, output as Record<string, unknown>, provider, res.scope, rec, row?.id ?? null).catch((err: unknown) => `\n(change record not updated: ${err instanceof Error ? err.message : String(err)})`);
    }
    const body = JSON.stringify(output);
    const text = def.untrustedOutput
      ? `<plugin-output source="${iface.name} via ${provider.pluginId}" untrusted="true">\n${body}\n</plugin-output>${note}`
      : `${body}${note}`;
    const logged = await this.provenance(session, 'operation_result', provider.pluginId, provider.pluginVersion, opId, text, def.untrustedOutput);
    if (!logged) throw new Error(`the result of ${opId} could not be logged with its provenance, so it is withheld`);
    return text;
  }

  private async rowByKey(session: ChatSession, name: string, input: Record<string, unknown>): Promise<ActionRow | null> {
    if (!this.actions) return null;
    const key = this.actions.keyFor({ sessionId: session.id, workspaceId: session.workspaceId, agentId: session.agentId ?? null, origin: 'user' }, name, input);
    return this.actions.byKey(key);
  }

  /** A held call run on the owner's key settles its reservation here. */
  private async settleByKey(session: ChatSession, name: string, input: Record<string, unknown>, state: 'settled'): Promise<void> {
    const row = await this.rowByKey(session, name, input);
    if (row?.operation && row.costState === 'reserved' && row.status !== 'started') await this.db.update(actionLog).set({ costState: state }).where(eq(actionLog.id, row.id));
  }

  /** The change lifecycle a successful operation drives (by its declared role). */
  private async changeHook(session: ChatSession, reg: WorkspaceRegistry, iface: RegistryIface, def: OperationDef, kindName: string, role: string, input: Record<string, unknown>, output: Record<string, unknown>, provider: RegistryProvider, scope: string, rec: ChangeRow | null, actionId: string | null): Promise<string> {
    const ws = session.workspaceId;
    const by = `agent:${session.agentId}`;
    const kind = iface.def.changeKinds?.[def.change!.kind];
    if (role === 'propose' && kind) {
      const combined = { ...input, ...(output && typeof output === 'object' ? output : {}) };
      const bind = Object.fromEntries(Object.keys(kind.bind).filter((k) => combined[k] !== undefined).map((k) => [k, combined[k]]));
      const raised = this.plugins.applyPolicies(reg, { cls: 'read', requirement: kindRequirement(kind) }, { opId: `${iface.name}.${Object.keys(iface.def.operations).find((o) => iface.def.operations[o].change?.kind === def.change!.kind && iface.def.operations[o].change?.role === 'apply') ?? 'apply'}`, resource: this.resourceOf(def, input), changeKind: kindName, bind });
      const checks: VerifyCheck[] = [
        ...(kind.verify ?? []).map((v) => ({ source: iface.pluginId, event: v.event, match: v.match, within: v.within, status: 'pending' as const })),
        ...reg.installs.filter((li) => li.install.status !== 'disabled').flatMap((li) => (li.manifest.verifies ?? []).filter((v) => v.changeKind === kindName).map((v) => ({
          source: li.manifest.id, event: typeof v.check.event === 'string' ? v.check.event : undefined, match: typeof v.check.match === 'string' ? v.check.match : undefined,
          within: typeof v.check.within === 'string' ? v.check.within : '30m', status: 'pending' as const,
        }))),
      ];
      const created = await this.changes.create(ws, {
        kind: kindName, title: typeof input.title === 'string' ? input.title : `${kindName} on ${this.resourceOf(def, input) ?? 'a resource'}`, proposer: by,
        ref: this.resourceOf(def, input) ?? '', bind, interfaceVersionId: iface.interfaceVersionId, providerId: provider.row.id, bindingScope: scope,
        requirement: raised.requirement, checks, taskId: session.taskKind === 'org' ? session.taskId : null,
      });
      return `\nChange record ${created.id} (${kindName}) is proposed; it needs an independent review, then change_request_apply.`;
    }
    if (role === 'review') {
      const target = typeof input.changeId === 'string' ? await this.changes.get(ws, input.changeId).catch(() => null) : await this.changes.findByBind(ws, kindName, input);
      if (!target) return '';
      const v = def.change!.verdict;
      const approve = v ? v.approveIn.some((x) => JSON.stringify(x) === JSON.stringify(this.pathOf(input, v.path))) : true;
      const after = await this.changes.review(ws, target.id, { by, approve });
      const counted = after.proposer !== by;
      return `\nReview recorded on change ${target.id.slice(0, 8)}${counted ? '' : ' (it does not count: the proposer reviewed their own change)'}; it is ${after.state}.`;
    }
    if (role === 'apply' && rec) {
      const after = await this.changes.applied(ws, rec.id, { by, actionId, output });
      return `\nChange ${rec.id.slice(0, 8)} is ${after.state}.`;
    }
    if (role === 'rollback' && rec) {
      let cur = rec;
      if (cur.state === 'applied' || cur.state === 'verifying') cur = await this.changes.transition(cur, 'rolling_back', by, 'the agent rolled it back');
      if (cur.state === 'rolling_back') cur = await this.changes.transition(cur, 'rolled_back', by, 'the rollback-role operation succeeded', { rollbackActionId: actionId });
      return `\nChange ${rec.id.slice(0, 8)} is ${cur.state}.`;
    }
    return '';
  }

  private pathOf(input: Record<string, unknown>, path: string): unknown {
    return path.replace(/^\$\.?/, '').split('.').filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), input);
  }

  private async changeTool(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    const ws = session.workspaceId;
    if (name === 'change_list') {
      const rows = await this.changes.list(ws, { state: typeof input.state === 'string' ? input.state : undefined, limit: 50 });
      if (rows.length === 0) return 'No change records.';
      return rows.map((r) => `${r.id} · ${r.kind} · ${r.state} · ${r.title}${r.ref ? ` · ${r.ref}` : ''}`).join('\n');
    }
    const id = String(input.changeId ?? '');
    if (name === 'change_status') {
      const r = await this.changes.get(ws, id);
      const keys = JSON.parse(r.keys || '{}') as Record<string, unknown>;
      return JSON.stringify({ id: r.id, kind: r.kind, state: r.state, title: r.title, ref: r.ref, bind: JSON.parse(r.bind), requirement: r.requirement, reviews: JSON.parse(r.reviews), gate: { outcome: keys.outcome ?? null, keyed: Boolean((keys.owner as { approve?: boolean } | undefined)?.approve), used: Boolean(keys.used) }, verify: JSON.parse(r.verify), deadlineAt: r.deadlineAt });
    }
    const r = await this.changes.requestApply(ws, id, session.agentId ? `agent:${session.agentId}` : 'system');
    return r.state === 'approved'
      ? `Change ${r.id.slice(0, 8)} is approved: its requirement is the trust decision of the apply call, so the apply operation can run now (the ordinary approval chain still applies).`
      : `Change ${r.id.slice(0, 8)} is gated: it needs ${r.requirement.replace('_', '-')} before the apply operation can run. Do not apply it yet; tell the user it is waiting for the owner's key.`;
  }

  // ---- unattended rollback (§4.8) ----

  private async runRollback(rec: ChangeRow): Promise<{ ok: boolean; actionId?: string; detail: string } | null> {
    if (rec.kind === MANUAL_KIND) return null;
    const [ifaceName, kind] = rec.kind.split('.');
    const reg = await this.plugins.registry(rec.workspaceId);
    const iface = reg.interfaces.get(ifaceName);
    if (!iface) return { ok: false, detail: `the ${ifaceName} interface is not installed` };
    const opEntry = Object.entries(iface.def.operations).find(([, d]) => d.change?.kind === kind && d.change.role === 'rollback');
    if (!opEntry) return null;
    const [op, def] = opEntry;
    const bind = JSON.parse(rec.bind || '{}') as Record<string, unknown>;
    const props = Object.keys((def.input.properties ?? {}) as Record<string, unknown>);
    const input = Object.fromEntries(props.filter((p) => bind[p] !== undefined).map((p) => [p, bind[p]]));
    const resource = this.resourceOf(def, input);
    const res = this.plugins.resolveIn(reg, ifaceName, { resource });
    if (!res.ok) return { ok: false, detail: res.reason };
    const opId = `${ifaceName}.${op}`;
    let row: ActionRow | null = null;
    if (this.actions) {
      const actx = { sessionId: `change:${rec.id}`, workspaceId: rec.workspaceId, agentId: null, origin: 'loop' as const };
      const key = this.actions.keyFor(actx, toolName(ifaceName, op), input);
      const prior = await this.actions.byKey(key);
      row = await this.actions.start(actx, {
        key, tool: toolName(ifaceName, op), input, cls: staticClassOf(op, def, iface.def, res.provider.provides).cls, decision: 'change_rollback', level: null, prior,
        plugin: { operation: opId, interfaceVersion: iface.version, providerId: res.provider.row.id, bindingScope: res.scope, pluginVersion: `${res.provider.pluginId}@${res.provider.pluginVersion}`, packageDigest: res.provider.digest, definitionHash: sha256(canonicalJson(def)), changeId: rec.id, costUsd: def.cost?.usd ?? 0, costState: 'reserved', approvalRequestId: (JSON.parse(rec.keys || '{}') as { requestId?: string }).requestId ?? null, approvalOutcome: 'allowed-once', approvalDecidedAt: nowIso() } as Partial<PluginCallFields> as PluginCallFields,
      });
    }
    try {
      const out = await callProvider({ iface: iface.def, op, input, pkg: res.provider.pkg });
      if (row && this.actions) { await this.actions.finish(row, { status: 'succeeded', result: JSON.stringify(out), keys: { change: rec.id, by: 'the change approval (apply and rollback together)' } }); await this.settle(row, 'succeeded'); }
      return { ok: true, actionId: row?.id, detail: `${opId} ran unattended` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (row && this.actions) { await this.actions.finish(row, { status: 'failed', result: msg }); await this.settle(row, 'failed'); }
      return { ok: false, actionId: row?.id, detail: msg };
    }
  }

  // ---- deadlines ----

  /** Gates and verify windows (change records), and held plugin calls nobody answered. */
  async sweep(now = new Date()): Promise<{ rejected: number; rolledBack: number; expired: number }> {
    const r = await this.changes.sweep(now);
    let expired = 0;
    if (this.actions) {
      const held = await this.db.select().from(actionLog).where(and(eq(actionLog.status, 'held'), isNotNull(actionLog.operation), isNotNull(actionLog.approvalAskedAt), lte(actionLog.approvalAskedAt, now.toISOString())));
      for (const row of held) {
        const org = await this.actions.trust.orgOf(row.workspaceId);
        const hours = pluginsTunable(org, 'plugins.heldDeadlineHours');
        if (Date.parse(row.approvalAskedAt!) + hours * 3_600_000 > now.getTime()) continue;
        await this.actions.finish(row, { status: 'denied', note: 'no key before the deadline (unavailable means no)' });
        await this.actions.markDecided(row, 'unavailable', 'system');
        const approvalId = (JSON.parse(row.keys || '{}') as { approvalId?: string }).approvalId;
        if (approvalId) await this.actions.hooks.closeApproval?.(row.workspaceId, approvalId, false, 'expired').catch(() => undefined);
        expired += 1;
      }
    }
    return { ...r, expired };
  }

  private async sweepAll(): Promise<void> {
    const one = async () => { await this.sweep(); };
    try {
      if (this.accounts) await this.accounts.forEachAccount(one); else await one();
    } catch (err) {
      this.logger.warn(`plugin sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
