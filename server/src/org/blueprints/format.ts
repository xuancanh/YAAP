/**
 * COMPANY.json v1 — the company blueprint (docs/company-vision.md §9,
 * docs/blueprints.md, execution-plan item 24). A sibling of AGENT.json: the
 * structure, charters, playbooks, cadences and budget split of a company as
 * one JSON document, with **no executable content beyond SKILL.md text**.
 * Importing one never runs code, never creates connections or grants, never
 * copies memory, lessons, tokens or files; it stages agents, a profile, a
 * vision, tunables and skill drafts, all of which the CEO can read first.
 *
 * `validateBlueprint` is the strict gate every door uses (file import,
 * registry publish, registry install): unknown shapes are refused, strings
 * are bounded, and the structural caps of the company apply to the document
 * itself — ≤ 256 KB, ≤ 20 roles, depth ≤ 3, fan-out ≤ 5.
 */
import { MODEL_TIERS, type ModelTier } from '../roles/catalog';
import { parseScopes } from '../scopes';

export const BLUEPRINT_FORMAT = 'yaam-company/1';
export const BLUEPRINT_MAX_BYTES = 256 * 1024;
export const BLUEPRINT_MAX_ROLES = 20;
export const BLUEPRINT_MAX_DEPTH = 3;
export const BLUEPRINT_MAX_FANOUT = 5;
export const BLUEPRINT_MAX_PLAYBOOKS = 20;
export const BLUEPRINT_MAX_CADENCES = 20;

export interface BlueprintRole {
  /** A catalog role id the charter was drawn from (informative; the inline fields rule). */
  roleId?: string;
  title: string;
  charter: string;
  /** The title of the role it reports to; null for the root (the chief of staff). */
  reportsTo: string | null;
  scopes: string[];
  modelTier: ModelTier;
  monthlyUsd: number;
}

/** `unitTitle` is a role title that leads a unit, or 'root' for the company. */
export interface BlueprintCadence { unitTitle: string; kind: string; cron: string }

export interface Blueprint {
  format: typeof BLUEPRINT_FORMAT;
  name: string;
  description: string;
  profile: { values: string; culture: string; rules: string };
  vision?: { title: string; description: string; horizonDays: number };
  roles: BlueprintRole[];
  /** Derived from reportsTo on export; informative on import. */
  units?: Array<{ title: string; parent: string | null }>;
  cadences?: BlueprintCadence[];
  tunables: Record<string, number>;
  routing?: Record<string, string>;
  /** Skills as SKILL.md text; installed as drafts. */
  playbooks: Array<{ name: string; skillMd: string }>;
  budget: { monthlyUsd: number; allocations?: Record<string, number> };
  /** Connection card ids to recommend (never granted by an import). */
  cards?: string[];
  origin: { exportedFrom: string; at: string; sourceOrgId: string };
}

const TOP_KEYS = new Set(['format', 'name', 'description', 'profile', 'vision', 'roles', 'units', 'cadences', 'tunables', 'routing', 'playbooks', 'budget', 'cards', 'origin']);
const ROLE_KEYS = new Set(['roleId', 'title', 'charter', 'reportsTo', 'scopes', 'modelTier', 'monthlyUsd']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class BlueprintError extends Error {}

const fail = (msg: string): never => { throw new BlueprintError(`invalid blueprint: ${msg}`); };
const str = (v: unknown, what: string, max: number, required = false): string => {
  if (v === undefined || v === null) { if (required) fail(`${what} is required`); return ''; }
  if (typeof v !== 'string') return fail(`${what} must be a string`);
  if (v.length > max) return fail(`${what} exceeds ${max} characters`);
  if (/[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/.test(v)) return fail(`${what} contains invisible unicode`);
  return v;
};
const num = (v: unknown, what: string, min: number, max: number, fallback?: number): number => {
  if (v === undefined || v === null) { if (fallback === undefined) return fail(`${what} is required`); return fallback; }
  const n = Number(v);
  if (!Number.isFinite(n)) return fail(`${what} must be a number`);
  if (n < min || n > max) return fail(`${what} must be within ${min}–${max}`);
  return n;
};
const onlyKeys = (o: Record<string, unknown>, allowed: Set<string>, what: string) => {
  for (const k of Object.keys(o)) if (!allowed.has(k)) fail(`${what} has an unknown field "${k}"`);
};

const arr = (v: unknown, what: string, max: number): unknown[] => {
  if (!Array.isArray(v)) return fail(`${what} must be an array`);
  if (v.length > max) return fail(`${what} has ${v.length} entries; the cap is ${max}`);
  return v as unknown[];
};

/** Strict validation; returns a normalised copy. Throws BlueprintError. */
export function validateBlueprint(raw: unknown): Blueprint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('not an object');
  const bytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (bytes > BLUEPRINT_MAX_BYTES) fail(`${bytes} bytes exceeds the ${BLUEPRINT_MAX_BYTES} byte cap`);
  const o = raw as Record<string, unknown>;
  onlyKeys(o, TOP_KEYS, 'the blueprint');
  if (o.format !== BLUEPRINT_FORMAT) fail(`format must be "${BLUEPRINT_FORMAT}"`);
  const name = str(o.name, 'name', 80, true).trim();
  if (!name) fail('name is required');
  const description = str(o.description, 'description', 2_000);

  const p = (o.profile ?? {}) as Record<string, unknown>;
  if (typeof p !== 'object' || Array.isArray(p)) fail('profile must be an object');
  onlyKeys(p, new Set(['values', 'culture', 'rules']), 'profile');
  const profile = { values: str(p.values, 'profile.values', 8_000), culture: str(p.culture, 'profile.culture', 8_000), rules: str(p.rules, 'profile.rules', 8_000) };

  let vision: Blueprint['vision'];
  if (o.vision !== undefined && o.vision !== null) {
    const v = o.vision as Record<string, unknown>;
    if (typeof v !== 'object' || Array.isArray(v)) fail('vision must be an object');
    onlyKeys(v, new Set(['title', 'description', 'horizonDays']), 'vision');
    vision = { title: str(v.title, 'vision.title', 200, true), description: str(v.description, 'vision.description', 4_000), horizonDays: Math.floor(num(v.horizonDays, 'vision.horizonDays', 1, 3_650, 90)) };
  }

  const rolesRaw = Array.isArray(o.roles) && o.roles.length > BLUEPRINT_MAX_ROLES ? fail(`${o.roles.length} roles exceeds the cap of ${BLUEPRINT_MAX_ROLES}`) : arr(o.roles, 'roles', BLUEPRINT_MAX_ROLES);
  if (rolesRaw.length === 0) fail('roles must be a non-empty array');
  const roles: BlueprintRole[] = rolesRaw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return fail(`roles[${i}] must be an object`);
    const x = r as Record<string, unknown>;
    onlyKeys(x, ROLE_KEYS, `roles[${i}]`);
    const title = str(x.title, `roles[${i}].title`, 80, true).trim();
    if (!title) fail(`roles[${i}].title is required`);
    const roleId = x.roleId === undefined || x.roleId === null ? undefined : str(x.roleId, `roles[${i}].roleId`, 64);
    if (roleId !== undefined && !ID_RE.test(roleId)) fail(`roles[${i}].roleId must be a slug`);
    const reportsTo = x.reportsTo === null || x.reportsTo === undefined ? null : str(x.reportsTo, `roles[${i}].reportsTo`, 80).trim() || null;
    let scopes: string[] = [];
    if (x.scopes !== undefined) {
      if (!Array.isArray(x.scopes) || x.scopes.length > 40) fail(`roles[${i}].scopes must be an array of at most 40`);
      try { scopes = parseScopes(x.scopes); } catch (err) { fail(`roles[${i}].scopes: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const modelTier = (x.modelTier ?? 'standard') as ModelTier;
    if (!MODEL_TIERS.includes(modelTier)) fail(`roles[${i}].modelTier must be one of ${MODEL_TIERS.join(', ')}`);
    return { ...(roleId ? { roleId } : {}), title, charter: str(x.charter, `roles[${i}].charter`, 20_000), reportsTo, scopes, modelTier, monthlyUsd: num(x.monthlyUsd, `roles[${i}].monthlyUsd`, 0, 100_000, 0) };
  });
  // Structure: unique titles, one root, every reportsTo resolves, no cycles, depth ≤ 3, fan-out ≤ 5.
  const titles = new Set<string>();
  for (const r of roles) { const k = r.title.toLowerCase(); if (titles.has(k)) fail(`duplicate role title "${r.title}"`); titles.add(k); }
  const roots = roles.filter((r) => r.reportsTo === null);
  if (roots.length !== 1) fail(`exactly one role reports to nobody (the chief of staff); found ${roots.length}`);
  const byTitle = new Map(roles.map((r) => [r.title.toLowerCase(), r]));
  const depthOf = (r: BlueprintRole, seen = new Set<string>()): number => {
    if (r.reportsTo === null) return 1;
    if (seen.has(r.title)) return fail(`reporting cycle at "${r.title}"`);
    seen.add(r.title);
    const parent = byTitle.get(r.reportsTo.toLowerCase());
    if (!parent) return fail(`"${r.title}" reports to unknown role "${r.reportsTo}"`);
    return depthOf(parent, seen) + 1;
  };
  for (const r of roles) {
    const d = depthOf(r);
    if (d > BLUEPRINT_MAX_DEPTH) fail(`"${r.title}" sits at depth ${d}; the cap is ${BLUEPRINT_MAX_DEPTH}`);
    const reports = roles.filter((x) => x.reportsTo && x.reportsTo.toLowerCase() === r.title.toLowerCase()).length;
    if (reports > BLUEPRINT_MAX_FANOUT) fail(`"${r.title}" has ${reports} direct reports; the cap is ${BLUEPRINT_MAX_FANOUT}`);
  }

  let units: Blueprint['units'];
  if (o.units !== undefined) {
    units = arr(o.units, 'units', BLUEPRINT_MAX_ROLES).map((u, i) => {
      const x = (u ?? {}) as Record<string, unknown>;
      onlyKeys(x, new Set(['title', 'parent']), `units[${i}]`);
      return { title: str(x.title, `units[${i}].title`, 80, true), parent: x.parent === null || x.parent === undefined ? null : str(x.parent, `units[${i}].parent`, 80) };
    });
  }
  let cadences: Blueprint['cadences'];
  if (o.cadences !== undefined) {
    cadences = arr(o.cadences, 'cadences', BLUEPRINT_MAX_CADENCES).map((c, i) => {
      const x = (c ?? {}) as Record<string, unknown>;
      onlyKeys(x, new Set(['unitTitle', 'kind', 'cron']), `cadences[${i}]`);
      const kind = str(x.kind, `cadences[${i}].kind`, 40, true);
      if (!/^[a-z_]+$/.test(kind)) fail(`cadences[${i}].kind must be a word`);
      const cron = str(x.cron, `cadences[${i}].cron`, 60, true);
      if (!/^[\d*,/ -]+$/.test(cron) || cron.trim().split(/\s+/).length !== 5) fail(`cadences[${i}].cron must be a five-field cron`);
      return { unitTitle: str(x.unitTitle, `cadences[${i}].unitTitle`, 80) || 'root', kind, cron };
    });
  }
  const tunables: Record<string, number> = {};
  if (o.tunables !== undefined) {
    if (!o.tunables || typeof o.tunables !== 'object' || Array.isArray(o.tunables)) fail('tunables must be an object');
    const entries = Object.entries(o.tunables as Record<string, unknown>);
    if (entries.length > 100) fail('tunables has more than 100 keys');
    for (const [k, v] of entries) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(k)) fail(`tunables key "${k}" is not a key`);
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`tunables.${k} must be a number`);
      tunables[k] = v;
    }
  }
  let routing: Blueprint['routing'];
  if (o.routing !== undefined) {
    if (!o.routing || typeof o.routing !== 'object' || Array.isArray(o.routing)) fail('routing must be an object');
    routing = {};
    for (const [k, v] of Object.entries(o.routing as Record<string, unknown>).slice(0, 20)) {
      if (!/^[a-z][a-z0-9_-]{0,40}$/.test(k)) fail(`routing key "${k}" is not a task class`);
      const tier = str(v, `routing.${k}`, 20);
      if (!MODEL_TIERS.includes(tier as ModelTier)) fail(`routing.${k} must be a model tier`);
      routing[k] = tier;
    }
  }
  const playbooks: Blueprint['playbooks'] = [];
  if (o.playbooks !== undefined) {
    for (const [i, pb] of arr(o.playbooks, 'playbooks', BLUEPRINT_MAX_PLAYBOOKS).entries()) {
      const x = (pb ?? {}) as Record<string, unknown>;
      onlyKeys(x, new Set(['name', 'skillMd']), `playbooks[${i}]`);
      const n = str(x.name, `playbooks[${i}].name`, 64, true).toLowerCase();
      if (!ID_RE.test(n)) fail(`playbooks[${i}].name must be a slug`);
      const md = str(x.skillMd, `playbooks[${i}].skillMd`, 64 * 1024, true);
      if (!/^\uFEFF?---\r?\n/.test(md)) fail(`playbooks[${i}].skillMd must be a SKILL.md (frontmatter first)`);
      playbooks.push({ name: n, skillMd: md });
    }
  }
  const b = (o.budget ?? {}) as Record<string, unknown>;
  if (typeof b !== 'object' || Array.isArray(b)) fail('budget must be an object');
  onlyKeys(b, new Set(['monthlyUsd', 'allocations']), 'budget');
  const budget: Blueprint['budget'] = { monthlyUsd: num(b.monthlyUsd, 'budget.monthlyUsd', 0, 1_000_000, 0) };
  if (b.allocations !== undefined) {
    if (!b.allocations || typeof b.allocations !== 'object' || Array.isArray(b.allocations)) fail('budget.allocations must be an object');
    budget.allocations = {};
    for (const [k, v] of Object.entries(b.allocations as Record<string, unknown>)) {
      if (!titles.has(k.toLowerCase())) fail(`budget.allocations names unknown role "${k}"`);
      budget.allocations[k] = num(v, `budget.allocations["${k}"]`, 0, 100_000);
    }
  }
  let cards: string[] | undefined;
  if (o.cards !== undefined) {
    cards = arr(o.cards, 'cards', 40).map((c, i) => { const id = str(c, `cards[${i}]`, 64, true); if (!ID_RE.test(id)) fail(`cards[${i}] must be a card id`); return id; });
  }
  const og = (o.origin ?? {}) as Record<string, unknown>;
  if (typeof og !== 'object' || Array.isArray(og)) fail('origin must be an object');
  onlyKeys(og, new Set(['exportedFrom', 'at', 'sourceOrgId']), 'origin');
  const origin = { exportedFrom: str(og.exportedFrom, 'origin.exportedFrom', 80), at: str(og.at, 'origin.at', 40), sourceOrgId: str(og.sourceOrgId, 'origin.sourceOrgId', 64) };

  return { format: BLUEPRINT_FORMAT, name, description, profile, ...(vision ? { vision } : {}), roles, ...(units ? { units } : {}), ...(cadences ? { cadences } : {}), tunables, ...(routing ? { routing } : {}), playbooks, budget, ...(cards ? { cards } : {}), origin };
}

/** The root role (reports to nobody) — validated blueprints have exactly one. */
export function rootRole(bp: Blueprint): BlueprintRole {
  return bp.roles.find((r) => r.reportsTo === null)!;
}

/** Roles in hire order: parents before children (breadth-first from the root). */
export function hireOrder(bp: Blueprint): BlueprintRole[] {
  const root = rootRole(bp);
  const out: BlueprintRole[] = [];
  const queue = [root];
  while (queue.length) {
    const r = queue.shift()!;
    for (const c of bp.roles.filter((x) => x.reportsTo && x.reportsTo.toLowerCase() === r.title.toLowerCase())) { out.push(c); queue.push(c); }
  }
  return out;
}

/** Units implied by the chart: every role with a report leads one. */
export function unitsOf(bp: Blueprint): Array<{ title: string; parent: string | null }> {
  const byTitle = new Map(bp.roles.map((r) => [r.title.toLowerCase(), r]));
  const leads = bp.roles.filter((r) => bp.roles.some((x) => x.reportsTo && x.reportsTo.toLowerCase() === r.title.toLowerCase()));
  return leads.map((l) => {
    let cur = l.reportsTo ? byTitle.get(l.reportsTo.toLowerCase()) : undefined;
    while (cur && !leads.includes(cur)) cur = cur.reportsTo ? byTitle.get(cur.reportsTo.toLowerCase()) : undefined;
    return { title: l.title, parent: cur?.title ?? null };
  });
}
