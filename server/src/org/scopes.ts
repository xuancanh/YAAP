/**
 * Org scopes (docs/autonomous-company.md §4.1 `org_grants`): what a member
 * may touch, as a flat set of strings so the meet rule is set intersection.
 *
 *   tool:<name>                 a tool or tool class (fs_write, web_search, run_code, browser_act, gmail_send …)
 *   connection:<service>:<lvl>  a connection service at read|write (calendar, gmail, drive …)
 *   skill:<name>                a skill the member may be given
 *   folder:<path>               a workspace folder it may be mounted
 *
 * The WIMSE delegation rule applied to rows: a child's scopes are the meet
 * (intersection) of the parent's holdings and the request, so a grant can
 * only narrow. Widening is a proposal the user answers (org-approvals).
 */

export const SCOPE_KINDS = ['tool', 'connection', 'skill', 'folder'] as const;
export type ScopeKind = typeof SCOPE_KINDS[number];

const SCOPE_RE = /^(tool|connection|skill|folder):[A-Za-z0-9_./*-]+(?::(read|write))?$/;

/** Normalise and validate a scope list; throws on an unknown shape. */
export function parseScopes(input: unknown): string[] {
  const arr = Array.isArray(input) ? input : typeof input === 'string' ? safeJson(input) : [];
  const out = new Set<string>();
  for (const raw of arr) {
    if (typeof raw !== 'string') throw new Error('scopes must be strings');
    const s = raw.trim();
    if (!s) continue;
    if (!SCOPE_RE.test(s)) throw new Error(`invalid scope "${s}" — expected kind:value (tool:fs_write, connection:gmail:read, skill:name, folder:path)`);
    if (s.startsWith('connection:') && s.split(':').length !== 3) throw new Error(`connection scope "${s}" needs a level (:read or :write)`);
    out.add(s);
  }
  return [...out].sort();
}

function safeJson(raw: string): unknown[] {
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v : []; } catch { return []; }
}

export function scopeKind(scope: string): ScopeKind {
  return scope.split(':')[0] as ScopeKind;
}

/** A connection:<svc>:write holding also covers a :read request. */
function covers(holding: string, requested: string): boolean {
  if (holding === requested) return true;
  const h = holding.split(':'); const r = requested.split(':');
  if (h[0] === 'connection' && r[0] === 'connection' && h[1] === r[1]) return h[2] === 'write' && r[2] === 'read';
  if (h[0] === 'folder' && r[0] === 'folder') return r[1].startsWith(`${h[1]}/`) || h[1] === '*';
  if (h[0] === 'tool' && r[0] === 'tool') return h[1] === '*';
  return false;
}

/** The meet of what the grantor holds and what was requested. */
export function meetScopes(holdings: string[], requested: string[]): string[] {
  return requested.filter((r) => holdings.some((h) => covers(h, r))).sort();
}

/** `next` is a narrowing of `current` when every scope in next is covered by
 *  current (equal sets count as narrowing: nothing new is granted). */
export function isNarrowing(current: string[], next: string[]): boolean {
  return next.every((n) => current.some((c) => covers(c, n)));
}

/** Scopes in `requested` that `holdings` does not cover — the diff a
 *  scope_widen approval shows the CEO. */
export function widenedScopes(holdings: string[], requested: string[]): string[] {
  return requested.filter((r) => !holdings.some((h) => covers(h, r)));
}
