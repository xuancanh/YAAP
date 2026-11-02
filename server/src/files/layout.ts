/**
 * The workspace tree's layout (docs/filesystem.md "Layout") — the one place
 * that knows where things go. Every server writer builds its path here: the
 * chief's seeded ledger, the record mirrors, meeting minutes, the generated
 * indexes (README, calendar, rituals, goals) and the function folders. The
 * pack test checks every `/org/…` path a playbook names against
 * `classifyOrgPath`, so skills and code cannot drift apart.
 *
 * Paths are workspace-relative (no leading slash), as WorkspaceFs takes them;
 * agents and people see them with a leading `/`.
 *
 *   /org/
 *     README.md               the index: what lives where (generated)
 *     operating-system.md     the chief's operating system (seeded, then the chief's)
 *     calendar.md             every ritual, from the cadences (generated; a Notes tail is kept)
 *     decisions.md risks.md issues.md handoffs.md values.md scorecard.md   the ledger
 *     goals/                  README.md + <id8>-<slug>.md per objective (generated)
 *     rituals/<unit>.md       a unit's rituals and attendees (generated)
 *     meetings/<unit>/<yyyy>/<yyyy-mm-dd>-<kind>.md          minutes (…-agenda.md: the agenda)
 *     reports/<yyyy>-W<ww>.md  the weekly review pack; <yyyy-mm>-<topic>.md monthly reviews;
 *                              <yyyy-mm-dd>-board-update.md board drafts
 *     briefs/<yyyy-mm-dd>.md  daily CEO briefs
 *     planning/<yyyy>-Q<n>.md the quarter's planning pack
 *     proposals/<yyyy-mm-dd>-<slug>.md   proposals for the CEO
 *     archive/<yyyy>/…        closed ledger rows, archived
 *     playbooks/ experiments/ evals/ outcomes.md metrics.md   record mirrors
 *     <function>/             one per job function (sales, customer, operations…): README.md, cadence.md,
 *                             kpis.md, team.md, okrs/<yyyy>-Q<n>.md,
 *                             reports/<yyyy>-W<ww>.md, audits/<yyyy-mm>.md, processes/, …
 *   /channels/<slug>/         a channel's folder; meetings/<yyyy-mm-dd>-<title>.md
 *   /agents/<handle>/         a home: LESSONS.md, JOURNAL.md, knowledge/, apps/, work/
 *   /uploads/                 composer attachments
 */

export const ORG_DIR = 'org';
export const AGENTS_DIR = 'agents';
export const CHANNELS_DIR = 'channels';
export const UPLOADS_DIR = 'uploads';

// ---- small pure helpers ----

/** A file-name-safe slug: lowercase words joined by '-', at most `max` chars. */
export function slugify(s: string, fallback = 'untitled', max = 48): string {
  const out = (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return out || fallback;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const asDate = (d: Date | string): Date => {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? new Date() : d;
  // A bare yyyy-mm-dd is a local day, not UTC midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  const x = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(d);
  return Number.isNaN(x.getTime()) ? new Date() : x;
};

/** `yyyy-mm-dd` in server-local time. */
export function localDay(d: Date | string): string { const x = asDate(d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
/** `yyyy-mm` in server-local time. */
export function monthLabel(d: Date | string): string { return localDay(d).slice(0, 7); }
/** `yyyy-Qn` in server-local time. */
export function quarterLabel(d: Date | string): string { const x = asDate(d); return `${x.getFullYear()}-Q${Math.floor(x.getMonth() / 3) + 1}`; }
/** The ISO-8601 week of a server-local day: `yyyy-Www` (the week's year, which
 *  differs from the calendar year around New Year). */
export function weekLabel(d: Date | string): string {
  const x = asDate(d);
  const t = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}
/** A meeting kind as a path segment: `weekly_review` → `weekly-review`. */
export const kindSlug = (kind: string): string => slugify((kind ?? '').replace(/_/g, '-'), 'meeting');
const id8 = (id: string): string => (id ?? '').slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '') || 'x';

// ---- functions ----

export interface OrgFunction { id: string; title: string }

/**
 * One folder per job function, named by the job function's id — the ids the
 * market groups business packs by and packs name in their frontmatter
 * (server/src/market/segments.ts BIZ_FUNCTIONS, less `leadership`, whose
 * chief and auditor work in /org/ itself). A test keeps the two lists equal.
 */
export const ORG_FUNCTIONS: readonly OrgFunction[] = [
  { id: 'sales', title: 'Sales' },
  { id: 'marketing', title: 'Marketing' },
  { id: 'customer', title: 'Customer Success & Support' },
  { id: 'product', title: 'Product' },
  { id: 'engineering', title: 'Engineering' },
  { id: 'design', title: 'Design' },
  { id: 'data', title: 'Data & Analytics' },
  { id: 'finance', title: 'Finance' },
  { id: 'people', title: 'People & HR' },
  { id: 'legal', title: 'Legal' },
  { id: 'operations', title: 'Operations' },
  { id: 'it-security', title: 'IT & Security' },
  { id: 'revops', title: 'Revenue Operations' },
];
export const FUNCTION_IDS: readonly string[] = ORG_FUNCTIONS.map((f) => f.id);
/**
 * The documented map from a role-id prefix to its function folder where the
 * two differ: catalog roles are `cs-*` and `ops-*` (role:cs-manager,
 * pack-biz-cs-manager), their folders `/org/customer/` and
 * `/org/operations/`. Every other prefix is its folder's name.
 */
export const ROLE_PREFIX_FUNCTION: Readonly<Record<string, string>> = { cs: 'customer', ops: 'operations' };

/** The function of a catalog role id (`cs-manager` → `customer`) or a
 *  business pack id (`pack-biz-it-security-manager` → `it-security`); null
 *  otherwise (the chief of staff, the auditor, the generalist roles). */
export function functionOfRole(roleOrPackId: string | null | undefined): string | null {
  const id = (roleOrPackId ?? '').trim().toLowerCase().replace(/^role:/, '').replace(/^pack-biz-/, '');
  const prefixes = [...FUNCTION_IDS, ...Object.keys(ROLE_PREFIX_FUNCTION)].sort((a, b) => b.length - a.length);
  const hit = prefixes.find((f) => id.startsWith(`${f}-`));
  return hit ? ROLE_PREFIX_FUNCTION[hit] ?? hit : null;
}

/** The fixed part of every function folder; anything else under it is the function's own. */
export const FUNCTION_LAYOUT = {
  readme: 'README.md',
  cadence: 'cadence.md',
  kpis: 'kpis.md',
  team: 'team.md',
  okrs: 'okrs',
  reports: 'reports',
  audits: 'audits',
  processes: 'processes',
} as const;

// ---- /org/ ----

export const orgPath = {
  dir: ORG_DIR,
  readme: `${ORG_DIR}/README.md`,
  operatingSystem: `${ORG_DIR}/operating-system.md`,
  calendar: `${ORG_DIR}/calendar.md`,
  decisions: `${ORG_DIR}/decisions.md`,
  risks: `${ORG_DIR}/risks.md`,
  issues: `${ORG_DIR}/issues.md`,
  handoffs: `${ORG_DIR}/handoffs.md`,
  values: `${ORG_DIR}/values.md`,
  scorecard: `${ORG_DIR}/scorecard.md`,
  outcomes: `${ORG_DIR}/outcomes.md`,
  metrics: `${ORG_DIR}/metrics.md`,

  goalsDir: `${ORG_DIR}/goals`,
  goalsIndex: `${ORG_DIR}/goals/README.md`,
  /** One file per objective: `goals/<id8>-<slug>.md`. */
  goal: (g: { id: string; title: string }): string => `${ORG_DIR}/goals/${id8(g.id)}-${slugify(g.title, 'objective')}.md`,

  ritualsDir: `${ORG_DIR}/rituals`,
  ritual: (unitSlug: string): string => `${ORG_DIR}/rituals/${slugify(unitSlug, 'unit')}.md`,

  meetingsDir: `${ORG_DIR}/meetings`,
  /** A unit's meetings of one year: `meetings/<unit>/<yyyy>`. */
  meetingsOf: (unitSlug: string, year?: string | number): string => `${ORG_DIR}/meetings/${slugify(unitSlug, 'unit')}${year !== undefined ? `/${year}` : ''}`,
  /** A unit meeting's minutes: `meetings/<unit>/<yyyy>/<yyyy-mm-dd>-<kind>.md`. */
  minutes: (unitSlug: string, day: Date | string, kind: string): string => { const d = localDay(day); return `${ORG_DIR}/meetings/${slugify(unitSlug, 'unit')}/${d.slice(0, 4)}/${d}-${kindSlug(kind)}.md`; },
  /** Its agenda and pre-reads, next to the minutes: `…/<yyyy-mm-dd>-<kind>-agenda.md`. */
  agenda: (unitSlug: string, day: Date | string, kind: string): string => { const d = localDay(day); return `${ORG_DIR}/meetings/${slugify(unitSlug, 'unit')}/${d.slice(0, 4)}/${d}-${kindSlug(kind)}-agenda.md`; },

  reportsDir: `${ORG_DIR}/reports`,
  /** The chief's weekly review pack: `reports/<yyyy>-W<ww>.md`. */
  weeklyReport: (d: Date | string): string => `${ORG_DIR}/reports/${weekLabel(d)}.md`,
  /** A monthly review (staffing, learning…): `reports/<yyyy-mm>-<topic>.md`. */
  monthlyReport: (d: Date | string, topic: string): string => `${ORG_DIR}/reports/${monthLabel(d)}-${slugify(topic, 'review')}.md`,
  /** A board / investor update draft: `reports/<yyyy-mm-dd>-board-update.md`. */
  boardUpdate: (d: Date | string): string => `${ORG_DIR}/reports/${localDay(d)}-board-update.md`,
  briefsDir: `${ORG_DIR}/briefs`,
  brief: (d: Date | string): string => `${ORG_DIR}/briefs/${localDay(d)}.md`,
  planningDir: `${ORG_DIR}/planning`,
  planning: (d: Date | string): string => `${ORG_DIR}/planning/${quarterLabel(d)}.md`,
  proposalsDir: `${ORG_DIR}/proposals`,
  proposal: (d: Date | string, title: string): string => `${ORG_DIR}/proposals/${localDay(d)}-${slugify(title, 'proposal')}.md`,
  archiveDir: `${ORG_DIR}/archive`,
  archive: (year: string | number, name: string): string => `${ORG_DIR}/archive/${year}/${name.replace(/^\/+/, '')}`,

  playbooksDir: `${ORG_DIR}/playbooks`,
  playbook: (p: { name: string; id: string }): string => `${ORG_DIR}/playbooks/${slugify(p.name, p.id.slice(0, 8))}.md`,
  experimentsDir: `${ORG_DIR}/experiments`,
  experiment: (e: { id: string; title: string }): string => `${ORG_DIR}/experiments/${e.id.slice(0, 8)}-${slugify(e.title)}.md`,
  evalsDir: `${ORG_DIR}/evals`,
  evals: (roleKey: string): string => `${ORG_DIR}/evals/${slugify(roleKey, 'role')}.md`,

  functionDir: (fn: string): string => `${ORG_DIR}/${fn}`,
  functionFile: (fn: string, file: string): string => `${ORG_DIR}/${fn}/${file}`,
  functionReport: (fn: string, d: Date | string): string => `${ORG_DIR}/${fn}/reports/${weekLabel(d)}.md`,
  functionOkrs: (fn: string, d: Date | string): string => `${ORG_DIR}/${fn}/okrs/${quarterLabel(d)}.md`,
  functionAudit: (fn: string, d: Date | string): string => `${ORG_DIR}/${fn}/audits/${monthLabel(d)}.md`,
} as const;

/** The ledger files the chief seeds at onboarding (calendar.md is generated). */
export const LEDGER_FILES = [orgPath.operatingSystem, orgPath.decisions, orgPath.risks, orgPath.scorecard, orgPath.issues, orgPath.handoffs, orgPath.values] as const;

/**
 * The order /org/'s children are shown in (the README and the Artifacts tree):
 * the index, how the company runs, its goals and rhythm, the chief's packs,
 * the ledger, the functions, then the mirrors and the archive. Anything not
 * listed (an agent's ad-hoc file or folder) follows, alphabetically.
 */
export const ORG_ORDER: readonly string[] = [
  'README.md', 'operating-system.md', 'calendar.md', 'goals', 'meetings', 'rituals', 'reports', 'briefs', 'planning',
  'decisions.md', 'scorecard.md', 'issues.md', 'risks.md', 'handoffs.md', 'values.md', 'proposals',
  ...FUNCTION_IDS,
  'playbooks', 'experiments', 'evals', 'outcomes.md', 'metrics.md', 'archive',
];

// ---- channels, agents ----

export const channelPath = {
  dir: (slug: string): string => `${CHANNELS_DIR}/${slug}`,
  /** Minutes of a `/meeting` in a channel that is not a unit's:
   *  `<folder>/meetings/<yyyy-mm-dd>-<title>.md` (the folder is
   *  `channels/<slug>` unless the channel names another). */
  minutes: (folder: string | null | undefined, slug: string | null | undefined, day: Date | string, title: string): string => {
    const base = (folder || (slug ? `${CHANNELS_DIR}/${slug}` : `${CHANNELS_DIR}/meetings`)).replace(/^\/+|\/+$/g, '');
    return `${base}/meetings/${localDay(day)}-${slugify(title, 'meeting')}.md`;
  },
} as const;

export const agentPath = {
  home: (handle: string): string => `${AGENTS_DIR}/${handle}`,
  lessons: (home: string): string => `${home}/LESSONS.md`,
  journal: (home: string): string => `${home}/JOURNAL.md`,
  knowledge: (home: string): string => `${home}/knowledge`,
  apps: (home: string): string => `${home}/apps`,
  /** Drafts and scratch work not yet ready to share. */
  work: (home: string): string => `${home}/work`,
} as const;

// ---- the check the pack test and the README use ----

const SAMPLE: Record<string, string> = {
  yyyy: '2026', ww: '45', n: '4', q: '4', 'yyyy-mm': '2026-11', 'yyyy-mm-dd': '2026-11-02', date: '2026-11-02',
  quarter: '2026-Q4', week: '2026-W45', month: '2026-11', function: 'sales', fn: 'sales', unit: 'company', kind: 'standup',
};
/** Replace `<placeholder>`s with a sample value so templated paths check like real ones. */
export function samplePath(path: string): string {
  return path.replace(/<([^<>/]+)>/g, (_, k: string) => SAMPLE[k.toLowerCase()] ?? 'x');
}

const FN = FUNCTION_IDS.map((f) => f.replace(/-/g, '\\-')).join('|');
const SEG = '[A-Za-z0-9][A-Za-z0-9._-]*';
export const ORG_PATTERNS: ReadonlyArray<{ what: string; re: RegExp }> = [
  { what: 'the /org/ folder', re: /^org$/ },
  { what: 'a ledger file', re: /^org\/(README|operating-system|calendar|decisions|risks|issues|handoffs|values|scorecard|outcomes|metrics)\.md$/ },
  { what: 'goals', re: /^org\/goals(\/(README\.md|[a-z0-9]{1,8}-[a-z0-9-]+\.md))?$/ },
  { what: 'rituals', re: /^org\/rituals(\/[a-z0-9-]+\.md)?$/ },
  { what: 'meeting minutes', re: /^org\/meetings(\/[a-z0-9-]+(\/\d{4}(\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md)?)?)?$/ },
  { what: 'the chief\'s reports', re: /^org\/reports(\/(\d{4}-W\d{2}|\d{4}-\d{2}-[a-z][a-z0-9-]*|\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\.md)?$/ },
  { what: 'daily briefs', re: /^org\/briefs(\/\d{4}-\d{2}-\d{2}\.md)?$/ },
  { what: 'planning packs', re: /^org\/planning(\/\d{4}-Q[1-4]\.md)?$/ },
  { what: 'proposals', re: /^org\/proposals(\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md)?$/ },
  { what: 'the archive', re: new RegExp(`^org/archive(/\\d{4}(/${SEG}(/${SEG})*)?)?$`) },
  { what: 'a record mirror', re: /^org\/(playbooks|experiments|evals)(\/[a-z0-9-]+\.md)?$/ },
  { what: 'a function\'s reports', re: new RegExp(`^org/(${FN})/reports(/\\d{4}-W\\d{2}\\.md)?$`) },
  { what: 'a function\'s OKRs', re: new RegExp(`^org/(${FN})/okrs(/\\d{4}-Q[1-4]\\.md)?$`) },
  { what: 'a function\'s audits', re: new RegExp(`^org/(${FN})/audits(/\\d{4}-\\d{2}(-[a-z0-9-]+)?\\.md)?$`) },
  { what: 'a function folder', re: new RegExp(`^org/(${FN})(/(?!reports(/|$)|okrs(/|$)|audits(/|$))${SEG}(/${SEG})*)?$`) },
];

/** What an `/org/…` path is in the layout (placeholders allowed), or null
 *  when it fits nowhere. Leading/trailing slashes are ignored. */
export function classifyOrgPath(path: string): string | null {
  const p = samplePath(path).replace(/^\/+|\/+$/g, '');
  return ORG_PATTERNS.find((x) => x.re.test(p))?.what ?? null;
}

// ---- the migration's mapping (pure) ----

const KIND_SLUGS = ['planning', 'standup', 'weekly-review', 'retro', 'board', 'adhoc'];

/**
 * Where a file written under an earlier convention belongs now, or null when
 * it is already in place (or is not ours to move). Pure, so the boot
 * migration is idempotent: a moved path never maps again.
 *
 *  - `org/meetings/<yyyy>/<day>-<unit>-<kind>[-sfx].md` → `org/meetings/<unit>/<yyyy>/<day>-<kind>[-sfx].md`
 *    (the unit is the longest known unit slug the name starts with, else the
 *    part before a known kind, else `unsorted`);
 *  - `org/meetings/<day>-leadership.md` (the chief's agenda) → the root unit's `…-board-agenda.md`;
 *  - `org/reviews/<day>.md` → `org/reports/<yyyy>-W<ww>.md`; `org/board/<day>-<x>.md` →
 *    `org/reports/<day>-board-<x>.md`; `org/staffing|learning/<yyyy-mm>.md` → `org/reports/<yyyy-mm>-staffing|learning.md`.
 */
export function legacyTarget(path: string, opts: { unitSlugs?: string[]; rootSlug?: string } = {}): string | null {
  const seg = path.split('/');
  if (seg[0] !== ORG_DIR || seg.length < 3) return null;
  const name = seg[seg.length - 1];
  if (seg[1] === 'meetings') {
    if (seg.length === 3) {
      const m = /^(\d{4}-\d{2}-\d{2})-leadership(-[a-z0-9-]+)?\.md$/.exec(name);
      return m ? `${orgPath.meetingsOf(opts.rootSlug ?? 'company', m[1].slice(0, 4))}/${m[1]}-board-agenda${m[2] ?? ''}.md` : null;
    }
    if (seg.length !== 4 || !/^\d{4}$/.test(seg[2])) return null;
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name);
    if (!m) return `${orgPath.meetingsOf('unsorted', seg[2])}/${name}`;
    const [, day, rest] = m;
    const unit = [...(opts.unitSlugs ?? [])].sort((a, b) => b.length - a.length).find((u) => rest.startsWith(`${u}-`) && rest.length > u.length + 1);
    if (unit) return `${orgPath.meetingsOf(unit, seg[2])}/${day}-${rest.slice(unit.length + 1)}.md`;
    const k = new RegExp(`^(.+?)-((?:${KIND_SLUGS.join('|')})(?:-[a-z0-9]+)?)$`).exec(rest);
    if (k) return `${orgPath.meetingsOf(k[1], seg[2])}/${day}-${k[2]}.md`;
    return `${orgPath.meetingsOf('unsorted', seg[2])}/${name}`;
  }
  if (seg.length !== 3) return null;
  const stem = name.replace(/\.md$/, '');
  if (seg[1] === 'reviews') return /^\d{4}-\d{2}-\d{2}$/.test(stem) ? orgPath.weeklyReport(stem) : `${orgPath.reportsDir}/review-${name}`;
  if (seg[1] === 'board') {
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(stem);
    return m ? `${orgPath.reportsDir}/${m[1]}-board-${m[2]}.md` : `${orgPath.reportsDir}/board-${name}`;
  }
  if (seg[1] === 'staffing' || seg[1] === 'learning') return `${orgPath.reportsDir}/${stem}-${seg[1]}.md`;
  return null;
}

/** `path` with `-2`, `-3`… before the extension. */
export function withNumber(path: string, n: number): string {
  const i = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return i > slash ? `${path.slice(0, i)}-${n}${path.slice(i)}` : `${path}-${n}`;
}
