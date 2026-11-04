/**
 * The kit manifest, `kit.json` (`yaam-kit/1`, docs/foundry.md §2): the
 * strict validator and the folder loader. A kit is declarative: the
 * interfaces it requires, the providers it recommends (the owner picks),
 * the plugins it includes, default bindings, the seats it staffs with their
 * grants, its playbooks (skills), guidance notes, requested policies (raise
 * only) and descriptive rhythm and measures. It can never carry a security
 * field — egress, secrets, connections, identity, data sharing, tools,
 * runtime or classes — those live only in plugin manifests and reach the
 * review through the member plugins.
 *
 * Applied today: plugins, providers, bindings, policies, playbooks,
 * guidance, seats and grants. `rhythm` and `measures` are descriptive
 * (cadence derivation and kit metrics are Foundry F1's remainder).
 */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, sha256 } from '../actions/action-classes';
import { lintText, validateGuidance, AUDIENCE_RE, type Audience, type GuidanceDef } from '../plugins/manifest';
import { isRange, isVersion, parseInterfaceRef } from '../plugins/semver';
import { parseSkillMd } from '../portability/skill-md';

export const KIT_FORMAT = 'yaam-kit/1';
const ID_RE = /^([a-z0-9-]{2,40})@([a-z0-9-]{2,40})$/;
const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Fields a kit may never carry (§2.2, last paragraph). */
export const KIT_FORBIDDEN = ['egress', 'secrets', 'connections', 'identity', 'dataSharing', 'tools', 'runtime', 'classes', 'provides', 'interfaces'];
const KIT_KEYS = ['format', 'id', 'name', 'summary', 'description', 'homepage', 'license', 'version', 'publisher', 'segment', 'functions', 'fits', 'companyTypes',
  'requires', 'plugins', 'recommends', 'bindings', 'roles', 'playbooks', 'guidance', 'policies', 'rhythm', 'measures', 'changelog'];

export interface KitRole {
  key: string; role: string; title: string; reportsTo: string;
  hire: 'required' | 'recommended' | 'optional';
  grants?: Record<string, 'read' | 'write'>;
  playbooks?: string[];
}
export interface KitManifest {
  format: typeof KIT_FORMAT;
  id: string; name: string; summary: string; description?: string; homepage?: string; license?: string; version: string;
  publisher: { id: string; name: string; verifiedDomain?: string };
  segment: 'business' | 'personal';
  functions: string[]; fits?: string[]; companyTypes?: string[];
  requires: { yaamCore: string; interfaces: string[]; optionalInterfaces?: string[] };
  plugins?: Array<{ id: string; range?: string; why: string; optional?: boolean }>;
  recommends?: { providers?: Record<string, Array<{ id: string; why: string; trial?: boolean }>> };
  bindings?: Array<{ interface: string; scope: { kind: 'workspace' }; provider: string }>;
  roles?: KitRole[];
  playbooks?: Array<string | { path: string; audience?: Audience[] }>;
  guidance?: GuidanceDef[];
  policies?: Array<{ id: string; match: { operation?: string; changeKind?: string }; require: string; why: string }>;
  rhythm?: string[];
  measures?: string[];
  changelog?: string;
}

export interface KitPackage { manifest: KitManifest; files: Record<string, string>; digest: string; warnings: string[] }

export class KitLoadError extends Error {
  constructor(readonly errors: string[]) { super(errors.join('; ')); }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Validate a parsed `kit.json`. Strict: unknown fields are refused, security fields named. */
export function validateKit(raw: unknown): { ok: true; manifest: KitManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const err = (p: string, m: string) => errors.push(`${p}: ${m}`);
  if (!isObj(raw)) return { ok: false, errors: ['kit.json must be a JSON object'] };
  if (JSON.stringify(raw).length > 128 * 1024) return { ok: false, errors: ['kit.json is larger than 128 KB'] };
  for (const k of Object.keys(raw)) {
    if (KIT_FORBIDDEN.includes(k)) err(k, 'a kit may not carry security fields or code; they belong to plugin manifests');
    else if (!KIT_KEYS.includes(k)) err(k, 'unknown field');
  }
  const str = (p: string, v: unknown, max = 300, opts: { optional?: boolean; re?: RegExp; lint?: boolean } = {}) => {
    if (v === undefined && opts.optional) return false;
    if (typeof v !== 'string' || !v.trim()) { err(p, 'must be a non-empty string'); return false; }
    if (v.length > max) { err(p, `longer than ${max} characters`); return false; }
    if (opts.re && !opts.re.test(v)) { err(p, `does not match ${opts.re}`); return false; }
    if (opts.lint) for (const l of lintText(v)) err(p, `refused by the steering lint: ${l}`);
    return true;
  };
  const list = (p: string, v: unknown, max: number, optional = true): v is unknown[] => {
    if (v === undefined && optional) return false;
    if (!Array.isArray(v)) { err(p, 'must be a list'); return false; }
    if (v.length > max) { err(p, `more than ${max} entries`); return false; }
    return true;
  };
  const keys = (p: string, v: unknown, allowed: string[], required: string[]): v is Obj => {
    if (!isObj(v)) { err(p, 'must be an object'); return false; }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) err(`${p}.${k}`, KIT_FORBIDDEN.includes(k) ? 'a security field; not allowed in a kit' : 'unknown field');
    for (const k of required) if (v[k] === undefined) err(`${p}.${k}`, 'required');
    return true;
  };
  const k = raw;
  if (k.format !== KIT_FORMAT) err('format', `must be "${KIT_FORMAT}"`);
  str('id', k.id, 82, { re: ID_RE });
  str('name', k.name, 80);
  str('summary', k.summary, 300);
  for (const f of ['description', 'homepage', 'license', 'changelog'] as const) str(f, k[f], 2_000, { optional: true });
  if (!isVersion(k.version)) err('version', 'must be a semver x.y.z');
  if (keys('publisher', k.publisher, ['id', 'name', 'verifiedDomain'], ['id', 'name'])) { str('publisher.id', (k.publisher as Obj).id, 40); str('publisher.name', (k.publisher as Obj).name, 80); }
  if (k.segment !== 'business' && k.segment !== 'personal') err('segment', 'must be business or personal');
  for (const f of ['functions', 'fits', 'companyTypes'] as const) if (list(f, k[f], 30, f !== 'functions')) (k[f] as unknown[]).forEach((x, i) => str(`${f}[${i}]`, x, 40, { re: /^[a-z][a-z0-9-]{1,39}$/ }));
  const ifaces = new Set<string>();
  if (keys('requires', k.requires, ['yaamCore', 'interfaces', 'optionalInterfaces'], ['yaamCore', 'interfaces'])) {
    const r = k.requires as Obj;
    if (!isRange(r.yaamCore)) err('requires.yaamCore', 'must be a semver range');
    for (const f of ['interfaces', 'optionalInterfaces'] as const) if (list(`requires.${f}`, r[f], 20, f === 'optionalInterfaces')) (r[f] as unknown[]).forEach((x, i) => {
      const ref = parseInterfaceRef(String(x));
      if (!ref) err(`requires.${f}[${i}]`, 'must be name@range'); else ifaces.add(ref.name);
    });
  }
  if (list('plugins', k.plugins, 20)) (k.plugins as unknown[]).forEach((p, i) => {
    if (!keys(`plugins[${i}]`, p, ['id', 'range', 'why', 'optional'], ['id', 'why'])) return;
    str(`plugins[${i}].id`, p.id, 82, { re: ID_RE });
    if (p.range !== undefined && !isRange(p.range)) err(`plugins[${i}].range`, 'must be a semver range');
    str(`plugins[${i}].why`, p.why, 300, { lint: true });
  });
  if (k.recommends !== undefined && keys('recommends', k.recommends, ['providers'], [])) {
    const prov = (k.recommends as Obj).providers;
    if (prov !== undefined) {
      if (!isObj(prov)) err('recommends.providers', 'must be an object');
      else for (const [iface, recs] of Object.entries(prov)) {
        if (!ifaces.has(iface)) err(`recommends.providers.${iface}`, 'is not a required or optional interface of the kit');
        if (list(`recommends.providers.${iface}`, recs, 8, false)) (recs as unknown[]).forEach((r, i) => {
          if (!keys(`recommends.providers.${iface}[${i}]`, r, ['id', 'why', 'trial'], ['id', 'why'])) return;
          str(`recommends.providers.${iface}[${i}].id`, r.id, 82, { re: ID_RE });
          str(`recommends.providers.${iface}[${i}].why`, r.why, 300, { lint: true });
        });
      }
    }
  }
  if (list('bindings', k.bindings, 20)) (k.bindings as unknown[]).forEach((b, i) => {
    if (!keys(`bindings[${i}]`, b, ['interface', 'scope', 'provider'], ['interface', 'scope', 'provider'])) return;
    if (!ifaces.has(String(b.interface))) err(`bindings[${i}].interface`, 'is not an interface of the kit');
    if (!isObj(b.scope) || b.scope.kind !== 'workspace') err(`bindings[${i}].scope`, 'only { kind: "workspace" } bindings are applied by kits today');
    if (b.provider !== '$choice' && !(typeof b.provider === 'string' && ID_RE.test(b.provider))) err(`bindings[${i}].provider`, 'must be "$choice" or a provider id');
  });
  const roleKeys = new Set<string>();
  const playbookNames = new Set<string>();
  if (list('playbooks', k.playbooks, 20)) (k.playbooks as unknown[]).forEach((p, i) => {
    const path = typeof p === 'string' ? p : isObj(p) ? p.path : undefined;
    if (isObj(p)) {
      keys(`playbooks[${i}]`, p, ['path', 'audience'], ['path']);
      if (p.audience !== undefined && (!Array.isArray(p.audience) || p.audience.some((a) => typeof a !== 'string' || !AUDIENCE_RE.test(a)))) err(`playbooks[${i}].audience`, 'audiences are all, chief, heads, members or function:<fn>');
    }
    if (typeof path !== 'string' || !/^playbooks\/[a-z0-9-]{2,60}\.md$/.test(path)) err(`playbooks[${i}]`, 'must be playbooks/<name>.md');
    else playbookNames.add(path.slice('playbooks/'.length, -3));
  });
  if (list('roles', k.roles, 12)) (k.roles as unknown[]).forEach((r, i) => {
    if (!keys(`roles[${i}]`, r, ['key', 'role', 'title', 'reportsTo', 'hire', 'grants', 'playbooks'], ['key', 'role', 'title', 'reportsTo', 'hire'])) return;
    if (str(`roles[${i}].key`, r.key, 31, { re: KEY_RE })) { if (roleKeys.has(r.key as string)) err(`roles[${i}].key`, 'repeats a key'); roleKeys.add(r.key as string); }
    str(`roles[${i}].role`, r.role, 60, { re: /^[a-z][a-z0-9-]{1,59}$/ });
    str(`roles[${i}].title`, r.title, 60);
    if (r.reportsTo !== '$chief' && !(typeof r.reportsTo === 'string' && roleKeys.has(r.reportsTo))) err(`roles[${i}].reportsTo`, 'must be "$chief" or the key of an earlier role');
    if (!['required', 'recommended', 'optional'].includes(String(r.hire))) err(`roles[${i}].hire`, 'must be required, recommended or optional');
    if (r.grants !== undefined) {
      if (!isObj(r.grants)) err(`roles[${i}].grants`, 'must be an object');
      else for (const [g, lvl] of Object.entries(r.grants)) {
        if (!ifaces.has(g)) err(`roles[${i}].grants.${g}`, 'is not an interface of the kit');
        if (lvl !== 'read' && lvl !== 'write') err(`roles[${i}].grants.${g}`, 'must be read or write');
      }
    }
    if (list(`roles[${i}].playbooks`, r.playbooks, 10)) (r.playbooks as unknown[]).forEach((p, j) => { if (!playbookNames.has(String(p))) err(`roles[${i}].playbooks[${j}]`, 'names no playbook of the kit'); });
  });
  errors.push(...validateGuidance(k.guidance));
  if (list('policies', k.policies, 20)) (k.policies as unknown[]).forEach((p, i) => {
    if (!keys(`policies[${i}]`, p, ['id', 'match', 'require', 'why'], ['id', 'match', 'require', 'why'])) return;
    str(`policies[${i}].id`, p.id, 40, { re: KEY_RE });
    if (keys(`policies[${i}].match`, p.match, ['operation', 'changeKind'], [])) {
      const m = p.match as Obj;
      if (m.operation === undefined && m.changeKind === undefined) err(`policies[${i}].match`, 'names an operation or a change kind');
      for (const f of ['operation', 'changeKind'] as const) if (m[f] !== undefined) {
        if (!str(`policies[${i}].match.${f}`, m[f], 60, { re: /^[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9_]{0,39}$/ })) continue;
        if (!ifaces.has(String(m[f]).split('.')[0])) err(`policies[${i}].match.${f}`, 'names an interface the kit does not require');
      }
    }
    if (!['two_key', 'cosign', 'owner_key'].includes(String(p.require)) && !/^class:(read|internal_write|external_reversible|external_irreversible|money)$/.test(String(p.require))) err(`policies[${i}].require`, 'must be two_key, cosign, owner_key or class:<Class>');
    str(`policies[${i}].why`, p.why, 300, { lint: true });
  });
  for (const f of ['rhythm', 'measures'] as const) if (list(f, k[f], 12)) (k[f] as unknown[]).forEach((x, i) => str(`${f}[${i}]`, x, 120, { lint: true }));
  return errors.length ? { ok: false, errors } : { ok: true, manifest: k as unknown as KitManifest };
}

/** Each playbook's path and audience. */
export function kitPlaybooks(m: KitManifest): Array<{ path: string; name: string; audience: Audience[] }> {
  return (m.playbooks ?? []).map((p) => {
    const path = typeof p === 'string' ? p : p.path;
    const audience = typeof p === 'string' ? [] : p.audience ?? [];
    return { path, name: path.slice('playbooks/'.length, -3), audience: audience.length ? audience : ['all'] };
  });
}

/** A kit package from its manifest and files: validated, playbooks parsed, digested. */
export function kitFrom(raw: unknown, files: Record<string, string>): KitPackage {
  const v = validateKit(raw);
  if (!v.ok) throw new KitLoadError(v.errors);
  const errors: string[] = [];
  const kept: Record<string, string> = {};
  for (const p of kitPlaybooks(v.manifest)) {
    const body = files[p.path];
    if (body === undefined) { errors.push(`${p.path}: referenced by kit.json but missing`); continue; }
    if (Buffer.byteLength(body, 'utf8') > 64 * 1024) { errors.push(`${p.path}: larger than 64 KB`); continue; }
    try { parseSkillMd(body); } catch (err) { errors.push(`${p.path}: ${err instanceof Error ? err.message : String(err)}`); continue; }
    kept[p.path] = body;
  }
  if (errors.length) throw new KitLoadError(errors);
  const warnings = Object.keys(files).filter((p) => !(p in kept) && p !== 'kit.json' && !/^(README|CHANGELOG)\.md$/.test(p)).map((p) => `${p}: not referenced (not loaded)`);
  return { manifest: v.manifest, files: kept, digest: sha256(canonicalJson({ manifest: v.manifest, files: kept })), warnings };
}

/** Where first-party kits live: `YAAM_KITS_DIR` or `kits/first-party` under the working directory. */
export function firstPartyKitsDir(): string {
  return resolve(process.env.YAAM_KITS_DIR || join(process.cwd(), 'kits', 'first-party'));
}

/** Every first-party kit folder (`kit.json` + `playbooks/*.md`), by id. */
export async function loadFirstPartyKits(dir = firstPartyKitsDir()): Promise<Map<string, KitPackage>> {
  const out = new Map<string, KitPackage>();
  let names: string[];
  try { names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return out; }
  for (const name of names) {
    const root = join(dir, name);
    const files: Record<string, string> = {};
    for (const f of await fs.readdir(root, { withFileTypes: true })) if (f.isFile() && !f.name.startsWith('.')) files[f.name] = await fs.readFile(join(root, f.name), 'utf8');
    try { for (const f of await fs.readdir(join(root, 'playbooks'), { withFileTypes: true })) if (f.isFile() && f.name.endsWith('.md')) files[`playbooks/${f.name}`] = await fs.readFile(join(root, 'playbooks', f.name), 'utf8'); } catch { /* no playbooks */ }
    let raw: unknown;
    try { raw = JSON.parse(files['kit.json'] ?? ''); } catch { throw new KitLoadError([`${name}/kit.json: not JSON`]); }
    const pkg = kitFrom(raw, files);
    if (!pkg.manifest.id.endsWith('@yaam')) throw new KitLoadError([`${name}: first-party kits are @yaam`]);
    out.set(pkg.manifest.id, pkg);
  }
  return out;
}
