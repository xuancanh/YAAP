/**
 * The chief of staff's operating system, derived from the operating profile
 * (docs/chief-of-staff.md; reports/Chief of staff operating model.md, "An AI
 * chief of staff is a profile, a ledger and a bounded mandate").
 *
 * The research's design has three parts, and this module holds the first
 * two as pure functions (no model, no I/O):
 *
 *  - **the profile is the input**: `diagnoseProfile` reads the stage, the
 *    culture type (the Competing Values Framework's clan / adhocracy /
 *    market / hierarchy) and the speed, rigour and writing norms from the
 *    CEO's words by a string match, like the role catalog's `fits`; explicit
 *    answers win over the match;
 *  - **every parameter derives from it**: `deriveOperatingSystem` turns the
 *    diagnosis into tunable values (goal count, pre-read deadline, handoff
 *    SLA, escalation timers, the archetype dial), the root unit's ritual
 *    cadences and the chief's own loops; `seedArtifacts` writes the ledger's
 *    starting files under `/org/` (paths from server/src/files/layout.ts;
 *    /org/calendar.md is generated from the cadences by OrgLayoutService).
 *
 * The third part, the bounded mandate, is the chief's charter
 * (roles/catalog.ts) and the boundary (boundary.ts). The mapping from
 * culture to mechanism is the report's design heuristic, not a finding, so
 * every value here is a starting point the CEO can edit and the chief can
 * propose to change — never a fixed default (docs/company-vision.md §1b).
 */
import { CHIEF_TUNABLES, PROXY_LEVELS, type ProxyLevel } from './chief-tunables';
import { TUNABLES } from './org-tunables';
import { orgPath } from '../files/layout';
import { deriveMeetingTunables } from './meeting-tunables';
import { deriveWorkTunables } from './work-tunables';
import { deriveDiscussionTunables } from '../groupchat/discussion-tunables';
// The assurance keys (audit.assuranceDebounceHours) join the registry at import.
import './org-assurance-tunables';
// The seat keys (seat.hopTimeoutHours, docs/owners-seat.md §7) too.
import './governance-tunables';

/** The pack the chief's skills and loops come from (packs/chief-of-staff.md). */
export const CHIEF_PACK_ID = 'pack-chief-of-staff';

export type Stage = 'early' | 'growth' | 'scale';
export const STAGES: readonly Stage[] = ['early', 'growth', 'scale'];
export type CultureType = 'clan' | 'adhocracy' | 'market' | 'hierarchy' | 'balanced';
export const CULTURE_TYPES: readonly CultureType[] = ['clan', 'adhocracy', 'market', 'hierarchy', 'balanced'];

export interface ProfileInput {
  values?: string | null;
  culture?: string | null;
  mission?: string | null;
  vision?: string | null;
  /** Members the company starts with (agents and humans); the stage's fallback. */
  size?: number;
  /** The CEO's own answers, when given, win over the string match. */
  stage?: Stage;
  cultureType?: CultureType;
}

export interface ProfileDiagnosis {
  stage: Stage;
  stageWhy: string;
  cultureType: CultureType;
  /** The words that placed the culture, per type. */
  cultureMatches: Record<Exclude<CultureType, 'balanced'>, string[]>;
  speed: boolean;
  rigor: boolean;
  writing: boolean;
  /** The stated values as separate items, for the values → mechanism map. */
  values: string[];
}

const CULTURE_WORDS: Record<Exclude<CultureType, 'balanced'>, string[]> = {
  clan: ['family', 'collaborat', 'consensus', 'people first', 'care', 'mentor', 'together', 'kind', 'belonging', 'wellbeing', 'support each other'],
  adhocracy: ['experiment', 'innovat', 'creativ', 'bold', 'explor', 'iterat', 'research', 'curious', 'invent', 'prototype', 'risk-taking'],
  market: ['results', 'win', 'competit', 'revenue', 'target', 'metric', 'kpi', 'growth', 'customer', 'quota', 'performance'],
  hierarchy: ['process', 'complian', 'regulat', 'reliab', 'control', 'audit', 'predictab', 'formal', 'procedure', 'stability', 'approval'],
};
const SPEED = /\b(fast|speed|quick\w*|ship\w*|bias for action|move fast|async|terse|scrappy|lean|urgen\w*)\b/;
const RIGOR = /\b(rigou?r\w*|careful\w*|thorough\w*|precis\w*|never guess\w*|evidence|accura\w*|quality|correct\w*|safety|compliance)\b/;
const WRITING = /\b(writ\w*|memos?|async|docs?|document\w*|narratives?)\b/;
const EARLY = /\b(pre-?seed|seed|pre-?pmf|idea stage|prototype|side project|solo|bootstrapp\w*|just start\w*|mvp|tiny)\b/;
const SCALE = /\b(series [c-z]|enterprise|public company|ipo|hundreds of|multinational|board of directors)\b/;
const GROWTH = /\b(series [ab]|scale-?up|scaling|growing team|product-market fit|pmf)\b/;

/** Read the stage, the culture type and the norms from the profile's words. */
export function diagnoseProfile(p: ProfileInput): ProfileDiagnosis {
  const text = [p.values, p.culture, p.mission, p.vision].filter(Boolean).join(' \n ').toLowerCase();
  const normText = [p.values, p.culture].filter(Boolean).join(' \n ').toLowerCase();
  let stage: Stage;
  let stageWhy: string;
  if (p.stage && STAGES.includes(p.stage)) { stage = p.stage; stageWhy = 'the CEO said so'; }
  else if (EARLY.test(text)) { stage = 'early'; stageWhy = `the profile says "${EARLY.exec(text)![0]}"`; }
  else if (SCALE.test(text)) { stage = 'scale'; stageWhy = `the profile says "${SCALE.exec(text)![0]}"`; }
  else if (GROWTH.test(text)) { stage = 'growth'; stageWhy = `the profile says "${GROWTH.exec(text)![0]}"`; }
  else {
    const size = Math.max(1, Math.round(p.size ?? 1));
    // The report's bands: below ~10 people, 10–50, 50 and above.
    stage = size < 10 ? 'early' : size < 50 ? 'growth' : 'scale';
    stageWhy = `${size} member(s) at the start`;
  }
  const cultureMatches = Object.fromEntries(Object.entries(CULTURE_WORDS).map(([type, words]) => [type, words.filter((w) => normText.includes(w))])) as ProfileDiagnosis['cultureMatches'];
  let cultureType: CultureType = 'balanced';
  if (p.cultureType && CULTURE_TYPES.includes(p.cultureType)) cultureType = p.cultureType;
  else {
    const ranked = Object.entries(cultureMatches).map(([t, m]) => [t, m.length] as const).sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] > 0 && ranked[0][1] > ranked[1][1]) cultureType = ranked[0][0] as CultureType;
  }
  const values = (p.values ?? '').split(/[;\n•]|,\s+|\.\s+/).map((v) => v.trim().replace(/\.$/, '')).filter((v) => v.length >= 3).slice(0, 8);
  return { stage, stageWhy, cultureType, cultureMatches, speed: SPEED.test(normText), rigor: RIGOR.test(normText), writing: WRITING.test(normText), values };
}

export type RitualKind = 'standup' | 'weekly_review' | 'retro' | 'board';

export interface OperatingSystemPlan extends ProfileDiagnosis {
  archetype: ProxyLevel;
  decisionProtocol: string;
  commsDefault: string;
  /** Tunable values derived from the profile, each with its reason. */
  tunables: Array<{ key: string; value: number; why: string }>;
  /** The root unit's rituals: a cron, or null to hold none. */
  rituals: Array<{ kind: RitualKind; cron: string | null; why: string }>;
}

const DEFAULT_CRON: Record<RitualKind, string> = { standup: '30 9 * * 1-5', weekly_review: '0 16 * * 5', retro: '30 16 * * 5', board: '0 9 * * 1' };

/** Derive the operating system's parameters from the diagnosis. Pure; every
 *  value stays inside its tunable's bound. */
export function deriveOperatingSystem(p: ProfileInput): OperatingSystemPlan {
  const d = diagnoseProfile(p);
  const { stage, cultureType: c, speed, rigor, writing } = d;
  const tunables: OperatingSystemPlan['tunables'] = [];
  const set = (key: string, value: number, why: string) => {
    const def = TUNABLES[key] ?? CHIEF_TUNABLES[key];
    tunables.push({ key, value: def ? Math.min(def.max, Math.max(def.min, value)) : value, why });
  };
  const archetypeLevel = stage === 'early' ? 0 : stage === 'growth' ? 1 : 2;
  set('chief.proxyLevel', archetypeLevel, `${stage} stage: start as ${PROXY_LEVELS[archetypeLevel]}; proxy scope is earned, never granted at onboarding`);
  set('planning.objectivesPerVision', stage === 'early' ? 2 : stage === 'growth' ? 3 : 4, 'a few time-boxed priorities, fewer while there is little system to run');
  set('chief.maxObjectives', stage === 'early' ? 3 : stage === 'growth' ? 4 : 5, 'goal hygiene flags more objectives than the company can focus on');
  set('planning.keyResultsPerObjective', stage === 'early' ? 2 : 3, 'about three key results per objective; two while the company is small');
  set('intent.checkInCadenceDays', c === 'hierarchy' && !speed ? 14 : 7, c === 'hierarchy' && !speed ? 'a control culture reviews formally, every two weeks' : 'a weekly numbers check');
  set('chief.preReadHours', rigor && c === 'hierarchy' ? 72 : rigor || c === 'hierarchy' ? 48 : speed || stage === 'early' ? 24 : 48, rigor || c === 'hierarchy' ? 'pre-reads are mandatory and arrive with time to read them' : speed || stage === 'early' ? 'async status, short sync: pre-reads a day ahead' : 'pre-reads at T−2 days');
  set('chief.handoffSlaHours', speed ? 8 : c === 'hierarchy' ? 48 : 24, speed ? 'speed is a value: a handoff waits hours, not days' : c === 'hierarchy' ? 'formal handoffs with a two-day window' : 'a handoff moves within a day');
  set('chief.decisionOverdueHours', speed ? 12 : c === 'hierarchy' ? 48 : 24, speed ? 'decisions are made fast with ~70% of the information' : c === 'hierarchy' ? 'decisions pass a defined route' : 'a decision waits at most a day before it is called out');
  set('chief.riskReviewDays', c === 'hierarchy' ? 7 : stage === 'early' ? 30 : 14, c === 'hierarchy' ? 'risk register and controls in the foreground' : stage === 'early' ? 'a small company reviews risks monthly' : 'risks re-scored every two weeks');
  set('chief.offTrackWeeks', speed || c === 'market' ? 1 : 2, speed || c === 'market' ? 'off track for a week is an issue' : 'off track for two weeks with no issue raised is flagged');
  set('chief.sunsetEmptyCycles', speed || c === 'adhocracy' ? 2 : c === 'hierarchy' ? 4 : 3, speed || c === 'adhocracy' ? 'rituals that stop earning their time go fast' : c === 'hierarchy' ? 'rituals are retired deliberately' : 'three empty cycles and a ritual is up for retirement');
  set('audit.assuranceDebounceHours', speed ? 2 : c === 'hierarchy' || rigor ? 24 : stage === 'early' ? 4 : 6, speed ? 'speed is a value: a head\'s assurance request is answered within hours' : c === 'hierarchy' || rigor ? 'assurance requests are batched into one formal audit a day' : stage === 'early' ? 'a small company answers an assurance request the same morning' : 'assurance requests are batched for a few hours, then audited');
  set('seat.hopTimeoutHours', speed ? 4 : c === 'hierarchy' || rigor ? 24 : stage === 'early' ? 8 : 12, speed ? 'speed is a value: a manager answers a decision within hours or it climbs' : c === 'hierarchy' || rigor ? 'each level of the route gets a working day to review a decision' : stage === 'early' ? 'a small company: a decision waits on a manager for a morning at most' : 'a manager gets half a day before a decision climbs on its own');
  set('seat.urgentHopTimeoutHours', speed ? 1 : c === 'hierarchy' || rigor ? 4 : 2, speed ? 'urgent decisions climb after an hour' : c === 'hierarchy' || rigor ? 'urgent decisions still get half a morning per level' : 'urgent decisions climb after two hours');
  set('chief.memoFirst', rigor || writing || c === 'hierarchy' ? 1 : 0, rigor || writing || c === 'hierarchy' ? 'the company defaults to writing: every decision item has a pre-read' : 'written pre-reads for one-way doors only');
  for (const t of deriveMeetingTunables(d)) set(t.key, t.value, t.why);
  // Work tracking (docs/work-tracking.md): update cadence, back-off, breaker default, meta-work cap.
  for (const t of deriveWorkTunables(d)) set(t.key, t.value, t.why);
  // Sub-channels (docs/group-chat.md §9): idle close, agent starts, the ping-pong move.
  for (const t of deriveDiscussionTunables(d)) set(t.key, t.value, t.why);

  const decisionProtocol = {
    clan: 'Consensus-seeking with one named final decider; dissent is recorded, then the decider decides.',
    adhocracy: 'Informed captain: the DRI farms for dissent, decides, and the team disagrees and commits; approvals stay light.',
    market: 'Single decider with explicit targets; decisions are judged against the scorecard.',
    hierarchy: 'RAPID: recommend, agree (named veto holders), perform, input, decide; approval thresholds are written down.',
    balanced: 'One decider per decision (DACI approver); reversible decisions are made fast, irreversible ones with a written memo.',
  }[c];
  const commsDefault = writing || rigor ? 'Memo-first: written context handles the update; meetings are for decisions.' : speed ? 'Async status, short sync: updates are written, the meeting is short.' : 'Written weekly updates; the meeting works the top issues.';

  const rituals: OperatingSystemPlan['rituals'] = [
    { kind: 'standup', cron: speed || c === 'adhocracy' ? DEFAULT_CRON.standup : null, why: speed || c === 'adhocracy' ? 'a short daily huddle: priority and stuck' : 'no daily standup: the board and written updates carry status' },
    { kind: 'weekly_review', cron: c === 'market' ? '0 10 * * 3' : DEFAULT_CRON.weekly_review, why: c === 'market' ? 'a metric-heavy weekly business review mid-week' : 'the weekly numbers check' },
    { kind: 'retro', cron: stage === 'early' && c !== 'adhocracy' ? null : DEFAULT_CRON.retro, why: stage === 'early' && c !== 'adhocracy' ? 'a small company learns in the weekly review; retros follow failures (postmortems)' : 'a regular retro' },
    { kind: 'board', cron: stage === 'early' ? '0 9 1-7 * 1' : DEFAULT_CRON.board, why: stage === 'early' ? 'the leadership meeting monthly (first Monday) while the weekly review covers the week' : 'the weekly leadership meeting: scorecard first, then issues' },
  ];
  return { ...d, archetype: PROXY_LEVELS[archetypeLevel], decisionProtocol, commsDefault, tunables, rituals };
}

/** The tunable value the plan derived for `key`, or undefined. */
export function planValue(plan: OperatingSystemPlan, key: string): number | undefined {
  return plan.tunables.find((t) => t.key === key)?.value;
}

/** The chief's loops: the daily sweep before the brief, the weekly pack at
 *  the pre-read deadline before the root's weekly review, the monthly
 *  operating review and the quarterly planning kickoff three weeks before
 *  the quarter (GitLab firms key results up 3–4 weeks ahead). */
export function chiefLoops(opts: { briefHour: number; weeklyReviewCron: string | null; preReadHours: number }): Array<{ name: string; cron: string; prompt: string }> {
  const sweepHour = Math.max(0, Math.min(23, Math.round(opts.briefHour) - 1));
  return [
    { name: 'Operating-system sweep', cron: `30 ${sweepHour} * * 1-5`, prompt: 'Run your function-reports-intake playbook (new reports under /org/<function>/reports/ and the heads\' backlog requests), then project-portfolio, escalation-and-blocker-sweep, ceo-daily-brief and handoff-sla-monitor: refresh /org/scorecard.md, /org/issues.md and /org/handoffs.md from the record, chase owners whose pre-reads are due, and leave the CEO a five-line brief. Mark any variance you cannot explain as unknown.' },
    { name: 'Weekly business review pack', cron: prepCron(opts.weeklyReviewCron, opts.preReadHours), prompt: 'Run your weekly-business-review playbook to assemble the pack for the coming weekly review (exceptions only, controllable inputs, last week\'s open items first), then exec-meeting-prep for the leadership meeting. Owners write the commentary; you compile it and chase what is missing.' },
    { name: 'Monthly operating review', cron: '0 10 1 * *', prompt: 'Run your decision-log-hygiene, risk-register and ritual-retirement-review playbooks, then values-mechanism-audit, member-lifecycle-review, delegate-org-design (each head\'s mandate, envelope and team design), learning-loop-review and org-files-hygiene. Propose changes; change nothing the CEO or a ritual owner owns.' },
    { name: 'Quarterly planning kickoff', cron: '0 10 8 3,6,9,12 *', prompt: 'Run your quarterly-planning playbook: grade the quarter, collect each function\'s draft objectives with their dependencies and each head\'s proposed team design (delegate-org-design), and prepare the planning pack and the proposal for the CEO.' },
  ];
}

/** A cron at the pre-read deadline before a simple weekly cron ("m h * * d"),
 *  moved off the weekend; Thursday afternoon when the cron is not simple. */
export function prepCron(cron: string | null, preReadHours: number): string {
  const f = (cron ?? '').trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[2] !== '*' || f[3] !== '*' || !/^\d$/.test(f[4])) return '0 14 * * 4';
  const days = Math.max(1, Math.round(preReadHours / 24));
  let dow = ((Number(f[4]) - days) % 7 + 7) % 7;
  if (dow === 0) dow = 5;
  if (dow === 6) dow = 5;
  return `${f[0]} ${f[1]} * * ${dow}`;
}

export interface SeedContext {
  orgName: string;
  vision?: string | null;
  mission?: string | null;
  /** Effective tunable values for the operating-system table. */
  values: Record<string, number>;
  /** Cadences as they stand after onboarding (the calendar itself is
   *  generated from the cadence rows; kept for callers that pass them). */
  cadences?: Array<{ unit: string; root: boolean; kind: string; cron: string; enabled: boolean }>;
  /** Function owners (unit leads, managers) by name and title. */
  owners: Array<{ name: string; title: string }>;
  date: string;
}

const KIND_TITLE: Record<string, string> = { standup: 'Standup', weekly_review: 'Weekly business review', retro: 'Retro', board: 'Leadership meeting', planning: 'Planning' };

/** The ledger's starting files, as workspace-relative paths (`org/…`, which
 *  agents reach as `/org/…`). Written once at onboarding, never over a file
 *  that exists; afterwards the chief keeps them. The calendar is not among
 *  them: OrgLayoutService generates /org/calendar.md from the cadences. */
export function seedArtifacts(plan: OperatingSystemPlan, ctx: SeedContext): Array<{ path: string; body: string }> {
  const v = (k: string) => ctx.values[k] ?? TUNABLES[k]?.default;
  const cultureWords = Object.values(plan.cultureMatches).flat();
  const os = [
    `# Operating system — ${ctx.orgName}`,
    '',
    `*Seeded at onboarding on ${ctx.date} from the operating profile. Every value below is a per-workspace tunable: the CEO edits it in Settings → Workspace → Organization; the chief proposes changes with org_tune (chief.proxyLevel only through the CEO). Nothing here is a fixed default.*`,
    '',
    '## Profile, as diagnosed',
    '',
    `- Stage: **${plan.stage}** (${plan.stageWhy}).`,
    `- Culture type: **${plan.cultureType}**${cultureWords.length ? ` (words: ${cultureWords.join(', ')})` : ' (no type dominated the profile\'s words)'}.`,
    `- Norms: ${[plan.speed ? 'speed-valuing' : '', plan.rigor ? 'rigour-valuing' : '', plan.writing ? 'writing culture' : ''].filter(Boolean).join(', ') || 'none stated'}.`,
    ctx.vision ? `- Vision: ${ctx.vision}` : ctx.mission ? `- Mission: ${ctx.mission}` : '',
    '',
    '## The chief\'s position',
    '',
    `Archetype: **${plan.archetype}** (chief.proxyLevel ${v('chief.proxyLevel')}). The chief runs the operating system — planning, reporting, decisions, communications — and stays a conductor first; proxy behaviours (cross-team prioritisation, board packs, decision synthesis) switch on only as the CEO raises the dial.`,
    '',
    '## Parameters',
    '',
    '| Parameter | Value | Why |',
    '|---|---|---|',
    ...plan.tunables.map((t) => `| \`${t.key}\` | ${v(t.key)} | ${t.why} |`),
    '',
    '## Decision protocol',
    '',
    plan.decisionProtocol,
    '',
    'Every significant decision has exactly one decider. Reversible (two-way-door) decisions are made fast and logged; irreversible (one-way-door) decisions need a written memo, a named decider and a revisit condition. The chief decides none of the one-way doors.',
    '',
    '## Communication default',
    '',
    plan.commsDefault,
    '',
    '## Why the root rituals look like this',
    '',
    ...plan.rituals.map((r) => `- ${KIND_TITLE[r.kind]}: ${r.why}.`),
    '',
    '## The ledger',
    '',
    '/org/README.md is the index of the whole folder.',
    '',
    '| Artifact | What it holds | Source of truth |',
    '|---|---|---|',
    '| /org/goals/ | objectives, key results, owners, confidence, check-ins | the intent tree (org_intent), generated |',
    '| /org/scorecard.md | 5–15 numbers with owner, target, on/off track | metric sources and check-ins |',
    '| /org/issues.md | off-track items and breached handoffs for the weekly meeting | this file |',
    '| /org/decisions.md | the decision log with one decider each | this file and org_decisions |',
    '| /org/calendar.md | every forum with its purpose, owner, output and empty cycles | the cadences, generated (notes at its end are kept) |',
    '| /org/rituals/<unit>.md | a unit\'s rituals and attendees | the cadences and the org chart, generated |',
    '| /org/risks.md | the risk register | this file |',
    '| /org/handoffs.md | handoff SLAs between functions | this file |',
    '| /org/values.md | values → mechanism map | this file |',
    '| /org/reports/, /org/briefs/, /org/planning/ | the weekly review pack, the daily brief, the quarter\'s planning pack | the chief |',
    '',
  ].join('\n');

  const decisions = [
    `# Decision log — ${ctx.orgName}`,
    '',
    '*One row per significant decision. Exactly one decider. The chief records; it decides only inside its delegated scope. Decisions made by the system (approvals, meetings, tunables) are also in org_decisions — link them here by id.*',
    '',
    '| Date | Question | Decider | Recommender | Inputs / veto | Door | Decision | Rationale | Dissent | Follow-ups | Revisit when |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const risks = [
    `# Risk register — ${ctx.orgName}`,
    '',
    `*Owned by management, kept by the chief. Each risk has an owner other than the chief, a likelihood and impact (1–5), a mitigation and a review date. Reviewed every ${v('chief.riskReviewDays')} day(s) (chief.riskReviewDays). Assurance over this register is the auditor's, not the chief's.*`,
    '',
    '| Risk | Owner | Likelihood | Impact | Mitigation | Status | Last reviewed | Next review |',
    '|---|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const scorecard = [
    `# Scorecard — ${ctx.orgName}`,
    '',
    '*5–15 numbers, each with an owner, a target and on/off track. Reported without discussion; off-track numbers drop to /org/issues.md. A number nobody can explain this week is marked "unknown — investigating", with an owner, never given an invented cause.*',
    '',
    '| Number | Owner | Target | This week | Last 6 weeks | On track? | Note |',
    '|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const issues = [
    `# Issues list — ${ctx.orgName}`,
    '',
    '*Feeds the weekly meeting: the team works the top three in order. Each issue has an owner and a next step; the chief adds off-track numbers and breached handoffs, it does not resolve them.*',
    '',
    '| # | Issue | Raised | Owner | Source | Next step | Status |',
    '|---|---|---|---|---|---|---|',
    '',
  ].join('\n');

  const handoffs = [
    `# Handoff SLAs — ${ctx.orgName}`,
    '',
    `*Each recurring handoff between functions has an SLA, a named owner on each side and a timer. Default SLA: ${v('chief.handoffSlaHours')} h (chief.handoffSlaHours). When a timer expires the item goes to the shared manager or into /org/issues.md; the chief does not resolve it.*`,
    '',
    '| Handoff | From (owner) | To (owner) | SLA | Breaches this month | Note |',
    '|---|---|---|---|---|---|',
    ...ctx.owners.map((o) => `| (to define) work handed to ${o.title} | | ${o.name} | ${v('chief.handoffSlaHours')} h | 0 | |`),
    '',
  ].join('\n');

  const valuesMap = [
    `# Values → mechanisms — ${ctx.orgName}`,
    '',
    '*Each stated value maps to at least one recurring mechanism (a decision protocol, a writing artifact, a talent gate, a rule or ritual, or a conflict order). A value without one is a drift candidate, and a gap between the value and observed behaviour goes to the CEO as a question. Changing this map is a proposal for the CEO.*',
    '',
    '| Value | Mechanism | Evidence it is lived | Status |',
    '|---|---|---|---|',
    ...(plan.values.length ? plan.values.map((x) => `| ${x.replace(/\|/g, '/')} | none yet | — | drift candidate: propose a mechanism |`) : ['| (no values stated yet) | | | ask the CEO |']),
    '',
  ].join('\n');

  return [
    { path: orgPath.operatingSystem, body: os },
    { path: orgPath.decisions, body: decisions },
    { path: orgPath.risks, body: risks },
    { path: orgPath.scorecard, body: scorecard },
    { path: orgPath.issues, body: issues },
    { path: orgPath.handoffs, body: handoffs },
    { path: orgPath.values, body: valuesMap },
  ];
}
