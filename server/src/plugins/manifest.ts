/**
 * Plugin manifest v1 (`plugin.json`, docs/plugins.md §3): the types and the
 * strict validator for all three roles — interface, provider, consumer.
 *
 * Rules the validator holds (§3.2):
 *  - **strict where it matters**: unknown keys are errors inside the
 *    security-relevant blocks (interfaces, provides, requires, connections,
 *    tools, events, egress, secrets, policies, runtime, dataSharing,
 *    identity, finalizers, setup, guards, budgets, verifies); unknown
 *    top-level descriptive keys are warnings;
 *  - **roles match the fields present**;
 *  - **no expressions and no code in config**: templates are plain
 *    references, matches use the declarative language of template.ts, and a
 *    YAML-style `!!` tag or a `$eval`/`$code` key anywhere refuses the
 *    manifest;
 *  - **bounded**: the manifest's size, every list and every string;
 *  - **text is linted**: semantics and descriptions that steer (name other
 *    tools or plugins, say "always", hide invisible Unicode or base64) are
 *    refused (T1, §5).
 *
 * Nothing here runs anything. Pure.
 */
import { ACTION_CLASSES, TOOL_CLASSES, isActionClass, type ActionClass } from '../actions/action-classes';
import { checkSchema, type JsonSchema } from './json-schema';
import { isRange, isVersion, parseInterfaceRef } from './semver';
import { checkMatchExpr, checkTemplates, isPath, parseDuration } from './template';

export const MANIFEST_VERSION = 1;
/** The core plugin API this server implements (§7.3). */
export const CORE_API_VERSION = '1.0.0';
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const INTERFACE_MAX_BYTES = 256 * 1024;

export type Role = 'interface' | 'provider' | 'consumer';
export const ROLES: readonly Role[] = ['interface', 'provider', 'consumer'];
export type Reversibility = 'none' | 'reversible' | 'costly' | 'irreversible';
export type KindReversibility = 'reversible' | 'costly' | 'irreversible';
export type ChangeRole = 'propose' | 'update' | 'review' | 'apply' | 'rollback';
export type Requirement = 'trust' | 'cosign' | 'two_key' | 'owner_key';
export const REQUIREMENTS: readonly Requirement[] = ['trust', 'cosign', 'two_key', 'owner_key'];
export type Tier = 'first_party' | 'verified' | 'community' | 'local';

export interface OperationDef {
  required: boolean;
  semantics: string;
  input: JsonSchema;
  output: JsonSchema;
  class: ActionClass;
  reversibility: Reversibility;
  outbound: boolean;
  movesMoney?: boolean;
  classByInput?: Array<{ path: string; equals?: unknown; in?: unknown[]; gt?: number; class: ActionClass }>;
  /** `verdict` (an addition of Phase 1): which output or input value of a
   *  review-role operation means "approve"; without it any successful
   *  review counts as an approval. */
  change?: { kind: string; role: ChangeRole; verdict?: { path: string; approveIn: unknown[] } };
  idempotent: boolean;
  longRunning?: { completion: { event: string; match: string }; timeout: string };
  untrustedOutput: boolean;
  cost?: { unit: 'call' | 'minute'; usd: number };
}

export interface ChangeKindDef {
  semantics: string;
  reversibility: KindReversibility;
  bind: Record<string, JsonSchema>;
  verify?: Array<{ event: string; match: string; within: string }>;
  requirement?: 'trust' | 'cosign' | 'two_key';
}

export interface InterfaceDef {
  name: string;
  version: string;
  extends?: string;
  semantics: string;
  resources: { scheme: string; pattern: string; schema: JsonSchema };
  defs?: Record<string, JsonSchema>;
  operations: Record<string, OperationDef>;
  changeKinds?: Record<string, ChangeKindDef>;
  events?: Record<string, { semantics: string; payload: JsonSchema; correlates?: string }>;
  metrics?: Record<string, Record<string, unknown>>;
  uses?: string[];
  skills?: string[];
  playbooks?: string[];
  conformance: string;
}

export type HttpTemplate = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string;
  headers?: Record<string, string>; query?: Record<string, string>; body?: unknown;
  response?: { select?: string; maxBytes?: number };
};

/** How a provider implements one operation. `fixture` is the core's
 *  deterministic stub (Phase 1): first-party and local providers only. */
export type OperationImpl =
  | { http: HttpTemplate; inputMap?: Record<string, string>; outputMap?: Record<string, string> }
  | { mcp: { server: string; tool: string; definitionHash: string }; inputMap?: Record<string, string>; outputMap?: Record<string, string> }
  | { runtime: string; method: string }
  | { delegate: string }
  | { fixture: string };

export interface ProvidesDef {
  interface: string;
  resources: string[];
  operations: Record<string, OperationImpl>;
  events?: Record<string, string>;
  class?: Record<string, ActionClass>;
  conformance: { mode: 'mock' | 'test_org'; fixtures?: string; params?: Record<string, string> };
}

export interface ExtraToolDef {
  name: string; class: ActionClass; grant: 'read' | 'write'; connection?: string;
  output: 'untrusted' | 'structured'; definitionHash: string; impl: OperationImpl; semantics?: string;
  input?: JsonSchema;
}

export interface PolicyDef {
  match: { operation?: string; changeKind?: string; bind?: Record<string, string> };
  require: string;
  why: string;
}

// ---- contributions beyond tools (docs/plugins.md §3.8): skills, guidance, UI ----

/** Who a skill or a guidance note reaches: everyone, the chief of staff, the
 *  function heads, the company's members, or the members of one function. */
export type Audience = string;
export const AUDIENCE_RE = /^(all|chief|heads|members|function:[a-z][a-z-]{1,20})$/;
/** A skill file with an optional audience (the plain-string form reaches everyone). */
export type SkillRef = string | { path: string; audience?: Audience[] };
/** One guidance note: how and when to use the plugin's capabilities. Bounded and attributed. */
export interface GuidanceDef { id: string; title: string; text: string; audience: Audience[] }
export const GUIDANCE_NOTE_MAX = 480;
export const GUIDANCE_MAX_NOTES = 4;

/** Where declarative UI may appear: the company section dashboards, a task, project or agent panel. */
export const UI_SECTIONS = ['direction', 'operations', 'people', 'money', 'oversight'] as const;
export const UI_PANEL_PLACES = ['task', 'project', 'agent'] as const;
export type UiTone = 'neutral' | 'good' | 'warn' | 'bad';
export const UI_TONES: readonly UiTone[] = ['neutral', 'good', 'warn', 'bad'];
/** A read-only query: a `read`-class interface operation with templated input. */
export interface UiQuery { operation: string; input?: Record<string, unknown> }
export type UiView =
  | { kind: 'stats'; items: Array<{ label: string; value: string; unit?: string; tone?: UiTone; toneWhen?: { path: string; gt?: number; lt?: number; tone: UiTone } }> }
  | { kind: 'table'; rows: string; columns: Array<{ label: string; value: string }>; max?: number }
  | { kind: 'list'; items: string; title: string; subtitle?: string; badge?: string; link?: string; max?: number }
  | { kind: 'checklist'; items: string[] }
  | { kind: 'text'; value: string };
export interface UiCard { id: string; title: string; placement: typeof UI_SECTIONS[number]; query?: UiQuery; view: UiView; actions?: string[]; empty?: string }
export interface UiPanel { id: string; title: string; placement: typeof UI_PANEL_PLACES[number]; query?: UiQuery; view: UiView; actions?: string[]; empty?: string }
export interface UiPage { id: string; title: string; placement: typeof UI_SECTIONS[number]; summary: string; sections: Array<{ title?: string; query?: UiQuery; view: UiView }>; actions?: string[] }
export interface UiField { key: string; label: string; type: 'text' | 'number' | 'textarea' | 'select'; options?: string[]; required?: boolean }
export interface UiAction { id: string; title: string; operation: string; input?: Record<string, unknown>; fields?: UiField[]; confirm?: string }
export interface UiBadge { id: string; placement: typeof UI_PANEL_PLACES[number]; query: UiQuery; label: string; tone?: UiTone }
export interface UiContributions { cards?: UiCard[]; panels?: UiPanel[]; pages?: UiPage[]; actions?: UiAction[]; badges?: UiBadge[] }

export interface Manifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description?: string;
  homepage?: string;
  license?: string;
  version: string;
  publisher: { id: string; name: string; verifiedDomain?: string };
  roles: Role[];
  requires: { yaamCore: string; interfaces?: string[] };
  toolPrefix?: string;
  settings?: JsonSchema;
  interfaces?: InterfaceDef[];
  provides?: ProvidesDef[];
  tools?: { items: ExtraToolDef[] };
  connections?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  metrics?: Array<Record<string, unknown>>;
  verifies?: Array<{ changeKind: string; check: Record<string, unknown> }>;
  mirrors?: Array<Record<string, unknown>>;
  panels?: Array<Record<string, unknown>>;
  skills?: SkillRef[];
  rolePacks?: string[];
  playbooks?: string[];
  guidance?: GuidanceDef[];
  ui?: UiContributions;
  tunables?: Record<string, Record<string, unknown>>;
  policies?: PolicyDef[];
  egress?: Array<{ host: string; category: string }>;
  secrets?: Array<{ slot: string; description: string; kind: string; inject: 'proxy' | 'env' }>;
  dataSharing?: Array<{ category: string; to: string; when: 'operation' | 'ambient'; purpose: string }>;
  identity?: Array<{ header: string; value: string; static?: string }>;
  budgets?: { callsPerMinute?: number; concurrent?: number; maxCostPerCallUsd?: number; computeMinutesPerDay?: number };
  runtime?: Array<Record<string, unknown>>;
  environments?: Array<Record<string, unknown>>;
  setup?: Array<{ operation: string; input?: unknown; creates: string }>;
  finalizers?: Array<{ id: string; operation: string; resource: string }>;
  guards?: Array<{ id: string; runtime: string; operations: string[]; timeoutMs: number }>;
}

export type ValidationResult =
  | { ok: true; manifest: Manifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Prefixes and names the core owns: no interface or extra prefix may take them. */
export const RESERVED_NAMES = new Set([
  'fs', 'web', 'http', 'mcp', 'tool', 'skill', 'org', 'channel', 'meeting', 'meetings', 'computer', 'browser',
  'gmail', 'gcal', 'drive', 'msmail', 'mscal', 'msdrive', 'run', 'code', 'change', 'plugin', 'binding', 'trust',
  'follow', 'list', 'save', 'update', 'add', 'delegate', 'draft', 'revise', 'search', 'set', 'slides', 'core', 'yaam',
]);

const ID_RE = /^([a-z0-9-]{2,40})@([a-z0-9-]{2,40})$/;
const NAME_RE = /^[a-z][a-z0-9]{1,15}$/;
const OP_RE = /^[a-z][a-z0-9_]{0,39}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
const HOST_RE = /^(\*\.)?([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const DATA_CATEGORIES = ['code', 'issue_text', 'logs', 'customer_pii', 'payment', 'conversation', 'usage', 'telemetry'];
const IDENTITY_VALUES = ['install_id', 'workspace_slug', 'yaam_version', 'static'];
const MAX_TEXT = 2_000;
const MAX_LIST = 200;

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|\uDB40[\uDC00-\uDFFF]/;
const BASE64_RUN_RE = /[A-Za-z0-9+/]{48,}={0,2}/;
const PLUGIN_ID_IN_TEXT_RE = /\b[a-z0-9-]{2,40}@[a-z0-9-]{2,40}\b/;
const CORE_TOOL_RE = new RegExp(`\\b(${[...Object.keys(TOOL_CLASSES).filter((k) => k.includes('_')), 'mcp_[a-z0-9_]+', 'tool_[a-z0-9_]+', 'skill_[a-z0-9_]+'].join('|')})\\b`);

/** The steering lint (T1): text shown to agents may describe, never steer. */
export function lintText(text: string): string[] {
  const out: string[] = [];
  if (INVISIBLE_RE.test(text)) out.push('carries invisible Unicode');
  if (BASE64_RUN_RE.test(text)) out.push('carries a base64-like run');
  if (/\balways\b/i.test(text)) out.push('says "always" (text may describe, never steer)');
  if (PLUGIN_ID_IN_TEXT_RE.test(text)) out.push('names a plugin');
  if (CORE_TOOL_RE.test(text)) out.push('names a core tool');
  if (/\b(ignore|disregard) (all |any |the )?(previous|prior|above)\b/i.test(text)) out.push('reads like an injected instruction');
  return out;
}

/** Walks a value for code-shaped config: `!!` tags, `$eval`/`$code` keys. */
function codeShaped(v: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 40) { out.push(`${path}: nested deeper than 40`); return; }
  if (typeof v === 'string') {
    if (v.trimStart().startsWith('!!')) out.push(`${path}: "!!" tags are code, not config`);
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => codeShaped(x, `${path}[${i}]`, out, depth + 1)); return; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (/^(\$eval|\$code|\$function|!!)/i.test(k)) out.push(`${path}.${k}: code-shaped keys are not allowed`);
      codeShaped(x, `${path}.${k}`, out, depth + 1);
    }
  }
}

class Checker {
  errors: string[] = [];
  warnings: string[] = [];
  err(path: string, msg: string): void { this.errors.push(`${path}: ${msg}`); }
  isObj(v: unknown): v is Record<string, unknown> { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
  /** An object with only `allowed` keys (unknown keys are errors here). */
  strict(path: string, v: unknown, allowed: string[], required: string[] = []): v is Record<string, unknown> {
    if (!this.isObj(v)) { this.err(path, 'must be an object'); return false; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.err(`${path}.${k}`, 'unknown key');
    for (const k of required) if (v[k] === undefined) this.err(`${path}.${k}`, 'required');
    return true;
  }
  str(path: string, v: unknown, opts: { max?: number; re?: RegExp; optional?: boolean; lint?: boolean } = {}): v is string {
    if (v === undefined && opts.optional) return false;
    if (typeof v !== 'string' || v.length === 0) { this.err(path, 'must be a non-empty string'); return false; }
    if (v.length > (opts.max ?? MAX_TEXT)) { this.err(path, `longer than ${opts.max ?? MAX_TEXT} characters`); return false; }
    if (opts.re && !opts.re.test(v)) { this.err(path, `does not match ${opts.re}`); return false; }
    if (opts.lint) for (const l of lintText(v)) this.err(path, `refused by the steering lint: ${l}`);
    return true;
  }
  bool(path: string, v: unknown, optional = false): void {
    if (v === undefined && optional) return;
    if (typeof v !== 'boolean') this.err(path, 'must be true or false');
  }
  num(path: string, v: unknown, min: number, max: number, optional = true): void {
    if (v === undefined && optional) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) this.err(path, `must be a number in [${min}, ${max}]`);
  }
  oneOf<T extends string>(path: string, v: unknown, values: readonly T[], optional = false): v is T {
    if (v === undefined && optional) return false;
    if (typeof v !== 'string' || !values.includes(v as T)) { this.err(path, `must be one of ${values.join(', ')}`); return false; }
    return true;
  }
  list(path: string, v: unknown, optional = true, max = MAX_LIST): v is unknown[] {
    if (v === undefined && optional) return false;
    if (!Array.isArray(v)) { this.err(path, 'must be a list'); return false; }
    if (v.length > max) { this.err(path, `more than ${max} entries`); return false; }
    return true;
  }
  strList(path: string, v: unknown, re?: RegExp, optional = true): void {
    if (!this.list(path, v, optional)) return;
    (v as unknown[]).forEach((x, i) => this.str(`${path}[${i}]`, x, { re, max: 300 }));
  }
  schema(path: string, v: unknown, defs?: Record<string, unknown>): void {
    for (const e of checkSchema(v, '', 0, defs)) this.err(path, e);
  }
  relPath(path: string, v: unknown, optional = false): void {
    if (v === undefined && optional) return;
    if (!this.str(path, v, { max: 200 })) return;
    const p = v as string;
    if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '') || /\\/.test(p)) this.err(path, 'must be a relative path inside the plugin');
  }
}

function checkOperation(c: Checker, path: string, op: unknown, kinds: Record<string, unknown>, defs?: Record<string, unknown>): void {
  if (!c.strict(path, op, ['required', 'semantics', 'input', 'output', 'class', 'reversibility', 'outbound', 'movesMoney', 'classByInput', 'change', 'idempotent', 'longRunning', 'untrustedOutput', 'cost'],
    ['required', 'semantics', 'input', 'output', 'reversibility', 'outbound', 'idempotent', 'untrustedOutput'])) return;
  c.bool(`${path}.required`, op.required);
  c.str(`${path}.semantics`, op.semantics, { lint: true, max: 1_000 });
  c.schema(`${path}.input`, op.input, defs);
  c.schema(`${path}.output`, op.output, defs);
  // A missing class is not an error: the core's floor treats it as undeclared (§4.3).
  if (op.class !== undefined) c.oneOf(`${path}.class`, op.class, ACTION_CLASSES);
  c.oneOf(`${path}.reversibility`, op.reversibility, ['none', 'reversible', 'costly', 'irreversible'] as const);
  c.bool(`${path}.outbound`, op.outbound);
  c.bool(`${path}.movesMoney`, op.movesMoney, true);
  c.bool(`${path}.idempotent`, op.idempotent);
  c.bool(`${path}.untrustedOutput`, op.untrustedOutput);
  if (c.list(`${path}.classByInput`, op.classByInput, true, 20)) {
    (op.classByInput as unknown[]).forEach((r, i) => {
      const p = `${path}.classByInput[${i}]`;
      if (!c.strict(p, r, ['path', 'equals', 'in', 'gt', 'class'], ['path', 'class'])) return;
      if (!isPath(r.path)) c.err(`${p}.path`, 'must be a $-path');
      c.oneOf(`${p}.class`, r.class, ACTION_CLASSES);
      if (r.in !== undefined) c.list(`${p}.in`, r.in, false, 50);
      c.num(`${p}.gt`, r.gt, -1e12, 1e12);
      for (const e of checkTemplates(r.equals)) c.err(`${p}.equals`, e);
    });
  }
  if (op.change !== undefined && c.strict(`${path}.change`, op.change, ['kind', 'role', 'verdict'], ['kind', 'role'])) {
    const ch = op.change;
    if (c.str(`${path}.change.kind`, ch.kind, { re: KIND_RE }) && !(String(ch.kind) in kinds)) c.err(`${path}.change.kind`, `no change kind named ${String(ch.kind)} in this interface`);
    c.oneOf(`${path}.change.role`, ch.role, ['propose', 'update', 'review', 'apply', 'rollback'] as const);
    if (ch.verdict !== undefined && c.strict(`${path}.change.verdict`, ch.verdict, ['path', 'approveIn'], ['path', 'approveIn'])) {
      if (!isPath(ch.verdict.path)) c.err(`${path}.change.verdict.path`, 'must be a $-path');
      c.list(`${path}.change.verdict.approveIn`, ch.verdict.approveIn, false, 20);
    }
  }
  if (op.longRunning !== undefined && c.strict(`${path}.longRunning`, op.longRunning, ['completion', 'timeout'], ['completion', 'timeout'])) {
    const lr = op.longRunning;
    if (c.strict(`${path}.longRunning.completion`, lr.completion, ['event', 'match'], ['event', 'match'])) {
      const comp = lr.completion as Record<string, unknown>;
      c.str(`${path}.longRunning.completion.event`, comp.event, { re: EVENT_RE });
      for (const e of checkMatchExpr(comp.match)) c.err(`${path}.longRunning.completion.match`, e);
    }
    if (parseDuration(lr.timeout) === null) c.err(`${path}.longRunning.timeout`, 'must be a duration like 30m');
  }
  if (op.cost !== undefined && c.strict(`${path}.cost`, op.cost, ['unit', 'usd'], ['unit', 'usd'])) {
    c.oneOf(`${path}.cost.unit`, op.cost.unit, ['call', 'minute'] as const);
    c.num(`${path}.cost.usd`, op.cost.usd, 0, 100, false);
  }
}

function checkInterface(c: Checker, path: string, iface: unknown): void {
  if (!c.strict(path, iface, ['name', 'version', 'extends', 'semantics', 'resources', 'defs', 'operations', 'changeKinds', 'events', 'metrics', 'uses', 'skills', 'playbooks', 'conformance'],
    ['name', 'version', 'semantics', 'resources', 'operations', 'conformance'])) return;
  if (c.str(`${path}.name`, iface.name, { re: NAME_RE }) && RESERVED_NAMES.has(iface.name as string)) c.err(`${path}.name`, 'is a name the core owns');
  if (!isVersion(iface.version)) c.err(`${path}.version`, 'must be a semver x.y.z');
  if (iface.extends !== undefined && !parseInterfaceRef(String(iface.extends))) c.err(`${path}.extends`, 'must be name@range');
  c.str(`${path}.semantics`, iface.semantics, { lint: true, max: 1_000 });
  if (c.strict(`${path}.resources`, iface.resources, ['scheme', 'pattern', 'schema'], ['scheme', 'pattern', 'schema'])) {
    const r = iface.resources as Record<string, unknown>;
    c.str(`${path}.resources.scheme`, r.scheme, { re: /^[a-z][a-z0-9]{1,15}$/ });
    c.str(`${path}.resources.pattern`, r.pattern, { max: 200 });
    c.schema(`${path}.resources.schema`, r.schema);
  }
  let defs: Record<string, unknown> | undefined;
  if (iface.defs !== undefined) {
    if (!c.isObj(iface.defs)) c.err(`${path}.defs`, 'must be an object');
    else {
      defs = iface.defs;
      for (const [k, s] of Object.entries(iface.defs)) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) c.err(`${path}.defs.${k}`, 'bad name');
        c.schema(`${path}.defs.${k}`, s, iface.defs);
      }
    }
  }
  const kinds: Record<string, unknown> = c.isObj(iface.changeKinds) ? iface.changeKinds : {};
  if (iface.changeKinds !== undefined && !c.isObj(iface.changeKinds)) c.err(`${path}.changeKinds`, 'must be an object');
  for (const [k, kind] of Object.entries(kinds)) {
    const p = `${path}.changeKinds.${k}`;
    if (!KIND_RE.test(k)) c.err(p, 'bad kind name');
    if (!c.strict(p, kind, ['semantics', 'reversibility', 'bind', 'verify', 'requirement'], ['semantics', 'reversibility', 'bind'])) continue;
    c.str(`${p}.semantics`, kind.semantics, { lint: true, max: 1_000 });
    c.oneOf(`${p}.reversibility`, kind.reversibility, ['reversible', 'costly', 'irreversible'] as const);
    if (!c.isObj(kind.bind) || Object.keys(kind.bind).length === 0) c.err(`${p}.bind`, 'must name at least one field');
    else for (const [bk, bs] of Object.entries(kind.bind)) c.schema(`${p}.bind.${bk}`, bs, defs);
    if (kind.requirement !== undefined) c.oneOf(`${p}.requirement`, kind.requirement, ['trust', 'cosign', 'two_key'] as const);
    if (c.list(`${p}.verify`, kind.verify, true, 20)) {
      (kind.verify as unknown[]).forEach((v, i) => {
        if (!c.strict(`${p}.verify[${i}]`, v, ['event', 'match', 'within'], ['event', 'match', 'within'])) return;
        c.str(`${p}.verify[${i}].event`, v.event, { re: EVENT_RE });
        for (const e of checkMatchExpr(v.match)) c.err(`${p}.verify[${i}].match`, e);
        if (parseDuration(v.within) === null) c.err(`${p}.verify[${i}].within`, 'must be a duration like 45m');
      });
    }
  }
  if (!c.isObj(iface.operations) || Object.keys(iface.operations).length === 0) c.err(`${path}.operations`, 'must declare at least one operation');
  else {
    if (Object.keys(iface.operations).length > 100) c.err(`${path}.operations`, 'more than 100 operations');
    for (const [name, op] of Object.entries(iface.operations)) {
      if (!OP_RE.test(name)) c.err(`${path}.operations.${name}`, 'bad operation name');
      checkOperation(c, `${path}.operations.${name}`, op, kinds, defs);
    }
  }
  if (iface.events !== undefined) {
    if (!c.isObj(iface.events)) c.err(`${path}.events`, 'must be an object');
    else for (const [name, ev] of Object.entries(iface.events)) {
      const p = `${path}.events.${name}`;
      if (!EVENT_RE.test(name)) c.err(p, 'bad event name');
      if (!c.strict(p, ev, ['semantics', 'payload', 'correlates'], ['semantics', 'payload'])) continue;
      c.str(`${p}.semantics`, ev.semantics, { lint: true, max: 1_000 });
      c.schema(`${p}.payload`, ev.payload, defs);
      c.str(`${p}.correlates`, ev.correlates, { optional: true, max: 40 });
    }
  }
  if (iface.metrics !== undefined) {
    if (!c.isObj(iface.metrics)) c.err(`${path}.metrics`, 'must be an object');
    else for (const [name, m] of Object.entries(iface.metrics)) {
      const p = `${path}.metrics.${name}`;
      if (!c.strict(p, m, ['kind', 'of', 'and', 'correlateBy', 'window', 'unit', 'where'], ['kind', 'of', 'window', 'unit'])) continue;
      c.oneOf(`${p}.kind`, m.kind, ['count', 'rate', 'duration_between', 'ratio'] as const);
      if (parseDuration(m.window) === null) c.err(`${p}.window`, 'must be a duration like 7d');
    }
  }
  if (iface.uses !== undefined) c.strList(`${path}.uses`, iface.uses);
  for (const k of ['skills', 'playbooks'] as const) if (c.list(`${path}.${k}`, iface[k])) (iface[k] as unknown[]).forEach((x, i) => c.relPath(`${path}.${k}[${i}]`, x));
  c.relPath(`${path}.conformance`, iface.conformance);
  for (const u of Array.isArray(iface.uses) ? iface.uses : []) if (!parseInterfaceRef(String(u))) c.err(`${path}.uses`, `${String(u)} must be name@range`);
}

function checkImpl(c: Checker, path: string, impl: unknown, egress: Set<string>): void {
  if (!c.isObj(impl)) { c.err(path, 'must be an object'); return; }
  const kinds = ['http', 'mcp', 'runtime', 'delegate', 'fixture'].filter((k) => impl[k] !== undefined);
  if (kinds.length !== 1) { c.err(path, 'must have exactly one of http, mcp, runtime, delegate, fixture'); return; }
  const kind = kinds[0];
  if (kind === 'http') {
    if (!c.strict(path, impl, ['http', 'inputMap', 'outputMap'], ['http'])) return;
    if (!c.strict(`${path}.http`, impl.http, ['method', 'url', 'headers', 'query', 'body', 'response'], ['method', 'url'])) return;
    const h = impl.http as Record<string, unknown>;
    c.oneOf(`${path}.http.method`, h.method, ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const);
    if (c.str(`${path}.http.url`, h.url, { max: 1_000 })) {
      const m = /^https:\/\/([^/{}?#]+)/.exec(String(h.url));
      if (!m) c.err(`${path}.http.url`, 'must be https with a literal host');
      else if (![...egress].some((e) => e === m[1] || (e.startsWith('*.') && m[1].endsWith(e.slice(1))))) c.err(`${path}.http.url`, `host ${m[1]} is not in egress`);
    }
    if (h.headers !== undefined && c.isObj(h.headers)) {
      for (const [k, v] of Object.entries(h.headers)) {
        if (typeof v !== 'string') { c.err(`${path}.http.headers.${k}`, 'must be a string'); continue; }
        if (/authorization|token|key|secret|cookie/i.test(k) && !/^[^{}]*\{\{(secret|connection):[A-Za-z0-9_-]+\}\}[^{}]*$/.test(v)) c.err(`${path}.http.headers.${k}`, 'credentials only as {{secret:SLOT}} or {{connection:ID}}');
      }
    }
    for (const e of checkTemplates(h)) c.err(`${path}.http`, e);
    if (h.response !== undefined && c.strict(`${path}.http.response`, h.response, ['select', 'maxBytes'])) {
      c.num(`${path}.http.response.maxBytes`, (h.response as Record<string, unknown>).maxBytes, 1, 5_000_000);
    }
  } else if (kind === 'mcp') {
    if (!c.strict(path, impl, ['mcp', 'inputMap', 'outputMap'], ['mcp'])) return;
    if (c.strict(`${path}.mcp`, impl.mcp, ['server', 'tool', 'definitionHash'], ['server', 'tool', 'definitionHash'])) {
      const m = impl.mcp as Record<string, unknown>;
      c.str(`${path}.mcp.server`, m.server, { max: 80 });
      c.str(`${path}.mcp.tool`, m.tool, { max: 80 });
      c.str(`${path}.mcp.definitionHash`, m.definitionHash, { re: /^sha256:[0-9a-f…]{4,64}$/ });
    }
  } else if (kind === 'runtime') {
    if (!c.strict(path, impl, ['runtime', 'method'], ['runtime', 'method'])) return;
    c.str(`${path}.runtime`, impl.runtime, { max: 40 });
    c.str(`${path}.method`, impl.method, { max: 80 });
  } else if (kind === 'delegate') {
    if (!c.strict(path, impl, ['delegate'], ['delegate'])) return;
    c.str(`${path}.delegate`, impl.delegate, { re: /^[a-z][a-z0-9]{1,15}@[^.]+\.[a-z][a-z0-9_]*$/ });
  } else {
    if (!c.strict(path, impl, ['fixture'], ['fixture'])) return;
    c.relPath(`${path}.fixture`, impl.fixture);
  }
}

function checkProvides(c: Checker, path: string, p: unknown, egress: Set<string>): void {
  if (!c.strict(path, p, ['interface', 'resources', 'operations', 'events', 'class', 'conformance'], ['interface', 'resources', 'operations', 'conformance'])) return;
  if (!parseInterfaceRef(String(p.interface))) c.err(`${path}.interface`, 'must be name@range');
  c.strList(`${path}.resources`, p.resources, /^[a-z][a-z0-9]{1,15}:\/\/[^\s]{1,200}$/, false);
  if (!c.isObj(p.operations)) c.err(`${path}.operations`, 'must be an object');
  else for (const [op, impl] of Object.entries(p.operations)) {
    if (!OP_RE.test(op)) c.err(`${path}.operations.${op}`, 'bad operation name');
    checkImpl(c, `${path}.operations.${op}`, impl, egress);
  }
  if (p.events !== undefined && c.isObj(p.events)) for (const [k, v] of Object.entries(p.events)) {
    if (!EVENT_RE.test(k)) c.err(`${path}.events.${k}`, 'bad event name');
    c.str(`${path}.events.${k}`, v, { max: 80 });
  }
  if (p.class !== undefined) {
    if (!c.isObj(p.class)) c.err(`${path}.class`, 'must be an object');
    else for (const [k, v] of Object.entries(p.class)) if (!isActionClass(v)) c.err(`${path}.class.${k}`, `must be one of ${ACTION_CLASSES.join(', ')}`);
  }
  if (c.strict(`${path}.conformance`, p.conformance, ['mode', 'fixtures', 'params'], ['mode'])) {
    const conf = p.conformance as Record<string, unknown>;
    c.oneOf(`${path}.conformance.mode`, conf.mode, ['mock', 'test_org'] as const);
    if (conf.fixtures !== undefined) c.str(`${path}.conformance.fixtures`, conf.fixtures, { max: 200 });
    if (conf.params !== undefined) {
      if (!c.isObj(conf.params)) c.err(`${path}.conformance.params`, 'must be an object');
      else for (const [k, v] of Object.entries(conf.params)) c.str(`${path}.conformance.params.${k}`, v, { max: 200 });
    }
  }
}

const TOP_KEYS = [
  'manifestVersion', 'id', 'name', 'description', 'homepage', 'license', 'version', 'publisher', 'roles', 'requires',
  'toolPrefix', 'settings', 'interfaces', 'provides', 'tools', 'connections', 'events', 'metrics', 'verifies', 'mirrors',
  'panels', 'skills', 'rolePacks', 'playbooks', 'tunables', 'policies', 'egress', 'secrets', 'dataSharing', 'identity',
  'budgets', 'runtime', 'environments', 'setup', 'finalizers', 'guards', 'guidance', 'ui',
];

function checkAudience(c: Checker, path: string, v: unknown): void {
  if (!c.list(path, v, false, 8)) return;
  if ((v as unknown[]).length === 0) c.err(path, 'names at least one audience');
  (v as unknown[]).forEach((a, i) => c.str(`${path}[${i}]`, a, { re: AUDIENCE_RE, max: 40 }));
}

const UI_ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const UI_OP_RE = /^([a-z][a-z0-9]{1,15})\.([a-z][a-z0-9_]{0,39})$/;
/** A UI input value: a literal, or exactly one `{{context.x}}`, `{{field.x}}` or `{{settings.x}}`. */
const UI_TEMPLATE_RE = /^\{\{\s*(context|field|settings)\.[A-Za-z_][A-Za-z0-9_]{0,40}\s*\}\}$/;
/** The context keys a placement provides to templates. */
export const UI_CONTEXT_KEYS: Record<string, string[]> = {
  task: ['taskKey', 'taskTitle', 'projectKey'], project: ['projectKey', 'projectTitle'], agent: ['agentName', 'agentTitle'],
  direction: [], operations: [], people: [], money: [], oversight: [],
};
const ALL_CONTEXT_KEYS = [...new Set(Object.values(UI_CONTEXT_KEYS).flat())];

/** Guidance notes (plugins and kits): bounded, linted, attributed by the core. */
function checkGuidance(c: Checker, path: string, v: unknown): void {
  if (!c.list(path, v, true, GUIDANCE_MAX_NOTES)) return;
  const ids = new Set<string>();
  (v as unknown[]).forEach((g, i) => {
    const p = `${path}[${i}]`;
    if (!c.strict(p, g, ['id', 'title', 'text', 'audience'], ['id', 'title', 'text', 'audience'])) return;
    if (c.str(`${p}.id`, g.id, { re: UI_ID_RE })) { if (ids.has(g.id as string)) c.err(`${p}.id`, 'repeats an id'); ids.add(g.id as string); }
    c.str(`${p}.title`, g.title, { max: 80, lint: true });
    c.str(`${p}.text`, g.text, { max: GUIDANCE_NOTE_MAX, lint: true });
    checkAudience(c, `${p}.audience`, g.audience);
  });
}

/** A kit's (or any package's) guidance list, validated alone. */
export function validateGuidance(raw: unknown, path = 'guidance'): string[] {
  const c = new Checker();
  checkGuidance(c, path, raw);
  return c.errors;
}

interface UiScope { interfaces: Set<string>; own: Map<string, InterfaceDef> }
function uiScope(m: Record<string, unknown>): UiScope {
  const own = new Map<string, InterfaceDef>();
  for (const i of Array.isArray(m.interfaces) ? m.interfaces as InterfaceDef[] : []) if (i && typeof i.name === 'string') own.set(i.name, i);
  const req = (m.requires as { interfaces?: unknown[] } | undefined)?.interfaces ?? [];
  const names = new Set<string>([...own.keys(), ...(Array.isArray(req) ? req : []).map((r) => parseInterfaceRef(String(r))?.name ?? '').filter(Boolean)]);
  return { interfaces: names, own };
}

function checkUiInput(c: Checker, path: string, v: unknown, keys: string[], fields?: string[]): void {
  if (v === undefined) return;
  if (!c.isObj(v)) { c.err(path, 'must be an object'); return; }
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && x.includes('{{')) {
      if (!UI_TEMPLATE_RE.test(x)) { c.err(`${path}.${k}`, 'a template is exactly one {{context.x}}, {{field.x}} or {{settings.x}}'); continue; }
      const ctx = /\{\{\s*context\.([A-Za-z_][A-Za-z0-9_]*)/.exec(x);
      if (ctx && !keys.includes(ctx[1])) c.err(`${path}.${k}`, `context.${ctx[1]} is not provided here (${keys.join(', ') || 'no context'})`);
      const fld = /\{\{\s*field\.([A-Za-z_][A-Za-z0-9_]*)/.exec(x);
      if (fld && !(fields ?? []).includes(fld[1])) c.err(`${path}.${k}`, `field.${fld[1]} is not a declared field`);
    } else if (x !== null && typeof x === 'object') c.err(`${path}.${k}`, 'must be a literal or a template');
  }
}

function checkUiOp(c: Checker, path: string, op: unknown, scope: UiScope, read: boolean): void {
  if (!c.str(path, op, { re: UI_OP_RE, max: 60 })) return;
  const [, iface, name] = UI_OP_RE.exec(op as string)!;
  if (!scope.interfaces.has(iface)) { c.err(path, `${iface} is neither defined by this package nor in requires.interfaces`); return; }
  const def = scope.own.get(iface)?.operations?.[name];
  if (scope.own.has(iface) && !def) { c.err(path, `${iface} has no operation ${name}`); return; }
  if (def && read && def.class !== 'read') c.err(path, `${op as string} is not a read operation; queries are read-only`);
  if (def && !read && (def.change?.role === 'apply' || def.change?.role === 'rollback')) c.err(path, `${op as string} applies or rolls back a change record; UI actions may not`);
}

function checkView(c: Checker, path: string, v: unknown): void {
  if (!c.isObj(v)) { c.err(path, 'must be an object'); return; }
  const p = (k: string, x: unknown, optional = false) => { if (x === undefined && optional) return; if (!isPath(x)) c.err(`${path}.${k}`, 'must be a $-path'); };
  if (v.kind === 'stats') {
    if (!c.strict(path, v, ['kind', 'items'], ['kind', 'items']) || !c.list(`${path}.items`, v.items, false, 8)) return;
    (v.items as unknown[]).forEach((it, i) => {
      const q = `${path}.items[${i}]`;
      if (!c.strict(q, it, ['label', 'value', 'unit', 'tone', 'toneWhen'], ['label', 'value'])) return;
      c.str(`${q}.label`, it.label, { max: 40, lint: true });
      if (!isPath(it.value)) c.err(`${q}.value`, 'must be a $-path');
      c.str(`${q}.unit`, it.unit, { optional: true, max: 12 });
      if (it.tone !== undefined) c.oneOf(`${q}.tone`, it.tone, UI_TONES);
      if (it.toneWhen !== undefined && c.strict(`${q}.toneWhen`, it.toneWhen, ['path', 'gt', 'lt', 'tone'], ['path', 'tone'])) {
        const tw = it.toneWhen as Record<string, unknown>;
        if (!isPath(tw.path)) c.err(`${q}.toneWhen.path`, 'must be a $-path');
        c.num(`${q}.toneWhen.gt`, tw.gt, -1e12, 1e12);
        c.num(`${q}.toneWhen.lt`, tw.lt, -1e12, 1e12);
        c.oneOf(`${q}.toneWhen.tone`, tw.tone, UI_TONES);
      }
    });
  } else if (v.kind === 'table') {
    if (!c.strict(path, v, ['kind', 'rows', 'columns', 'max'], ['kind', 'rows', 'columns'])) return;
    p('rows', v.rows);
    c.num(`${path}.max`, v.max, 1, 50);
    if (c.list(`${path}.columns`, v.columns, false, 6)) (v.columns as unknown[]).forEach((col, i) => {
      if (!c.strict(`${path}.columns[${i}]`, col, ['label', 'value'], ['label', 'value'])) return;
      c.str(`${path}.columns[${i}].label`, col.label, { max: 40, lint: true });
      if (!isPath(col.value)) c.err(`${path}.columns[${i}].value`, 'must be a $-path (relative to the row)');
    });
  } else if (v.kind === 'list') {
    if (!c.strict(path, v, ['kind', 'items', 'title', 'subtitle', 'badge', 'link', 'max'], ['kind', 'items', 'title'])) return;
    p('items', v.items); p('title', v.title); p('subtitle', v.subtitle, true); p('badge', v.badge, true); p('link', v.link, true);
    c.num(`${path}.max`, v.max, 1, 50);
  } else if (v.kind === 'checklist') {
    if (!c.strict(path, v, ['kind', 'items'], ['kind', 'items']) || !c.list(`${path}.items`, v.items, false, 20)) return;
    (v.items as unknown[]).forEach((x, i) => c.str(`${path}.items[${i}]`, x, { max: 200, lint: true }));
  } else if (v.kind === 'text') {
    if (!c.strict(path, v, ['kind', 'value'], ['kind', 'value'])) return;
    p('value', v.value);
  } else c.err(`${path}.kind`, 'must be one of stats, table, list, checklist, text');
}

/** The declarative UI block (docs/plugins.md §3.8): extension points, never code. */
function checkUi(c: Checker, path: string, raw: unknown, scope: UiScope): void {
  if (!c.strict(path, raw, ['cards', 'panels', 'pages', 'actions', 'badges'])) return;
  const ui = raw;
  const ids = new Set<string>();
  const id = (q: string, x: unknown) => { if (c.str(q, x, { re: UI_ID_RE })) { if (ids.has(x as string)) c.err(q, 'repeats an id'); ids.add(x as string); } };
  const actionIds = new Set<string>();
  if (c.list(`${path}.actions`, ui.actions, true, 20)) (ui.actions as unknown[]).forEach((a, i) => {
    const q = `${path}.actions[${i}]`;
    if (!c.strict(q, a, ['id', 'title', 'operation', 'input', 'fields', 'confirm'], ['id', 'title', 'operation'])) return;
    id(`${q}.id`, a.id);
    if (typeof a.id === 'string') actionIds.add(a.id);
    c.str(`${q}.title`, a.title, { max: 40, lint: true });
    c.str(`${q}.confirm`, a.confirm, { optional: true, max: 200, lint: true });
    checkUiOp(c, `${q}.operation`, a.operation, scope, false);
    const fieldKeys: string[] = [];
    if (c.list(`${q}.fields`, a.fields, true, 8)) (a.fields as unknown[]).forEach((f, j) => {
      const r = `${q}.fields[${j}]`;
      if (!c.strict(r, f, ['key', 'label', 'type', 'options', 'required'], ['key', 'label', 'type'])) return;
      if (c.str(`${r}.key`, f.key, { re: /^[A-Za-z_][A-Za-z0-9_]{0,40}$/ })) fieldKeys.push(f.key as string);
      c.str(`${r}.label`, f.label, { max: 60, lint: true });
      c.oneOf(`${r}.type`, f.type, ['text', 'number', 'textarea', 'select'] as const);
      if (f.options !== undefined) c.strList(`${r}.options`, f.options);
      c.bool(`${r}.required`, f.required, true);
    });
    checkUiInput(c, `${q}.input`, a.input, ALL_CONTEXT_KEYS, fieldKeys);
  });
  const refsActions = (q: string, v: unknown) => {
    if (!c.list(q, v, true, 4)) return;
    (v as unknown[]).forEach((x, i) => { if (typeof x !== 'string' || !actionIds.has(x)) c.err(`${q}[${i}]`, 'names no declared action'); });
  };
  const query = (q: string, v: unknown, keys: string[], optional: boolean) => {
    if (v === undefined) { if (!optional) c.err(q, 'required'); return; }
    if (!c.strict(q, v, ['operation', 'input'], ['operation'])) return;
    checkUiOp(c, `${q}.operation`, v.operation, scope, true);
    checkUiInput(c, `${q}.input`, v.input, keys);
  };
  const block = (key: 'cards' | 'panels', places: readonly string[]) => {
    if (!c.list(`${path}.${key}`, ui[key], true, 12)) return;
    (ui[key] as unknown[]).forEach((b, i) => {
      const q = `${path}.${key}[${i}]`;
      if (!c.strict(q, b, ['id', 'title', 'placement', 'query', 'view', 'actions', 'empty'], ['id', 'title', 'placement', 'view'])) return;
      id(`${q}.id`, b.id);
      c.str(`${q}.title`, b.title, { max: 60, lint: true });
      c.str(`${q}.empty`, b.empty, { optional: true, max: 200, lint: true });
      if (c.oneOf(`${q}.placement`, b.placement, places)) query(`${q}.query`, b.query, UI_CONTEXT_KEYS[b.placement as string] ?? [], true);
      checkView(c, `${q}.view`, b.view);
      if (c.isObj(b.view) && b.view.kind !== 'checklist' && b.query === undefined) c.err(`${q}.query`, 'a data view needs a query');
      refsActions(`${q}.actions`, b.actions);
    });
  };
  block('cards', UI_SECTIONS);
  block('panels', UI_PANEL_PLACES);
  if (c.list(`${path}.pages`, ui.pages, true, 6)) (ui.pages as unknown[]).forEach((pg, i) => {
    const q = `${path}.pages[${i}]`;
    if (!c.strict(q, pg, ['id', 'title', 'placement', 'summary', 'sections', 'actions'], ['id', 'title', 'placement', 'summary', 'sections'])) return;
    id(`${q}.id`, pg.id);
    c.str(`${q}.title`, pg.title, { max: 60, lint: true });
    c.str(`${q}.summary`, pg.summary, { max: 200, lint: true });
    c.oneOf(`${q}.placement`, pg.placement, UI_SECTIONS);
    if (c.list(`${q}.sections`, pg.sections, false, 6)) (pg.sections as unknown[]).forEach((sec, j) => {
      const r = `${q}.sections[${j}]`;
      if (!c.strict(r, sec, ['title', 'query', 'view'], ['view'])) return;
      c.str(`${r}.title`, sec.title, { optional: true, max: 60, lint: true });
      query(`${r}.query`, sec.query, [], true);
      checkView(c, `${r}.view`, sec.view);
    });
    refsActions(`${q}.actions`, pg.actions);
  });
  if (c.list(`${path}.badges`, ui.badges, true, 8)) (ui.badges as unknown[]).forEach((b, i) => {
    const q = `${path}.badges[${i}]`;
    if (!c.strict(q, b, ['id', 'placement', 'query', 'label', 'tone'], ['id', 'placement', 'query', 'label'])) return;
    id(`${q}.id`, b.id);
    if (c.oneOf(`${q}.placement`, b.placement, UI_PANEL_PLACES)) query(`${q}.query`, b.query, UI_CONTEXT_KEYS[b.placement as string] ?? [], false);
    if (!isPath(b.label)) c.err(`${q}.label`, 'must be a $-path');
    if (b.tone !== undefined) c.oneOf(`${q}.tone`, b.tone, UI_TONES);
  });
}

/**
 * Contribution conformance against the interfaces a workspace actually has
 * (the install review's blockers): every UI query names a `read` operation
 * and every action one that exists and neither applies nor rolls back a
 * change. Own interfaces were checked by the validator already.
 */
export function uiConformance(m: Manifest, defs: (name: string) => InterfaceDef | undefined): string[] {
  const out: string[] = [];
  const ui = m.ui;
  if (!ui) return out;
  const check = (where: string, op: string, read: boolean) => {
    const mm = UI_OP_RE.exec(op);
    if (!mm) return;
    const def = defs(mm[1]);
    if (!def) return; // a requirement not installed yet: the contribution stays hidden until it is
    const d = def.operations[mm[2]];
    if (!d) out.push(`${where}: ${mm[1]} has no operation ${mm[2]}`);
    else if (read && d.class !== 'read') out.push(`${where}: ${op} is not a read operation; queries are read-only`);
    else if (!read && (d.change?.role === 'apply' || d.change?.role === 'rollback')) out.push(`${where}: ${op} applies or rolls back a change record; UI actions may not`);
  };
  for (const x of [...(ui.cards ?? []), ...(ui.panels ?? []), ...(ui.badges ?? [])]) if (x.query) check(`ui ${x.id}`, x.query.operation, true);
  for (const pg of ui.pages ?? []) for (const s of pg.sections) if (s.query) check(`ui ${pg.id}`, s.query.operation, true);
  for (const a of ui.actions ?? []) check(`ui ${a.id}`, a.operation, false);
  return out;
}

/** The skill files a manifest contributes, each with its audience. */
export function skillRefs(m: Manifest): Array<{ path: string; audience: Audience[] }> {
  const out: Array<{ path: string; audience: Audience[] }> = [];
  for (const s of m.skills ?? []) out.push(typeof s === 'string' ? { path: s, audience: ['all'] } : { path: s.path, audience: s.audience?.length ? s.audience : ['all'] });
  for (const i of m.interfaces ?? []) for (const s of i.skills ?? []) if (!out.some((o) => o.path === s)) out.push({ path: s, audience: ['all'] });
  return out;
}

/** Validate a parsed `plugin.json`. `bytes` is the raw size when known. */
export function validateManifest(raw: unknown, bytes?: number): ValidationResult {
  const c = new Checker();
  if (bytes !== undefined && bytes > MANIFEST_MAX_BYTES) return { ok: false, errors: [`the manifest is ${bytes} bytes; the cap is ${MANIFEST_MAX_BYTES}`], warnings: [] };
  if (!c.isObj(raw)) return { ok: false, errors: ['the manifest must be a JSON object'], warnings: [] };
  const size = JSON.stringify(raw).length;
  if (size > MANIFEST_MAX_BYTES) return { ok: false, errors: [`the manifest is ${size} bytes; the cap is ${MANIFEST_MAX_BYTES}`], warnings: [] };
  codeShaped(raw, '$', c.errors);
  const m = raw;
  for (const k of Object.keys(m)) if (!TOP_KEYS.includes(k)) c.warnings.push(`unknown top-level key "${k}" (ignored)`);
  if (m.manifestVersion !== MANIFEST_VERSION) c.err('manifestVersion', `must be ${MANIFEST_VERSION}`);
  c.str('id', m.id, { re: ID_RE });
  c.str('name', m.name, { max: 80 });
  for (const k of ['description', 'homepage', 'license'] as const) c.str(k, m[k], { optional: true, max: 2_000 });
  if (!isVersion(m.version)) c.err('version', 'must be a semver x.y.z');
  if (c.strict('publisher', m.publisher, ['id', 'name', 'verifiedDomain'], ['id', 'name'])) {
    const pub = m.publisher as Record<string, unknown>;
    c.str('publisher.id', pub.id, { re: /^[a-z0-9-]{2,40}$/ });
    c.str('publisher.name', pub.name, { max: 80 });
    c.str('publisher.verifiedDomain', pub.verifiedDomain, { optional: true, re: HOST_RE });
  }
  const roles = Array.isArray(m.roles) ? m.roles as unknown[] : [];
  if (!Array.isArray(m.roles) || roles.length === 0 || roles.length > 3 || !roles.every((r) => ROLES.includes(r as Role)) || new Set(roles).size !== roles.length) {
    c.err('roles', 'must be a non-empty list of interface, provider, consumer');
  }
  if (c.strict('requires', m.requires, ['yaamCore', 'interfaces'], ['yaamCore'])) {
    const req = m.requires as Record<string, unknown>;
    if (!isRange(req.yaamCore)) c.err('requires.yaamCore', 'must be a semver range');
    if (c.list('requires.interfaces', req.interfaces, true, 30)) {
      (req.interfaces as unknown[]).forEach((x, i) => { if (!parseInterfaceRef(String(x))) c.err(`requires.interfaces[${i}]`, 'must be name@range'); });
    }
  }
  const has = (k: string) => m[k] !== undefined && !(Array.isArray(m[k]) && (m[k] as unknown[]).length === 0);
  // Roles must match the fields present (§3.1).
  if (roles.includes('interface') !== has('interfaces')) c.err('roles', roles.includes('interface') ? 'the interface role needs `interfaces`' : '`interfaces` needs the interface role');
  if (roles.includes('provider') !== has('provides') && !(roles.includes('provider') && has('tools'))) c.err('roles', roles.includes('provider') ? 'the provider role needs `provides` or `tools`' : '`provides` needs the provider role');
  if (has('tools') && !roles.includes('provider')) c.err('roles', 'vendor extras (`tools`) need the provider role');
  if (has('toolPrefix') && !roles.includes('provider')) c.err('toolPrefix', 'only providers declare a tool prefix');
  if (roles.includes('consumer') && !has('requires') && !has('skills') && !has('rolePacks') && !has('playbooks') && !has('guidance') && !has('ui')) c.err('roles', 'a consumer declares what it consumes');
  if (m.toolPrefix !== undefined && c.str('toolPrefix', m.toolPrefix, { re: /^[a-z][a-z0-9]{1,15}$/ }) && RESERVED_NAMES.has(m.toolPrefix as string)) c.err('toolPrefix', 'is a name the core owns');
  if (m.settings !== undefined) c.schema('settings', m.settings);

  const egress = new Set<string>();
  if (c.list('egress', m.egress, true, 50)) (m.egress as unknown[]).forEach((e, i) => {
    if (!c.strict(`egress[${i}]`, e, ['host', 'category'], ['host', 'category'])) return;
    if (c.str(`egress[${i}].host`, e.host, { re: HOST_RE })) egress.add(e.host as string);
    c.oneOf(`egress[${i}].category`, e.category, ['vendor_api', 'vendor_cdn', 'auth', 'telemetry'] as const);
  });
  if (c.list('interfaces', m.interfaces, true, 10)) (m.interfaces as unknown[]).forEach((x, i) => checkInterface(c, `interfaces[${i}]`, x));
  if (c.list('provides', m.provides, true, 20)) (m.provides as unknown[]).forEach((x, i) => checkProvides(c, `provides[${i}]`, x, egress));
  if (m.tools !== undefined && c.strict('tools', m.tools, ['items'], ['items']) && c.list('tools.items', (m.tools as Record<string, unknown>).items, false, 100)) {
    ((m.tools as Record<string, unknown>).items as unknown[]).forEach((t, i) => {
      const p = `tools.items[${i}]`;
      if (!c.strict(p, t, ['name', 'class', 'grant', 'connection', 'output', 'definitionHash', 'impl', 'semantics', 'input'], ['name', 'grant', 'output', 'definitionHash', 'impl'])) return;
      c.str(`${p}.name`, t.name, { re: OP_RE });
      if (t.class !== undefined) c.oneOf(`${p}.class`, t.class, ACTION_CLASSES);
      c.oneOf(`${p}.grant`, t.grant, ['read', 'write'] as const);
      c.oneOf(`${p}.output`, t.output, ['untrusted', 'structured'] as const);
      c.str(`${p}.definitionHash`, t.definitionHash, { max: 80 });
      c.str(`${p}.semantics`, t.semantics, { optional: true, lint: true, max: 1_000 });
      if (t.input !== undefined) c.schema(`${p}.input`, t.input);
      checkImpl(c, `${p}.impl`, t.impl, egress);
    });
  }
  if (c.list('connections', m.connections, true, 10)) (m.connections as unknown[]).forEach((x, i) => {
    if (!c.strict(`connections[${i}]`, x, ['id', 'auth', 'scopeTiers', 'audience', 'grantLevels'], ['id', 'auth', 'scopeTiers', 'audience', 'grantLevels'])) return;
    c.str(`connections[${i}].id`, x.id, { re: /^[a-z][a-z0-9_-]{0,30}$/ });
    if (c.isObj(x.auth)) c.oneOf(`connections[${i}].auth.type`, x.auth.type, ['oauth2', 'github_app', 'api_key'] as const);
    else c.err(`connections[${i}].auth`, 'must be an object');
    c.strList(`connections[${i}].audience`, x.audience, HOST_RE, false);
  });
  if (c.list('events', m.events, true, 50)) (m.events as unknown[]).forEach((x, i) => {
    if (!c.strict(`events[${i}]`, x, ['id', 'connection', 'signature', 'dedupeKey', 'filter', 'map', 'routes', 'incident', 'reconcile'], ['id', 'signature', 'dedupeKey', 'map', 'routes'])) return;
    c.str(`events[${i}].id`, x.id, { re: /^[a-z][a-z0-9_]{0,40}$/ });
  });
  if (c.list('secrets', m.secrets, true, 20)) (m.secrets as unknown[]).forEach((x, i) => {
    if (!c.strict(`secrets[${i}]`, x, ['slot', 'description', 'kind', 'inject'], ['slot', 'description', 'kind', 'inject'])) return;
    c.str(`secrets[${i}].slot`, x.slot, { re: /^[A-Z][A-Z0-9_]{0,40}$/ });
    c.oneOf(`secrets[${i}].inject`, x.inject, ['proxy', 'env'] as const);
  });
  if (c.list('dataSharing', m.dataSharing, true, 30)) (m.dataSharing as unknown[]).forEach((x, i) => {
    if (!c.strict(`dataSharing[${i}]`, x, ['category', 'to', 'when', 'purpose'], ['category', 'to', 'when', 'purpose'])) return;
    c.oneOf(`dataSharing[${i}].category`, x.category, DATA_CATEGORIES);
    c.str(`dataSharing[${i}].to`, x.to, { re: HOST_RE });
    c.oneOf(`dataSharing[${i}].when`, x.when, ['operation', 'ambient'] as const);
    c.str(`dataSharing[${i}].purpose`, x.purpose, { max: 300 });
  });
  if (c.list('identity', m.identity, true, 10)) (m.identity as unknown[]).forEach((x, i) => {
    if (!c.strict(`identity[${i}]`, x, ['header', 'value', 'static'], ['header', 'value'])) return;
    c.oneOf(`identity[${i}].value`, x.value, IDENTITY_VALUES);
  });
  if (c.list('policies', m.policies, true, 30)) (m.policies as unknown[]).forEach((x, i) => {
    if (!c.strict(`policies[${i}]`, x, ['match', 'require', 'why'], ['match', 'require', 'why'])) return;
    if (c.strict(`policies[${i}].match`, x.match, ['operation', 'changeKind', 'bind'])) {
      const mm = x.match as Record<string, unknown>;
      if (mm.operation === undefined && mm.changeKind === undefined) c.err(`policies[${i}].match`, 'names an operation or a change kind');
    }
    if (typeof x.require !== 'string' || !(['two_key', 'cosign', 'owner_key'].includes(x.require) || (x.require.startsWith('class:') && isActionClass(x.require.slice(6))))) {
      c.err(`policies[${i}].require`, 'must be two_key, cosign, owner_key or class:<Class>');
    }
    c.str(`policies[${i}].why`, x.why, { max: 300 });
  });
  if (m.budgets !== undefined && c.strict('budgets', m.budgets, ['callsPerMinute', 'concurrent', 'maxCostPerCallUsd', 'computeMinutesPerDay'])) {
    const b = m.budgets as Record<string, unknown>;
    c.num('budgets.callsPerMinute', b.callsPerMinute, 1, 10_000);
    c.num('budgets.concurrent', b.concurrent, 1, 100);
    c.num('budgets.maxCostPerCallUsd', b.maxCostPerCallUsd, 0, 1_000);
    c.num('budgets.computeMinutesPerDay', b.computeMinutesPerDay, 0, 100_000);
  }
  if (c.list('runtime', m.runtime, true, 10)) (m.runtime as unknown[]).forEach((x, i) => {
    if (!c.strict(`runtime[${i}]`, x, ['id', 'image', 'digest', 'protocol', 'cpu', 'memoryMb'], ['id', 'image', 'digest', 'protocol'])) return;
    c.str(`runtime[${i}].digest`, x.digest, { re: /^sha256:/ });
    c.oneOf(`runtime[${i}].protocol`, x.protocol, ['mcp-http', 'mcp-stdio', 'rpc-http'] as const);
  });
  if (c.list('setup', m.setup, true, 20)) (m.setup as unknown[]).forEach((x, i) => {
    if (!c.strict(`setup[${i}]`, x, ['operation', 'input', 'creates'], ['operation', 'creates'])) return;
    for (const e of checkTemplates(x.input)) c.err(`setup[${i}].input`, e);
  });
  if (c.list('finalizers', m.finalizers, true, 20)) (m.finalizers as unknown[]).forEach((x, i) => {
    c.strict(`finalizers[${i}]`, x, ['id', 'operation', 'resource'], ['id', 'operation', 'resource']);
  });
  if (c.list('guards', m.guards, true, 10)) (m.guards as unknown[]).forEach((x, i) => {
    if (!c.strict(`guards[${i}]`, x, ['id', 'runtime', 'operations', 'timeoutMs'], ['id', 'runtime', 'operations', 'timeoutMs'])) return;
    c.num(`guards[${i}].timeoutMs`, x.timeoutMs, 1, 2_000, false);
  });
  if (c.list('verifies', m.verifies, true, 30)) (m.verifies as unknown[]).forEach((x, i) => {
    if (!c.strict(`verifies[${i}]`, x, ['changeKind', 'check'], ['changeKind', 'check'])) return;
    if (c.isObj(x.check) && x.check.match !== undefined) for (const e of checkMatchExpr(x.check.match)) c.err(`verifies[${i}].check.match`, e);
  });
  for (const k of ['rolePacks', 'playbooks'] as const) if (c.list(k, m[k], true, 50)) (m[k] as unknown[]).forEach((x, i) => c.relPath(`${k}[${i}]`, x));
  if (c.list('skills', m.skills, true, 20)) (m.skills as unknown[]).forEach((x, i) => {
    if (typeof x === 'string') { c.relPath(`skills[${i}]`, x); return; }
    if (!c.strict(`skills[${i}]`, x, ['path', 'audience'], ['path'])) return;
    c.relPath(`skills[${i}].path`, x.path);
    if (x.audience !== undefined) checkAudience(c, `skills[${i}].audience`, x.audience);
  });
  checkGuidance(c, 'guidance', m.guidance);
  if (m.ui !== undefined) checkUi(c, 'ui', m.ui, uiScope(m));
  for (const k of ['metrics', 'mirrors', 'panels', 'environments'] as const) c.list(k, m[k], true, 50);
  if (m.tunables !== undefined && !c.isObj(m.tunables)) c.err('tunables', 'must be an object');

  // Cross-checks: every interface reference a provider makes is required.
  const required = new Set(((m.requires as Record<string, unknown> | undefined)?.interfaces as string[] | undefined ?? []).map((r) => parseInterfaceRef(String(r))?.name));
  for (const p of Array.isArray(m.provides) ? m.provides as Array<Record<string, unknown>> : []) {
    const ref = parseInterfaceRef(String(p.interface));
    const ownIface = (Array.isArray(m.interfaces) ? m.interfaces as Array<Record<string, unknown>> : []).some((i) => i.name === ref?.name);
    if (ref && !required.has(ref.name) && !ownIface) c.err('provides', `${String(p.interface)} must also be listed in requires.interfaces`);
  }
  if (c.errors.length > 0) return { ok: false, errors: c.errors, warnings: c.warnings };
  return { ok: true, manifest: m as unknown as Manifest, warnings: c.warnings };
}

// ---- conformance suites and fixtures (data files a manifest references) ----

export interface SuiteStep {
  op?: string;
  input?: Record<string, unknown>;
  save?: Record<string, string>;
  expect?: { schema?: boolean; match?: Record<string, unknown>; error?: string };
  expectEvent?: { kind: string; within: string };
  skipIn?: Array<'mock' | 'test_org'>;
}
export interface Suite { interface: string; fixtures?: Record<string, string>; cases: Array<{ id: string; steps: SuiteStep[] }> }

export function validateSuite(raw: unknown): { ok: true; suite: Suite } | { ok: false; errors: string[] } {
  const c = new Checker();
  if (!c.strict('suite', raw, ['interface', 'fixtures', 'cases'], ['interface', 'cases'])) return { ok: false, errors: c.errors };
  const s = raw;
  c.str('suite.interface', s.interface, { max: 60 });
  if (s.fixtures !== undefined && c.isObj(s.fixtures)) for (const [k, v] of Object.entries(s.fixtures)) c.str(`suite.fixtures.${k}`, v, { max: 300 });
  if (c.list('suite.cases', s.cases, false, 100)) (s.cases as unknown[]).forEach((cs, i) => {
    const p = `suite.cases[${i}]`;
    if (!c.strict(p, cs, ['id', 'steps'], ['id', 'steps'])) return;
    c.str(`${p}.id`, cs.id, { re: /^[a-z0-9-]{1,60}$/ });
    if (c.list(`${p}.steps`, cs.steps, false, 50)) (cs.steps as unknown[]).forEach((st, j) => {
      const q = `${p}.steps[${j}]`;
      if (!c.strict(q, st, ['op', 'input', 'save', 'expect', 'expectEvent', 'skipIn'])) return;
      if ((st.op === undefined) === (st.expectEvent === undefined)) c.err(q, 'a step is an op or an expectEvent');
      if (st.op !== undefined) c.str(`${q}.op`, st.op, { re: OP_RE });
      for (const e of checkTemplates(st.input)) c.err(`${q}.input`, e);
      if (st.save !== undefined && c.isObj(st.save)) for (const [k, v] of Object.entries(st.save)) { if (!/^[a-z][A-Za-z0-9_]{0,30}$/.test(k) || !isPath(v)) c.err(`${q}.save.${k}`, 'must map a name to a $-path'); }
      if (st.expect !== undefined && c.strict(`${q}.expect`, st.expect, ['schema', 'match', 'error'])) {
        const ex = st.expect as Record<string, unknown>;
        if (ex.match !== undefined && c.isObj(ex.match)) for (const k of Object.keys(ex.match)) if (!isPath(k)) c.err(`${q}.expect.match.${k}`, 'must be a $-path');
      }
    });
  });
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, suite: s as unknown as Suite };
}

/** A fixture file: per operation, cases tried in order; the first whose
 *  `when` paths all equal the input answers with `output` (a template over
 *  `input`) or an `error`. Deterministic data, never code. */
export interface FixtureCase { when?: Record<string, unknown>; output?: unknown; error?: { code: string; message: string } }
export interface Fixtures { operations: Record<string, FixtureCase[]> }

export function validateFixtures(raw: unknown): { ok: true; fixtures: Fixtures } | { ok: false; errors: string[] } {
  const c = new Checker();
  if (!c.strict('fixtures', raw, ['operations'], ['operations'])) return { ok: false, errors: c.errors };
  const ops = raw.operations;
  if (!c.isObj(ops)) return { ok: false, errors: ['fixtures.operations: must be an object'] };
  for (const [op, cases] of Object.entries(ops)) {
    if (!OP_RE.test(op)) c.err(`fixtures.operations.${op}`, 'bad operation name');
    if (!c.list(`fixtures.operations.${op}`, cases, false, 100)) continue;
    (cases as unknown[]).forEach((fc, i) => {
      const p = `fixtures.operations.${op}[${i}]`;
      if (!c.strict(p, fc, ['when', 'output', 'error'])) return;
      if ((fc.output === undefined) === (fc.error === undefined)) c.err(p, 'answers with output or error');
      if (fc.when !== undefined && c.isObj(fc.when)) for (const k of Object.keys(fc.when)) if (!isPath(k)) c.err(`${p}.when.${k}`, 'must be a $-path');
      if (fc.error !== undefined && c.strict(`${p}.error`, fc.error, ['code', 'message'], ['code', 'message'])) c.str(`${p}.error.code`, (fc.error as Record<string, unknown>).code, { re: /^[a-z_]{2,40}$/ });
      for (const e of checkTemplates(fc.output)) c.err(`${p}.output`, e);
    });
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, fixtures: raw as unknown as Fixtures };
}
