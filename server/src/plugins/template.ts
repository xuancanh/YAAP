/**
 * The declarative selector, template and match language of manifest v1
 * (docs/plugins.md §3.2 "No expressions"). Nothing here evaluates code:
 *
 *  - **paths**: `$`, `$.a.b`, `$.items[0].id` — a JSONPath subset;
 *  - **templates**: `{{input.repo}}`, `{{output.sha}}`, `{{fixtures.x}}`,
 *    `{{settings.k}}`, `{{applied.k}}`, `{{bind.k}}`, `{{run}}`, and saved
 *    names in a conformance case. A string that is exactly one `{{…}}`
 *    keeps the value's type; otherwise values are spliced in as text;
 *  - **match expressions**: `$.path == 'literal'`, `$.n != 3`,
 *    `$.sha == {{applied.sha}}`, joined only by `&&`;
 *  - **globs**: resource patterns where `*` matches anything.
 *
 * Pure.
 */

const SEGMENT_RE = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d{1,4})\]/y;

/** The value at a `$`-rooted path; undefined when absent or malformed. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '$') return value;
  if (!path.startsWith('$')) return undefined;
  let cur: unknown = value;
  SEGMENT_RE.lastIndex = 1;
  let pos = 1;
  while (pos < path.length) {
    SEGMENT_RE.lastIndex = pos;
    const m = SEGMENT_RE.exec(path);
    if (!m || m.index !== pos) return undefined;
    pos = SEGMENT_RE.lastIndex;
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = m[1] !== undefined ? (cur as Record<string, unknown>)[m[1]] : (cur as unknown[])[Number(m[2])];
  }
  return cur;
}

export function isPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith('$') || p.length > 200) return false;
  if (p === '$') return true;
  let pos = 1;
  while (pos < p.length) {
    SEGMENT_RE.lastIndex = pos;
    const m = SEGMENT_RE.exec(p);
    if (!m || m.index !== pos) return false;
    pos = SEGMENT_RE.lastIndex;
  }
  return true;
}

const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const EXPR_RE = /^(?:(input|output|fixtures|settings|applied|bind|params|resource)(?:\.[A-Za-z_][A-Za-z0-9_]*)*|run|[a-z][A-Za-z0-9_]{0,30}|(?:secret|connection):[A-Za-z0-9_-]{1,40})$/;

/** Problems with the `{{…}}` placeholders in a string; [] when they are plain references. */
export function checkTemplateString(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(TEMPLATE_RE)) if (!EXPR_RE.test(m[1])) out.push(`"{{${m[1]}}}" is not a plain reference (expressions are not allowed)`);
  if (/\{\{(?![^{}]*\}\})/.test(s)) out.push('an unclosed "{{"');
  return out;
}

/** Every template problem anywhere inside a value. */
export function checkTemplates(v: unknown, path = '', depth = 0): string[] {
  if (depth > 20) return [`${path}: nested too deep`];
  if (typeof v === 'string') return checkTemplateString(v).map((e) => `${path}: ${e}`);
  if (Array.isArray(v)) return v.flatMap((x, i) => checkTemplates(x, `${path}[${i}]`, depth + 1));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => checkTemplates(x, `${path}.${k}`, depth + 1));
  return [];
}

function lookup(ctx: Record<string, unknown>, expr: string): unknown {
  const parts = expr.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Fill the placeholders of a value from `ctx`. Credentials (`secret:` and
 *  `connection:`) are never filled here: the broker owns them. */
export function render(v: unknown, ctx: Record<string, unknown>, depth = 0): unknown {
  if (depth > 20) return v;
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([^{}]*?)\s*\}\}$/.exec(v);
    if (whole && !whole[1].includes(':')) {
      const x = lookup(ctx, whole[1]);
      return x === undefined ? '' : x;
    }
    return v.replace(TEMPLATE_RE, (_m, expr: string) => {
      if (expr.includes(':')) return `{{${expr}}}`;
      const x = lookup(ctx, expr);
      return x === undefined || x === null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x);
    });
  }
  if (Array.isArray(v)) return v.map((x) => render(x, ctx, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x, ctx, depth + 1)]));
  return v;
}

function literal(raw: string, ctx: Record<string, unknown>): unknown {
  const s = raw.trim();
  const tmpl = /^\{\{\s*([^{}]*?)\s*\}\}$/.exec(s);
  if (tmpl) return lookup(ctx, tmpl[1]);
  if (/^'[^']*'$/.test(s) || /^"[^"]*"$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  throw new Error(`"${s}" is not a literal`);
}

const CLAUSE_RE = /^\s*(\$[^\s=!]*)\s*(==|!=)\s*(.+?)\s*$/;

/** Problems with a match expression's grammar; [] when usable. */
export function checkMatchExpr(expr: unknown): string[] {
  if (typeof expr !== 'string' || !expr.trim() || expr.length > 500) return ['a match must be a non-empty string of at most 500 characters'];
  const out: string[] = [];
  for (const clause of expr.split('&&')) {
    const m = CLAUSE_RE.exec(clause);
    if (!m) { out.push(`"${clause.trim()}" is not "<$path> == <value>"`); continue; }
    if (!isPath(m[1])) out.push(`"${m[1]}" is not a path`);
    try { literal(m[3], {}); } catch { out.push(`"${m[3]}" is not a literal or a {{reference}}`); }
    out.push(...checkTemplateString(m[3]));
  }
  return out;
}

/** Whether `value` satisfies the expression; a malformed one never matches. */
export function matchExpr(expr: string, value: unknown, ctx: Record<string, unknown> = {}): boolean {
  if (checkMatchExpr(expr).length > 0) return false;
  return expr.split('&&').every((clause) => {
    const m = CLAUSE_RE.exec(clause)!;
    let want: unknown;
    try { want = literal(m[3], ctx); } catch { return false; }
    const got = getPath(value, m[1]);
    const eq = JSON.stringify(got) === JSON.stringify(want);
    return m[2] === '==' ? eq : !eq;
  });
}

/** `{ "$.path": expected, … }` — every path equals its value. */
export function matchWhen(when: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!when) return true;
  return Object.entries(when).every(([p, want]) => JSON.stringify(getPath(value, p)) === JSON.stringify(want));
}

/** A resource glob: `*` matches any run of characters; everything else is literal. */
export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(s);
}

/** How specific a glob is: the length of its literal text (longer wins). */
export function globSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

/** Durations written `30s`, `45m`, `2h`, `7d` → milliseconds; null when malformed. */
export function parseDuration(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,6})(s|m|h|d)$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[m[2] as 's' | 'm' | 'h' | 'd'];
}
