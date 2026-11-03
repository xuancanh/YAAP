/**
 * The fixed policy stage's arithmetic (docs/plugins.md §4.3, §5.1–§5.5):
 * generic floors, the effective class of an interface operation, the
 * requirement of a call or a change record, owner and requested policies,
 * the approval outcome vocabulary, and the permission diff between two
 * manifests (§6.5). Domain-free: it reads declarations (change roles, kind
 * reversibility, `outbound`, `movesMoney`, HTTP methods) and never an
 * operation's name, except for the core's generic money-name floor.
 *
 * Everything combines with `max`. No input can lower a class below a
 * floor; no plugin declaration can produce an "allow". Pure.
 */
import { ACTION_CLASSES, TWO_KEY_CLASSES, isActionClass, isMoneyName, type ActionClass } from '../actions/action-classes';
import type { ChangeKindDef, InterfaceDef, Manifest, OperationDef, OperationImpl, ProvidesDef, Requirement } from './manifest';
import { getPath, globMatch, render } from './template';
import { canonicalJson } from '../actions/action-classes';

export function rank(c: ActionClass): number { return ACTION_CLASSES.indexOf(c); }

export function maxClass(...cs: Array<ActionClass | null | undefined>): ActionClass {
  let best: ActionClass = 'read';
  for (const c of cs) if (c && rank(c) > rank(best)) best = c;
  return best;
}

export const REQUIREMENT_ORDER: readonly Requirement[] = ['trust', 'cosign', 'two_key', 'owner_key'];
export function maxRequirement(...rs: Array<Requirement | null | undefined>): Requirement {
  let best: Requirement = 'trust';
  for (const r of rs) if (r && REQUIREMENT_ORDER.indexOf(r) > REQUIREMENT_ORDER.indexOf(best)) best = r;
  return best;
}

/** The closed approval vocabulary (§4.3). `unavailable` means deny. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export const APPROVAL_OUTCOMES: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

export interface Floor {
  cls: ActionClass;
  /** Why the floor raised the class, for the review screen. */
  reasons: string[];
  /** Two keys by default (apply or rollback of a costly or irreversible kind). */
  twoKey: boolean;
}

/** The core's generic floors for one operation (§4.3 step 1). */
export function floorOf(name: string, op: Partial<OperationDef>, kinds: Record<string, ChangeKindDef> = {}, impl?: OperationImpl): Floor {
  let cls: ActionClass = 'read';
  const reasons: string[] = [];
  let twoKey = false;
  const raise = (c: ActionClass, why: string) => { if (rank(c) > rank(cls)) { cls = c; } reasons.push(why); };
  const role = op.change?.role;
  const kind = op.change ? kinds[op.change.kind] : undefined;
  if ((role === 'apply' || role === 'rollback') && kind && (kind.reversibility === 'costly' || kind.reversibility === 'irreversible')) {
    raise('external_irreversible', `${role} of a ${kind.reversibility} change kind is at least external_irreversible and two-key`);
    twoKey = true;
  }
  if (op.outbound === true) raise('external_reversible', 'it carries workspace content out (outbound)');
  if (impl && 'http' in impl && impl.http.method !== 'GET') raise('external_reversible', `its HTTP implementation uses ${impl.http.method}`);
  if (op.movesMoney === true || isMoneyName(name)) raise('money', op.movesMoney ? 'it moves money' : 'its name reads like a money-moving action');
  if (!isActionClass(op.class)) raise('external_reversible', 'its class is undeclared, so it is gated');
  return { cls, reasons, twoKey };
}

/** The interface's input-dependent raise (`classByInput`), if any row matches. */
export function classByInputOf(op: OperationDef, input: Record<string, unknown>, ctx: Record<string, unknown> = {}): ActionClass | null {
  let out: ActionClass | null = null;
  for (const row of op.classByInput ?? []) {
    const got = getPath(input, row.path);
    let hit = false;
    if (row.equals !== undefined) {
      const want = render(row.equals, ctx);
      hit = JSON.stringify(got) === JSON.stringify(want) && want !== '';
    }
    if (row.in && row.in.some((x) => JSON.stringify(x) === JSON.stringify(got))) hit = true;
    if (row.gt !== undefined && typeof got === 'number' && got > row.gt) hit = true;
    if (hit) out = maxClass(out, row.class);
  }
  return out;
}

export interface StaticClass {
  cls: ActionClass;
  interfaceClass: ActionClass | null;
  providerClass: ActionClass | null;
  floor: Floor;
}

/** Interface class ⊔ provider raise ⊔ floors — everything but owner policy and input. */
export function staticClassOf(name: string, op: OperationDef, iface: Pick<InterfaceDef, 'changeKinds'>, provider?: Pick<ProvidesDef, 'class' | 'operations'>): StaticClass {
  const impl = provider?.operations?.[name];
  const floor = floorOf(name, op, iface.changeKinds ?? {}, impl);
  const interfaceClass = isActionClass(op.class) ? op.class : null;
  const providerClass = provider?.class?.[name] && isActionClass(provider.class[name]) ? provider.class[name] : null;
  return { cls: maxClass(floor.cls, interfaceClass, providerClass), interfaceClass, providerClass, floor };
}

/** An owner policy or a requested one, normalised. */
export interface PolicyRule {
  operation?: string | null;
  changeKind?: string | null;
  resourcePattern?: string | null;
  bind?: Record<string, string> | null;
  require: string;
  why: string;
  source: 'owner' | 'plugin';
}

/** Whether a rule targets this call. `operation` matches the canonical id or `iface.*`. */
export function ruleMatches(rule: PolicyRule, call: { opId: string; resource?: string | null; changeKind?: string | null; bind?: Record<string, unknown> | null }): boolean {
  if (rule.operation) {
    const [iface] = call.opId.split('.');
    if (!(rule.operation === call.opId || rule.operation === `${iface}.*`)) return false;
  }
  if (rule.changeKind && rule.changeKind !== call.changeKind) return false;
  if (!rule.operation && !rule.changeKind) return false;
  if (rule.resourcePattern && !(call.resource && globMatch(rule.resourcePattern, call.resource))) return false;
  if (rule.bind) {
    for (const [k, pat] of Object.entries(rule.bind)) {
      const v = call.bind?.[k];
      if (typeof v !== 'string' || !globMatch(pat, v)) return false;
    }
  }
  return true;
}

export interface RaisedDecision {
  cls: ActionClass;
  requirement: Requirement;
  deny: string | null;
  applied: Array<{ source: 'owner' | 'plugin'; require: string; why: string }>;
}

/** Apply matching rules: each can only raise; an owner `deny` refuses. */
export function applyRules(base: { cls: ActionClass; requirement: Requirement }, rules: PolicyRule[], call: Parameters<typeof ruleMatches>[1]): RaisedDecision {
  let { cls, requirement } = base;
  let deny: string | null = null;
  const applied: RaisedDecision['applied'] = [];
  for (const r of rules) {
    if (!ruleMatches(r, call)) continue;
    if (r.require === 'deny') {
      if (r.source === 'owner') { deny = r.why || 'the owner denied this operation'; applied.push({ source: r.source, require: r.require, why: r.why }); }
      continue;
    }
    if (r.require.startsWith('class:') && isActionClass(r.require.slice(6))) cls = maxClass(cls, r.require.slice(6) as ActionClass);
    else if ((['cosign', 'two_key', 'owner_key'] as string[]).includes(r.require)) requirement = maxRequirement(requirement, r.require as Requirement);
    else continue;
    applied.push({ source: r.source, require: r.require, why: r.why });
  }
  return { cls, requirement, deny, applied };
}

/** The requirement a class implies by itself: two-key classes need a second key. */
export function classRequirement(cls: ActionClass): Requirement {
  return TWO_KEY_CLASSES.includes(cls) ? 'two_key' : 'trust';
}

/** A change kind's requirement before policies: its declaration ⊔ the floor. */
export function kindRequirement(kind: ChangeKindDef | undefined): Requirement {
  if (!kind) return 'two_key';
  const floor: Requirement = kind.reversibility === 'costly' || kind.reversibility === 'irreversible' ? 'two_key' : 'trust';
  return maxRequirement(kind.requirement ?? 'trust', floor);
}

/** Remembered approvals (allow-always, allow-tool) for a plugin call (§4.3):
 *  only read and external_reversible, and never apply or rollback. */
export function mayRemember(cls: ActionClass, role?: string | null): boolean {
  return (cls === 'read' || cls === 'external_reversible') && role !== 'apply' && role !== 'rollback';
}

// ---- the permission diff (§6.5) ----

export interface DiffEntry { path: string; widening: boolean; detail: string }

function byName<T>(list: T[] | undefined, key: (t: T) => string): Map<string, T> {
  return new Map((list ?? []).map((x) => [key(x), x]));
}

const REVERSIBILITY_ORDER = ['none', 'reversible', 'costly', 'irreversible'];

/** What `next` changes against the approved `prev` (null = a fresh install,
 *  everything widens). A widening entry needs the owner's consent. */
export function permissionDiff(prev: Manifest | null, next: Manifest): DiffEntry[] {
  const out: DiffEntry[] = [];
  const w = (path: string, detail: string) => out.push({ path, widening: true, detail });
  const n = (path: string, detail: string) => out.push({ path, widening: false, detail });
  if (!prev) {
    w('plugin', `install ${next.id}@${next.version}`);
    return out;
  }
  const pi = byName(prev.interfaces, (i) => i.name);
  for (const iface of next.interfaces ?? []) {
    const old = pi.get(iface.name);
    if (!old) { w(`interfaces.${iface.name}`, 'interface added'); continue; }
    const oldKinds = old.changeKinds ?? {};
    for (const [name, op] of Object.entries(iface.operations)) {
      const p = `interfaces.${iface.name}.operations.${name}`;
      const o = old.operations[name];
      if (!o) { w(p, 'operation added'); continue; }
      const oc = isActionClass(o.class) ? rank(o.class) : rank('external_reversible');
      const nc = isActionClass(op.class) ? rank(op.class) : rank('external_reversible');
      if (nc < oc) w(p, `class lowered ${String(o.class)} → ${String(op.class)}`);
      else if (nc > oc) n(p, `class raised ${String(o.class)} → ${String(op.class)}`);
      if (REVERSIBILITY_ORDER.indexOf(op.reversibility) < REVERSIBILITY_ORDER.indexOf(o.reversibility)) w(p, `reversibility relaxed ${o.reversibility} → ${op.reversibility}`);
      if (o.outbound && !op.outbound) w(p, 'outbound cleared');
      if (o.movesMoney && !op.movesMoney) w(p, 'movesMoney cleared');
      if (o.semantics !== op.semantics) w(p, 'semantics changed');
      if (canonicalJson(o.change ?? null) !== canonicalJson(op.change ?? null)) w(p, 'change role moved');
      if (canonicalJson(o.input) !== canonicalJson(op.input) || canonicalJson(o.output) !== canonicalJson(op.output)) w(p, 'schema changed');
      if (canonicalJson(o.classByInput ?? []) !== canonicalJson(op.classByInput ?? [])) w(p, 'classByInput changed');
    }
    for (const name of Object.keys(old.operations)) if (!iface.operations[name]) n(`interfaces.${iface.name}.operations.${name}`, 'operation removed');
    for (const [k, kind] of Object.entries(iface.changeKinds ?? {})) {
      const p = `interfaces.${iface.name}.changeKinds.${k}`;
      const o = oldKinds[k];
      if (!o) { w(p, 'change kind added'); continue; }
      if (REVERSIBILITY_ORDER.indexOf(kind.reversibility) < REVERSIBILITY_ORDER.indexOf(o.reversibility)) w(p, `reversibility relaxed ${o.reversibility} → ${kind.reversibility}`);
      if (REQUIREMENT_ORDER.indexOf(kind.requirement ?? 'trust') < REQUIREMENT_ORDER.indexOf(o.requirement ?? 'trust')) w(p, `requirement relaxed ${o.requirement ?? 'trust'} → ${kind.requirement ?? 'trust'}`);
      const ov = new Set((o.verify ?? []).map((v) => canonicalJson(v)));
      const nv = new Set((kind.verify ?? []).map((v) => canonicalJson(v)));
      for (const v of ov) if (!nv.has(v)) w(p, 'a verify check removed');
      for (const v of nv) if (!ov.has(v)) n(p, 'a verify check added');
    }
  }
  const pp = byName(prev.provides, (p) => p.interface);
  for (const p of next.provides ?? []) {
    const o = pp.get(p.interface);
    if (!o) { w(`provides.${p.interface}`, 'interface range added'); continue; }
    for (const r of p.resources) if (!o.resources.includes(r)) w(`provides.${p.interface}.resources`, `resource ${r} added`);
    for (const [op, impl] of Object.entries(p.operations)) {
      if (canonicalJson(impl) !== canonicalJson(o.operations[op] ?? null)) w(`provides.${p.interface}.operations.${op}`, 'implementation changed');
    }
    for (const [op, cls] of Object.entries(o.class ?? {})) {
      const nc = p.class?.[op];
      if (!nc || rank(nc) < rank(cls)) w(`provides.${p.interface}.class.${op}`, `provider raise removed or lowered (${cls} → ${nc ?? 'none'})`);
    }
  }
  const setOf = <T>(xs: T[] | undefined, k: (x: T) => string) => new Set((xs ?? []).map(k));
  const added = <T>(label: string, a: T[] | undefined, b: T[] | undefined, k: (x: T) => string) => {
    const old = setOf(a, k);
    for (const x of b ?? []) if (!old.has(k(x))) w(label, `${k(x)} added`);
  };
  added('egress', prev.egress, next.egress, (e) => e.host);
  added('secrets', prev.secrets, next.secrets, (s) => `${s.slot}:${s.inject}`);
  added('dataSharing', prev.dataSharing, next.dataSharing, (d) => `${d.category}→${d.to}:${d.when}`);
  added('identity', prev.identity, next.identity, (i) => `${i.header}:${i.value}`);
  added('connections', prev.connections, next.connections, (c) => canonicalJson(c));
  added('tools', prev.tools?.items, next.tools?.items, (t) => `${t.name}#${t.definitionHash}`);
  added('runtime', prev.runtime, next.runtime, (r) => canonicalJson(r));
  const oldPolicies = setOf(prev.policies, (p) => canonicalJson(p));
  const newPolicies = setOf(next.policies, (p) => canonicalJson(p));
  for (const p of oldPolicies) if (!newPolicies.has(p)) w('policies', 'a requested policy removed or weakened');
  for (const p of newPolicies) if (!oldPolicies.has(p)) n('policies', 'a requested policy added');
  for (const k of ['callsPerMinute', 'concurrent', 'maxCostPerCallUsd', 'computeMinutesPerDay'] as const) {
    const a = prev.budgets?.[k], b = next.budgets?.[k];
    if (b !== undefined && (a === undefined || b > a)) w(`budgets.${k}`, `raised ${a ?? 'unset'} → ${b}`);
    else if (a !== undefined && b !== undefined && b < a) n(`budgets.${k}`, `lowered ${a} → ${b}`);
  }
  for (const k of ['skills', 'rolePacks', 'playbooks'] as const) added(k, prev[k], next[k], (x) => x);
  if (canonicalJson(prev.requires) !== canonicalJson(next.requires)) n('requires', 'requirements changed');
  return out;
}

export function isWidening(diff: DiffEntry[]): boolean {
  return diff.some((d) => d.widening);
}
