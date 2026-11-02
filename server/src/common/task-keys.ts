/**
 * Task keys (docs/tasks-keys.md): Jira-style `<PREFIX>-<n>` names for tasks.
 *
 * Every board owns a short uppercase prefix — a unit board of an
 * organization (the root unit from the company name, a function unit from
 * its function: ENG, SALES, FIN…) or an agent's own kanban board (from the
 * agent's handle: evidence-lead → EVL). Prefixes are unique within a
 * workspace, so a key names exactly one task there. Each prefix has one
 * counter row in `task_key_counters`; a new task takes the next number with
 * one `UPDATE … SET next = next + 1 RETURNING`, which Postgres serializes on
 * the row lock, so concurrent creates never share a number. Numbers are
 * never reused (a deleted task's number stays spent), a task moved to
 * another unit keeps its key, and a renamed prefix keeps its old counter row
 * so old keys stay unique and resolvable.
 *
 * Pure derivation and the resolver up top; the store functions below run on
 * any pg-shaped `query()` (the migrator's Queryable, or `queryableOf(db)` on
 * the Drizzle handle), so the boot backfill and the services share one path.
 */
import { sql, type SQL } from 'drizzle-orm';
import { functionOfRole } from '../files/layout';

// ---- shapes ----

/** A prefix: a letter then 1–5 letters or digits. */
export const PREFIX_RE = /^[A-Z][A-Z0-9]{1,5}$/;
/** A whole key, case-insensitive (tool input). */
export const TASK_KEY_RE = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,7})$/;
/** Keys inside free text (chips): uppercase only, on word boundaries. */
export const TASK_KEY_IN_TEXT_RE = /(^|[^\w-])([A-Z][A-Z0-9]{1,5}-\d{1,7})(?![\w-])/g;

export function isTaskKey(s: string): boolean { return TASK_KEY_RE.test((s ?? '').trim()); }

/** `eng-12` → `ENG-12`; null when not key-shaped. */
export function normalizeTaskKey(s: string): string | null {
  const m = TASK_KEY_RE.exec((s ?? '').trim());
  return m ? `${m[1].toUpperCase()}-${Number(m[2])}` : null;
}

/** How a task is named to people and models: its key, else the 8-char id prefix (a row from before keys). */
export function taskRef(t: { id: string; key?: string | null }): string {
  return t.key || t.id.slice(0, 8);
}

/** `ENG-12 Title` — the one-line name of a task everywhere. */
export function taskLabel(t: { id: string; key?: string | null; title: string }): string {
  return `${taskRef(t)} ${t.title}`;
}

// ---- derivation ----

/** Function id (files/layout.ts ORG_FUNCTIONS) → board prefix. */
export const FUNCTION_PREFIX: Readonly<Record<string, string>> = {
  sales: 'SALES', marketing: 'MKT', customer: 'CS', product: 'PROD', engineering: 'ENG', design: 'DSN',
  data: 'DATA', finance: 'FIN', people: 'PPL', legal: 'LEGAL', operations: 'OPS', 'it-security': 'IT', revops: 'REV',
};

/** Words in a free title that name a function (first match wins; revops before sales and ops). */
const FUNCTION_WORDS: Array<[RegExp, string]> = [
  [/\b(revops|revenue operations|revenue ops)\b/, 'revops'],
  [/\b(sales|sdr|bdr|account executive|business development)\b/, 'sales'],
  [/\b(marketing|growth|brand|content|seo)\b/, 'marketing'],
  [/\b(customer|support|success|cs|helpdesk)\b/, 'customer'],
  [/\b(product|pm)\b/, 'product'],
  [/\b(engineering|engineer|developer|software|platform|backend|frontend|devops|cto)\b/, 'engineering'],
  [/\b(design|designer|ux|ui)\b/, 'design'],
  [/\b(data|analytics|analyst|bi)\b/, 'data'],
  [/\b(finance|financial|accounting|accountant|cfo|controller|bookkeeping)\b/, 'finance'],
  [/\b(people|hr|human resources|talent|recruiting|recruiter)\b/, 'people'],
  [/\b(legal|counsel|compliance|lawyer)\b/, 'legal'],
  [/\b(operations|ops|coo)\b/, 'operations'],
  [/\b(it|security|infosec)\b/, 'it-security'],
];

/** The job function a member title names: a catalog role id
 *  (`engineering-manager`, `cs-manager`) or a free title ("Head of Sales"). */
export function functionOfTitle(title: string | null | undefined): string | null {
  const raw = (title ?? '').trim();
  if (!raw) return null;
  const byRole = functionOfRole(raw);
  if (byRole) return byRole;
  const hay = raw.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const [re, fn] of FUNCTION_WORDS) if (re.test(hay)) return fn;
  return null;
}

const STOP = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'gmbh', 'plc', 'the', 'of', 'and', 'for', 's', 'team', 'unit', 'group', 'head', 'lead', 'manager', 'director', 'chief', 'vp']);

/**
 * A prefix from a name: one word ≤ 4 letters whole (Jong → JONG), a longer
 * one its first three (Research → RES); two words the first two letters of
 * the first and the first of the second (evidence-lead → EVL); three or more
 * the initials, at most four (Acme Widget Works → AWW). Filler words (Inc,
 * team, head, of…) drop out unless nothing else is left. Null when the name
 * has no letters.
 */
export function prefixFromName(name: string | null | undefined): string | null {
  const all = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = all.filter((w) => !STOP.has(w));
  const words = (kept.length ? kept : all).map((w, i) => (i === 0 ? w.replace(/^[0-9]+/, '') : w)).filter(Boolean);
  if (!words.length || !/^[a-z]/.test(words[0])) return null;
  let p: string;
  if (words.length === 1) p = words[0].length <= 4 ? words[0] : words[0].slice(0, 3);
  else if (words.length === 2) p = words[0].slice(0, 2) + words[1][0];
  else p = words.slice(0, 4).map((w) => w[0]).join('');
  p = p.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (p.length < 2) p = (p + 'X').slice(0, 2);
  return PREFIX_RE.test(p) ? p : null;
}

/** The prefix a unit board starts from: the root from the company name
 *  (else CO); a function unit its function's code; any other unit its
 *  lead's title, then its lead's name (else TEAM). */
export function unitPrefixBase(u: { root: boolean; orgName?: string | null; leadTitle?: string | null; leadName?: string | null; unitName?: string | null }): string {
  if (u.root) return prefixFromName(u.orgName) ?? 'CO';
  const fn = functionOfTitle(u.leadTitle);
  if (fn && FUNCTION_PREFIX[fn]) return FUNCTION_PREFIX[fn];
  return prefixFromName(u.leadTitle) ?? prefixFromName(u.leadName) ?? prefixFromName(u.unitName) ?? 'TEAM';
}

/** The agent's handle: the last segment of `agents/<handle>`, else its slugified name. */
export function agentHandle(a: { name: string; homeDir?: string | null; id?: string }): string {
  const seg = (a.homeDir ?? '').split('/').filter(Boolean).at(-1) ?? '';
  if (seg && seg !== a.id && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(seg)) return seg;
  return (a.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The prefix an agent's own board starts from (its handle; else AG). */
export function agentPrefixBase(a: { name: string; homeDir?: string | null; id?: string }): string {
  return prefixFromName(agentHandle(a)) ?? prefixFromName(a.name) ?? 'AG';
}

/** `base`, then base2, base3… — each a valid prefix of at most 6 characters. */
export function prefixCandidates(base: string, max = 60): string[] {
  const out = [base];
  for (let n = 2; out.length < max; n++) out.push(`${base.slice(0, 6 - String(n).length)}${n}`);
  return out;
}

/** The first candidate not taken (case-insensitive). */
export function uniquePrefix(base: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map((x) => x.toUpperCase()));
  return prefixCandidates(base, 1000).find((p) => !t.has(p))!;
}

/** Validate an owner-typed prefix ("eng" → "ENG"); throws a sentence. */
export function normalizePrefix(input: unknown): string {
  const p = String(input ?? '').trim().toUpperCase();
  if (!PREFIX_RE.test(p)) throw new Error('a task key prefix is 2–6 letters or digits starting with a letter (e.g. ENG, SALES, OPS2)');
  return p;
}

// ---- the resolver ----

/**
 * Find one task among `rows` by key (case-insensitive: ENG-12, eng-12,
 * #ENG-12, [ENG-12]), full id, or id prefix (the 8 characters older output
 * showed). Throws a sentence naming the candidates when nothing or more
 * than one matches.
 */
export function resolveTaskRef<T extends { id: string; key?: string | null; title?: string }>(rows: readonly T[], ref: string, opts: { what?: string; hint?: string } = {}): T {
  const raw = String(ref ?? '').trim().replace(/^#/, '').replace(/^\[(.*)\]$/, '$1').trim();
  if (!raw) throw new Error(`${opts.what ?? 'taskId'} is required`);
  const hits = matchTaskRef(rows, raw);
  if (hits.length === 1) return hits[0];
  const hint = opts.hint ?? 'refer to a task by its key, e.g. ENG-12';
  if (hits.length === 0) throw new Error(`task "${raw}" matches 0 tasks — ${hint}`);
  throw new Error(`task "${raw}" matches ${hits.length} tasks (${hits.slice(0, 5).map((t) => taskRef(t)).join(', ')}) — use the full key`);
}

/** Every row `ref` could name: the key match wins, then the exact id, then id prefixes. */
export function matchTaskRef<T extends { id: string; key?: string | null }>(rows: readonly T[], ref: string): T[] {
  const raw = String(ref ?? '').trim();
  if (!raw) return [];
  const key = normalizeTaskKey(raw);
  if (key) {
    const byKey = rows.filter((t) => (t.key ?? '').toUpperCase() === key);
    if (byKey.length) return byKey;
  }
  const exact = rows.filter((t) => t.id === raw);
  if (exact.length) return exact;
  const lower = raw.toLowerCase();
  return rows.filter((t) => t.id.startsWith(lower));
}

// ---- the store ----

export interface KeyQueryable { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }

/** The Drizzle handle as a pg-shaped `query()` (raw SQL, parameters bound). */
export function queryableOf(db: { execute(q: SQL): Promise<unknown> }): KeyQueryable {
  return {
    query: async (text, params = []) => {
      const chunks: SQL[] = [];
      let last = 0;
      for (const m of text.matchAll(/\$(\d+)/g)) {
        chunks.push(sql.raw(text.slice(last, m.index)));
        chunks.push(sql`${params[Number(m[1]) - 1]}`);
        last = m.index! + m[0].length;
      }
      chunks.push(sql.raw(text.slice(last)));
      const res = await db.execute(sql.join(chunks, sql.raw('')));
      return { rows: ((res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : [])) as unknown[] };
    },
  };
}

type Owner = { kind: 'unit' | 'agent' | 'org'; id: string; scopeId: string; accountId: string; base: string; alsoOwnedBy?: string[] };

/** Claim the first free prefix for an owner in its scope (atomic per prefix:
 *  the counter row's primary key is the lock). A prefix the owner already
 *  holds is taken back as is. */
async function claimPrefix(q: KeyQueryable, o: Owner): Promise<string> {
  const mine = new Set([o.id, ...(o.alsoOwnedBy ?? [])]);
  for (const p of prefixCandidates(o.base)) {
    const ins = await q.query(
      `INSERT INTO task_key_counters ("accountId", "scopeId", "prefix", "ownerKind", "ownerId", "next", "createdAt") VALUES ($1, $2, $3, $4, $5, 0, $6) ON CONFLICT ("scopeId", "prefix") DO NOTHING RETURNING "prefix"`,
      [o.accountId, o.scopeId, p, o.kind, o.id, new Date().toISOString()],
    );
    if (ins.rows.length) return p;
    const cur = (await q.query(`SELECT "ownerId" FROM task_key_counters WHERE "scopeId" = $1 AND "prefix" = $2`, [o.scopeId, p])).rows[0] as { ownerId: string } | undefined;
    if (cur && mine.has(cur.ownerId)) {
      if (cur.ownerId !== o.id) await q.query(`UPDATE task_key_counters SET "ownerKind" = $3, "ownerId" = $4 WHERE "scopeId" = $1 AND "prefix" = $2`, [o.scopeId, p, o.kind, o.id]);
      return p;
    }
  }
  throw new Error('no free task key prefix');
}

/** The next number of `prefix` in `scopeId` (the counter row exists once the prefix is claimed). */
export async function nextTaskNumber(q: KeyQueryable, scopeId: string, prefix: string): Promise<number> {
  const res = await q.query(`UPDATE task_key_counters SET "next" = "next" + 1 WHERE "scopeId" = $1 AND "prefix" = $2 RETURNING "next"`, [scopeId, prefix]);
  const n = (res.rows[0] as { next: number } | undefined)?.next;
  if (n === undefined) throw new Error(`no task key counter for ${prefix}`);
  return Number(n);
}

interface UnitRow { id: string; orgId: string; parentUnitId: string | null; name: string; taskKey: string | null; accountId: string; workspaceId: string; orgName: string; leadTitle: string | null; leadName: string | null }

async function unitRow(q: KeyQueryable, unitId: string): Promise<UnitRow | null> {
  return ((await q.query(`
    SELECT u."id", u."orgId", u."parentUnitId", u."name", u."taskKey", u."accountId", o."workspaceId", o."name" AS "orgName", m."title" AS "leadTitle", a."name" AS "leadName"
      FROM org_units u JOIN organizations o ON o."id" = u."orgId"
      LEFT JOIN org_members m ON m."orgId" = u."orgId" AND m."agentId" = u."leadAgentId"
      LEFT JOIN agents a ON a."id" = u."leadAgentId"
     WHERE u."id" = $1`, [unitId])).rows[0] as UnitRow | undefined) ?? null;
}

/** The unit's prefix, assigned on first use. */
export async function ensureUnitPrefix(q: KeyQueryable, unitId: string): Promise<{ prefix: string; scopeId: string } | null> {
  const u = await unitRow(q, unitId);
  if (!u) return null;
  const scopeId = u.workspaceId || `org:${u.orgId}`;
  if (u.taskKey) return { prefix: u.taskKey, scopeId };
  const root = u.parentUnitId === null;
  const prefix = await claimPrefix(q, { kind: 'unit', id: u.id, scopeId, accountId: u.accountId, base: unitPrefixBase({ root, orgName: u.orgName, leadTitle: u.leadTitle, leadName: u.leadName, unitName: u.name }), alsoOwnedBy: root ? [u.orgId] : [] });
  const set = await q.query(`UPDATE org_units SET "taskKey" = $2 WHERE "id" = $1 AND ("taskKey" IS NULL OR "taskKey" = '') RETURNING "taskKey"`, [u.id, prefix]);
  if (set.rows.length) return { prefix, scopeId };
  return { prefix: (await unitRow(q, unitId))?.taskKey ?? prefix, scopeId };
}

/** The org's board prefix when a task has no unit: the root unit's, else
 *  one held by the organization itself (the root unit adopts it later). */
async function orgPrefix(q: KeyQueryable, orgId: string): Promise<{ prefix: string; scopeId: string } | null> {
  const root = (await q.query(`SELECT "id" FROM org_units WHERE "orgId" = $1 AND "parentUnitId" IS NULL ORDER BY ("archivedAt" IS NULL) DESC, "createdAt" ASC LIMIT 1`, [orgId])).rows[0] as { id: string } | undefined;
  if (root) return ensureUnitPrefix(q, root.id);
  const o = (await q.query(`SELECT "id", "name", "workspaceId", "accountId" FROM organizations WHERE "id" = $1`, [orgId])).rows[0] as { id: string; name: string; workspaceId: string; accountId: string } | undefined;
  if (!o) return null;
  const scopeId = o.workspaceId || `org:${o.id}`;
  return { prefix: await claimPrefix(q, { kind: 'org', id: o.id, scopeId, accountId: o.accountId, base: prefixFromName(o.name) ?? 'CO' }), scopeId };
}

/** The key for a new org task on `unitId` (or the org's board without one). */
export async function nextOrgTaskKey(q: KeyQueryable, orgId: string, unitId: string | null): Promise<string | null> {
  const p = (unitId ? await ensureUnitPrefix(q, unitId) : null) ?? await orgPrefix(q, orgId);
  if (!p) return null;
  return `${p.prefix}-${await nextTaskNumber(q, p.scopeId, p.prefix)}`;
}

interface AgentRow { id: string; name: string; homeDir: string | null; workspaceId: string; accountId: string; taskKey: string | null }

/** The agent's board prefix, assigned on first use. */
export async function ensureAgentPrefix(q: KeyQueryable, agentId: string): Promise<{ prefix: string; scopeId: string } | null> {
  const read = async () => ((await q.query(`SELECT "id", "name", "homeDir", "workspaceId", "accountId", "taskKey" FROM agents WHERE "id" = $1`, [agentId])).rows[0] as AgentRow | undefined) ?? null;
  const a = await read();
  if (!a) return null;
  const scopeId = a.workspaceId || `account:${a.accountId}`;
  if (a.taskKey) return { prefix: a.taskKey, scopeId };
  const prefix = await claimPrefix(q, { kind: 'agent', id: a.id, scopeId, accountId: a.accountId, base: agentPrefixBase(a) });
  const set = await q.query(`UPDATE agents SET "taskKey" = $2 WHERE "id" = $1 AND ("taskKey" IS NULL OR "taskKey" = '') RETURNING "taskKey"`, [a.id, prefix]);
  if (set.rows.length) return { prefix, scopeId };
  return { prefix: (await read())?.taskKey ?? prefix, scopeId };
}

/** The key for a new task on the agent's own board. */
export async function nextAgentTaskKey(q: KeyQueryable, agentId: string): Promise<string | null> {
  const p = await ensureAgentPrefix(q, agentId);
  if (!p) return null;
  return `${p.prefix}-${await nextTaskNumber(q, p.scopeId, p.prefix)}`;
}

/**
 * Rename a board's prefix (the owner or the chief, docs/tasks-keys.md):
 * new tasks take the new prefix from 1 (or where it left off, when the
 * board held it before); existing tasks keep their keys. Refused when
 * another board of the workspace holds or held the prefix.
 */
export async function renamePrefix(q: KeyQueryable, owner: { kind: 'unit' | 'agent'; id: string }, input: unknown): Promise<string> {
  const p = normalizePrefix(input);
  const cur = owner.kind === 'unit' ? await ensureUnitPrefix(q, owner.id) : await ensureAgentPrefix(q, owner.id);
  if (!cur) throw new Error(`${owner.kind} not found`);
  if (cur.prefix === p) return p;
  const acct = owner.kind === 'unit'
    ? (await unitRow(q, owner.id))!.accountId
    : ((await q.query(`SELECT "accountId" FROM agents WHERE "id" = $1`, [owner.id])).rows[0] as { accountId: string }).accountId;
  const ins = await q.query(
    `INSERT INTO task_key_counters ("accountId", "scopeId", "prefix", "ownerKind", "ownerId", "next", "createdAt") VALUES ($1, $2, $3, $4, $5, 0, $6) ON CONFLICT ("scopeId", "prefix") DO NOTHING RETURNING "prefix"`,
    [acct, cur.scopeId, p, owner.kind, owner.id, new Date().toISOString()],
  );
  if (!ins.rows.length) {
    const held = (await q.query(`SELECT "ownerId" FROM task_key_counters WHERE "scopeId" = $1 AND "prefix" = $2`, [cur.scopeId, p])).rows[0] as { ownerId: string } | undefined;
    if (held?.ownerId !== owner.id) throw new Error(`the prefix ${p} is taken in this workspace — pick another`);
  }
  await q.query(owner.kind === 'unit' ? `UPDATE org_units SET "taskKey" = $2 WHERE "id" = $1` : `UPDATE agents SET "taskKey" = $2 WHERE "id" = $1`, [owner.id, p]);
  return p;
}

/**
 * The boot backfill (migration 0052, also callable on its own): every task
 * without a key gets one, board by board in creation order (createdAt, then
 * id), continuing from the board's counter. Idempotent: keyed rows are
 * skipped and counters only grow.
 */
export async function backfillTaskKeys(q: KeyQueryable): Promise<{ org: number; agent: number }> {
  let org = 0; let agent = 0;
  const orgRows = (await q.query(`SELECT "id", "orgId", "unitId" FROM org_tasks WHERE "key" IS NULL OR "key" = '' ORDER BY "createdAt" ASC, "id" ASC`)).rows as Array<{ id: string; orgId: string; unitId: string | null }>;
  for (const t of orgRows) {
    const exists = t.unitId ? (await q.query(`SELECT 1 FROM org_units WHERE "id" = $1`, [t.unitId])).rows.length > 0 : false;
    const key = await nextOrgTaskKey(q, t.orgId, exists ? t.unitId : null);
    if (!key) continue;
    await q.query(`UPDATE org_tasks SET "key" = $2 WHERE "id" = $1`, [t.id, key]);
    org++;
  }
  const agentRows = (await q.query(`SELECT "id", "agentId" FROM agent_tasks WHERE "key" IS NULL OR "key" = '' ORDER BY "createdAt" ASC, "id" ASC`)).rows as Array<{ id: string; agentId: string }>;
  for (const t of agentRows) {
    const key = await nextAgentTaskKey(q, t.agentId);
    if (!key) continue;
    await q.query(`UPDATE agent_tasks SET "key" = $2 WHERE "id" = $1`, [t.id, key]);
    agent++;
  }
  return { org, agent };
}
