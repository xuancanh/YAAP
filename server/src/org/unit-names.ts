/**
 * Department names (docs/group-chat.md §7 "Department names"). Pure and
 * model-free, shared by OrgUnitsService and the boot backfill.
 *
 * A non-root unit is a department and carries its own name, not its lead's:
 *
 *  1. a catalog head's exact title names its function: "Head of
 *     Engineering" → Engineering, "Head of Customer" → Customer Success,
 *     "General Counsel" → Legal;
 *  2. a head- or manager-shaped title names what it heads: "Head of
 *     Growth" → Growth, "VP of Sales" → Sales, "Support Lead" → Support,
 *     "Design Manager" → Design (not a coordinator's "Program Manager");
 *  3. any other title that names a function: "Senior Designer" → Design;
 *  4. else `<lead>'s team` — the old default, kept only when nothing better
 *     is known.
 *
 * The root unit is the company and keeps the organization's name.
 * `nameSource` on the row says where the name came from: `derived` (these
 * rules, re-derivable), `custom` (a person, an agent or a blueprint chose
 * it — never overwritten). The unit id is the identity; a rename moves the
 * channel's name and slug (the old slug stays an alias) but never the task
 * key prefix.
 */
import { ROLES } from './roles/catalog';
import { functionOfTitle } from '../common/task-keys';
import { functionOfRole } from '../files/layout';
import { headFunction, isHeadRole } from './heads';

/** Function id (files/layout.ts ORG_FUNCTIONS, plus the catalog's `cs` / `ops`) → department name. */
export const FUNCTION_DEPARTMENT: Readonly<Record<string, string>> = {
  sales: 'Sales', marketing: 'Marketing', customer: 'Customer Success', cs: 'Customer Success', product: 'Product',
  engineering: 'Engineering', design: 'Design', data: 'Data', finance: 'Finance', people: 'People', legal: 'Legal',
  operations: 'Operations', ops: 'Operations', 'it-security': 'IT & Security', revops: 'Revenue Operations',
};

/** The fallback name of a unit nothing better is known about. */
export function teamName(leadName: string): string { return `${leadName}'s team`; }

/** Whether a name is the old `<lead>'s team` default (any lead). */
export function isTeamPattern(name: string | null | undefined): boolean { return /'s team$/i.test((name ?? '').trim()); }

/** A coordinator's title: it names a role, not what it heads. */
const COORDINATOR = /\b(program|programme|project|account|office|case|social media|delivery|engagement)\s+(manager|lead|coordinator)\b|\bcoordinator\b|\bassistant\b/i;
/** Well-known titles that name what they lead without a head's shape. */
const KNOWN: ReadonlyArray<[RegExp, string]> = [
  [/^(editor[- ]in[- ]chief|managing editor|executive editor)$/i, 'Editorial'],
  [/^principal investigator$/i, 'Research'],
  [/^(lead|head|core) maintainer$/i, 'Maintainers'],
];
/** "Head of X", "VP X", "Director of X", "General Manager, X". */
const LEADING = /^(?:head|vp|svp|evp|vice president|director|general manager|gm)\b\s*(?:of\s+|,\s*|-\s*)?(.+)$/i;
/** "X Lead", "X Director", "X Manager", "X Head". */
const TRAILING = /^(.+?)\s+(?:lead|director|manager|head|team lead)$/i;
/** Words that make a bad department name on their own. */
const GENERIC = /^(the\s+)?(team|unit|group|department|company|everything|all|general|senior|staff|principal)$/i;

function tidy(s: string): string {
  const t = s.replace(/^the\s+/i, '').replace(/\s+/g, ' ').replace(/[\s,;:–-]+$/, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/**
 * The department name of a unit from its lead (the rules above). `title` is
 * the lead's member title; `leadName` the lead agent's name.
 */
export function departmentName(input: { root?: boolean; orgName?: string | null; title?: string | null; leadName: string }): string {
  if (input.root) return (input.orgName ?? '').trim() || 'Company';
  const title = (input.title ?? '').trim();
  if (title) {
    // 1. a catalog head's exact title
    const head = ROLES.find((r) => isHeadRole(r) && r.title.toLowerCase() === title.toLowerCase());
    const fnOfHead = head ? functionOfRole(head.id) : null;
    if (fnOfHead && FUNCTION_DEPARTMENT[fnOfHead]) return FUNCTION_DEPARTMENT[fnOfHead];
    const known = KNOWN.find(([re]) => re.test(title));
    if (known) return known[1];
    // 2. what a head- or manager-shaped title heads
    if (!COORDINATOR.test(title) && !/^chief of staff$/i.test(title)) {
      const m = LEADING.exec(title) ?? TRAILING.exec(title);
      const what = m ? tidy(m[1]) : '';
      if (what && what.length <= 40 && !GENERIC.test(what)) return what;
    }
    // 3. any title naming a function ("Senior Designer", "Chief Technology Officer")
    const fn = functionOfTitle(title) ?? headFunction(title);
    if (fn && FUNCTION_DEPARTMENT[fn]) return FUNCTION_DEPARTMENT[fn];
  }
  return teamName(input.leadName);
}

/** A department name unique among `taken` (case-insensitive): "Engineering", then "Engineering (Ada)", then "Engineering 2"… */
export function uniqueDepartmentName(name: string, leadName: string, taken: Iterable<string>): string {
  const t = new Set([...taken].map((x) => x.trim().toLowerCase()));
  if (!t.has(name.toLowerCase())) return name;
  const withLead = `${name} (${leadName})`;
  if (!isTeamPattern(name) && !t.has(withLead.toLowerCase())) return withLead;
  for (let n = 2; ; n++) if (!t.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

/** A channel/unit slug from a name ("IT & Security" → it-security; mirrors groupchat/mentions.ts slugify). */
export function unitSlugOf(name: string): string {
  const s = name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'unit';
}

/** A department's slug: from its name (`#engineering`); a `<lead>'s team` fallback keeps its lead's (`#ada`). */
export function departmentSlug(name: string, leadName: string): string {
  return isTeamPattern(name) && name.trim().toLowerCase() === teamName(leadName).toLowerCase() ? unitSlugOf(leadName) : unitSlugOf(name);
}

/** `base`, else base-2, base-3… — the first not in `taken`. */
export function freeSlug(base: string, taken: ReadonlySet<string>): string {
  let s = base;
  for (let n = 2; taken.has(s); n++) s = `${base.slice(0, 44)}-${n}`;
  return s;
}

/** The trimmed, bounded name a person or an agent typed; throws a sentence. */
export function normalizeDepartmentName(raw: unknown): string {
  const n = String(raw ?? '').replace(/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new Error('a department name cannot be empty');
  if (!/[\p{L}\p{N}]/u.test(n)) throw new Error('a department name needs at least one letter or digit');
  return n;
}
