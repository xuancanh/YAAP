/**
 * Semver for the plugin mechanism (docs/plugins.md §7.3): package versions,
 * interface contract versions and the core plugin API range. Only what the
 * manifest needs: `x.y.z` versions and ranges written `^x.y`, `~x.y.z`,
 * `x.y.z`, `>=x.y.z`, `*` or a bare major `x`. Pure.
 */

export interface SemVer { major: number; minor: number; patch: number }

const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const RANGE_RE = /^(\^|~|>=)?(0|[1-9]\d{0,5})(?:\.(0|[1-9]\d{0,5}))?(?:\.(0|[1-9]\d{0,5}))?$/;

export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v);
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && VERSION_RE.test(v);
}

export function isRange(r: unknown): r is string {
  return typeof r === 'string' && (r === '*' || RANGE_RE.test(r));
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return a.localeCompare(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch;
}

/** Whether `version` satisfies `range`. An invalid input never satisfies. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  if (range === '*') return true;
  const m = RANGE_RE.exec(range);
  if (!m) return false;
  const op = m[1] ?? '';
  const maj = Number(m[2]);
  const min = m[3] === undefined ? null : Number(m[3]);
  const pat = m[4] === undefined ? null : Number(m[4]);
  const lo = { major: maj, minor: min ?? 0, patch: pat ?? 0 };
  const geLo = v.major > lo.major || (v.major === lo.major && (v.minor > lo.minor || (v.minor === lo.minor && v.patch >= lo.patch)));
  switch (op) {
    case '>=': return geLo;
    case '^': return geLo && v.major === maj;
    case '~': return geLo && v.major === maj && (min === null || v.minor === min);
    default:
      if (min === null) return v.major === maj;
      if (pat === null) return v.major === maj && v.minor === min;
      return v.major === maj && v.minor === min && v.patch === pat;
  }
}

/** The major a range selects (`^1` → 1); null for `*` or `>=`. */
export function majorOf(range: string): number | null {
  if (range === '*') return null;
  const m = RANGE_RE.exec(range);
  if (!m || m[1] === '>=') return null;
  return Number(m[2]);
}

/** `name@range` → its parts; null when malformed. */
export function parseInterfaceRef(ref: string): { name: string; range: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return null;
  const name = ref.slice(0, at);
  const range = ref.slice(at + 1);
  if (!/^[a-z][a-z0-9]{1,15}$/.test(name) || !isRange(range)) return null;
  return { name, range };
}
