/**
 * CEO alignment gates, the pure half (docs/alignment.md).
 *
 * Some intent is the CEO's to agree before the company builds on it: the
 * product direction (the vision), the strategy (the chief's strategy memo),
 * the OKRs (objectives and key results) and the project bets. Each such item
 * carries an alignment state — draft → in_alignment → aligned, and back to
 * `realign` when it changes materially — and task creation under an item
 * that is not aligned is refused, model-free, except for a capped amount of
 * discovery work and operating work (incidents, escalations, retro actions,
 * operating processes).
 *
 * Who aligns is a per-workspace tunable per item class
 * (`alignment.required.<class>`: 0 auto-granted and logged, 1 the chief of
 * staff, 2 the CEO), derived from the operating profile at onboarding
 * (`deriveAlignmentTunables`). It governs an autonomous company; a
 * supervised company always aligns with the CEO. What counts as a material
 * change is defined here without a model, with the tolerances as tunables.
 *
 * No Nest, no database: the service, the tools, the migration and the tests
 * share these definitions.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

// ---- items, classes, states ----

export const ALIGNMENT_ITEM_TYPES = ['vision', 'strategy', 'objective', 'key_result', 'project'] as const;
export type AlignmentItemType = typeof ALIGNMENT_ITEM_TYPES[number];
/** draft → in_alignment → aligned; realign after a material change;
 *  rejected; not_required when the owning agent classified it as not
 *  needing alignment (the CEO can pull it in). */
export const ALIGNMENT_STATES = ['draft', 'in_alignment', 'aligned', 'realign', 'rejected', 'not_required'] as const;
export type AlignmentState = typeof ALIGNMENT_STATES[number];
/** Who grants alignment: the CEO (a decision card), the chief of staff, or nobody (auto-granted, logged). */
export type Aligner = 'ceo' | 'chief' | 'auto';
/** States under which work may be built on the item. */
export const CLEARED_STATES: readonly AlignmentState[] = ['aligned', 'not_required'];

/** A profile's say in a class's starting values (deriveAlignmentTunables). */
type Diagnosis = Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>;

/**
 * What needs the CEO's alignment, as data (docs/alignment.md "What needs
 * the CEO"). Each class says what it covers, the criteria that put an item
 * in it, why the CEO keeps it, where the practice comes from, and its
 * starting values: `floor` (1 = in a supervised company every item of the
 * class goes to the CEO; 0 = the owning agent decides by the criteria) and
 * `required` (who aligns in an autonomous company: 0 auto, 1 the chief, 2
 * the CEO). Both are per-workspace tunables derived from the profile.
 */
export interface AlignmentClassDef {
  id: string;
  label: string;
  /** What it covers, in one line. */
  covers: string;
  /** Examples an agent can match against. */
  examples: string[];
  /** The criteria (ids of ALIGNMENT_CRITERIA) that typically put an item here. */
  criteria: string[];
  /** Why the CEO keeps it. */
  rationale: string;
  /** Where the practice comes from (keys of ALIGNMENT_SOURCES). */
  sources: string[];
  /** The item types whose default class this is. */
  defaultFor: AlignmentItemType[];
  derive: (d: Diagnosis) => { floor: number; required: number; why: string };
}

export const ALIGNMENT_CLASS_DEFS: AlignmentClassDef[] = [
  {
    id: 'direction', label: 'product direction', covers: 'The vision, the mission, the core focus: what the company is, for whom, and what it will not do.',
    examples: ['a new or revised vision', 'entering a new market or customer segment', 'dropping a product line'], criteria: ['novelty', 'reversibility', 'blastRadius'],
    rationale: 'Setting the direction is the CEO\'s first job (Wilson; McKinsey CEO Excellence); a change of business is a reserved matter in shareholders\' agreements.',
    sources: ['wilson-ceo', 'mckinsey-ceo', 'reserved-matters', 'eos-vto'], defaultFor: ['vision'],
    derive: ({ cultureType: c, rigor, speed, stage }) => ({ floor: 1, required: c === 'hierarchy' || rigor ? 2 : speed && stage === 'early' ? 0 : 1, why: c === 'hierarchy' || rigor ? 'a control or rigour culture keeps the CEO on the direction even when autonomous' : speed && stage === 'early' ? 'an early, speed-first company runs on its direction and reviews it after the fact' : 'the chief aligns the direction in an autonomous company; the CEO can override after the fact' }),
  },
  {
    id: 'strategy', label: 'strategy', covers: 'Where to play and how to win: the strategy memo, the three-year picture, the big trade-offs.',
    examples: ['the strategy memo', 'a pivot in positioning', 'a build-vs-buy call that sets the roadmap for a year'], criteria: ['novelty', 'blastRadius', 'conflicts'],
    rationale: 'Delegation-of-authority policies keep "objectives and strategy" at the top: the CEO recommends, the board approves.',
    sources: ['doa-matrix', 'mckinsey-ceo', 'eos-vto'], defaultFor: ['strategy'],
    derive: ({ cultureType: c, rigor, speed }) => ({ floor: 1, required: c === 'hierarchy' || rigor ? 2 : speed ? 0 : 1, why: c === 'hierarchy' || rigor ? 'the strategy is agreed with the CEO before it is built on' : speed ? 'speed is a value: the strategy memo is auto-aligned and logged' : 'the chief aligns the strategy memo' }),
  },
  {
    id: 'okr', label: 'OKRs and the plan', covers: 'Company objectives and key results, the annual plan and the quarter\'s priorities (rocks).',
    examples: ['the quarter\'s objectives', 'a key result\'s metric or target', 'a new company-level objective mid-quarter'], criteria: ['blastRadius', 'costShare'],
    rationale: 'Adopting or varying the business plan and budget is the most common reserved matter; EOS has the leadership team set the 1-year plan and the rocks together.',
    sources: ['reserved-matters', 'eos-vto', 'grove-okr'], defaultFor: ['objective', 'key_result'],
    derive: ({ cultureType: c, rigor }) => ({ floor: 1, required: c === 'hierarchy' ? 2 : c === 'market' || rigor ? 1 : 0, why: c === 'hierarchy' ? 'objectives and key results pass the CEO' : c === 'market' || rigor ? 'targets are the scorecard: the chief checks each OKR before work starts' : 'OKRs follow an aligned direction and are auto-aligned' }),
  },
  {
    id: 'projectBet', label: 'project bet', covers: 'A shaped project the company would spend its appetite on (the betting table).',
    examples: ['a new project under a key result', 'a project whose appetite is a large share of the envelope'], criteria: ['costShare', 'blastRadius', 'novelty'],
    rationale: 'Shape Up keeps the betting table with the people who own the time; SAFe needs a lean business case before an epic is approved. Moving a bet to Now stays the CEO\'s either way.',
    sources: ['shape-up', 'safe-epic'], defaultFor: ['project'],
    derive: ({ cultureType: c }) => ({ floor: 0, required: c === 'hierarchy' ? 1 : 0, why: c === 'hierarchy' ? 'the chief checks every proposed bet before shaping work grows' : 'the lead decides by the criteria whether a bet needs the CEO; Now stays the CEO\'s bet' }),
  },
  {
    id: 'budget', label: 'money beyond the plan', covers: 'Spending that is a material share of the envelope, or a deviation from the plan the CEO approved.',
    examples: ['an appetite above alignment.costShare of the monthly envelope', 'a paid tool or vendor on a recurring bill'], criteria: ['costShare'],
    rationale: 'The approved budget is the source of spending authority; consent is usually reserved for material deviations (one proposal: above 20% of approved spend).',
    sources: ['reserved-matters', 'doa-matrix', 'wilson-ceo'], defaultFor: [],
    derive: ({ rigor, cultureType: c }) => ({ floor: rigor || c === 'hierarchy' ? 1 : 0, required: 2, why: rigor || c === 'hierarchy' ? 'every material spend is agreed with the CEO' : 'the owner decides by the cost share; above it, the CEO' }),
  },
  {
    id: 'externalCommitment', label: 'external commitment', covers: 'Promises outside the company: contracts, pricing, partnerships, public announcements, customer commitments.',
    examples: ['a pricing change', 'a partnership or contract', 'a public launch announcement', 'a deadline promised to a customer'], criteria: ['externalCommitment', 'reversibility'],
    rationale: 'Commitments that create liabilities are reserved matters; what leaves the company is hard to take back (a one-way door).',
    sources: ['reserved-matters', 'bezos-2015'], defaultFor: [],
    derive: ({ stage }) => ({ floor: 1, required: stage === 'early' ? 2 : 1, why: stage === 'early' ? 'an early company\'s promises are the CEO\'s' : 'the chief aligns external commitments within the external-action floor' }),
  },
  {
    id: 'orgDesign', label: 'organisation design', covers: 'Senior seats, new functions, reorganisations across units.',
    examples: ['a new function head', 'merging two units', 'a role that changes who decides what'], criteria: ['blastRadius', 'reversibility'],
    rationale: 'Recruiting the senior team is a job the CEO does not delegate (Wilson); senior hires are a reserved matter.',
    sources: ['wilson-ceo', 'reserved-matters'], defaultFor: [],
    derive: ({ cultureType: c }) => ({ floor: 0, required: c === 'clan' || c === 'hierarchy' ? 2 : 1, why: c === 'clan' || c === 'hierarchy' ? 'people decisions pass the CEO' : 'the chief aligns structure within the caps' }),
  },
  {
    id: 'policy', label: 'values and policy', covers: 'The values, the constitution, risk and compliance posture, brand voice — how decisions are made when the CEO is absent.',
    examples: ['a new standing rule', 'a change of risk appetite', 'a brand or voice change'], criteria: ['conflicts', 'blastRadius'],
    rationale: 'Culture is how a company decides when the leader is absent, so the CEO cannot delegate it (Horowitz); the constitution is the owner\'s.',
    sources: ['horowitz-culture', 'mckinsey-ceo'], defaultFor: [],
    derive: () => ({ floor: 1, required: 2, why: 'values and standing rules are the CEO\'s in every mode' }),
  },
  {
    id: 'oneWayDoor', label: 'one-way door', covers: 'Consequential, hard-to-reverse moves: deleting data, migrations without a way back, launches, legal steps.',
    examples: ['deleting customer data', 'a migration with no rollback', 'shutting a product'], criteria: ['reversibility'],
    rationale: 'Type 1 decisions deserve slow, careful, senior judgment; most decisions are Type 2 and should not wait (Amazon 2015 and 2016 letters).',
    sources: ['bezos-2015', 'bezos-2016', 'rapid'], defaultFor: [],
    derive: ({ speed }) => ({ floor: 1, required: speed ? 1 : 2, why: speed ? 'the chief aligns one-way doors so speed is kept for two-way doors' : 'one-way doors pass the CEO' }),
  },
];
export type AlignmentClass = string;
export const ALIGNMENT_CLASSES: readonly string[] = ALIGNMENT_CLASS_DEFS.map((c) => c.id);

/** The sources the classes cite (docs/alignment.md lists them too). */
export const ALIGNMENT_SOURCES: Record<string, { title: string; url: string }> = {
  'wilson-ceo': { title: 'Fred Wilson, "What A CEO Does" (AVC, 2010)', url: 'https://avc.com/2010/09/what-a-ceo-does/' },
  'mckinsey-ceo': { title: 'McKinsey, the six CEO responsibilities (CEO Excellence)', url: 'https://www.mckinsey.com/capabilities/strategy-and-corporate-finance/our-insights/everyday-habits-how-ceos-navigate-their-six-core-responsibilities' },
  'reserved-matters': { title: 'Reserved matters in shareholders\' agreements (Treelife)', url: 'https://treelife.in/legal/reserved-matters-in-sha/' },
  'doa-matrix': { title: 'A delegation-of-authority policy (CNA)', url: 'https://cna.ca/wp-content/uploads/documents/Delegation%20of%20Authority%20Policy.pdf' },
  'eos-vto': { title: 'EOS strategic planning: the V/TO, the 1-year plan and rocks (Ninety)', url: 'https://www.ninety.io/eos/blog/eos-strategic-planning-7-steps-to-turn-vision-into-traction' },
  'grove-okr': { title: 'Google re:Work, set goals with OKRs', url: 'https://rework.withgoogle.com/guides/set-goals-with-okrs/steps/introduction/' },
  'shape-up': { title: 'Basecamp, Shape Up: the betting table', url: 'https://basecamp.com/shapeup/2.2-chapter-08' },
  'safe-epic': { title: 'SAFe, Epic: the lean business case', url: 'https://framework.scaledagile.com/epic' },
  'bezos-2015': { title: 'Amazon 2015 shareholder letter: Type 1 and Type 2 decisions', url: 'https://www.aboutamazon.com/news/company-news/2015-letter-to-shareholders' },
  'bezos-2016': { title: 'Amazon 2016 shareholder letter: 70% of the information, disagree and commit', url: 'https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders' },
  'rapid': { title: 'Bain, RAPID: who decides', url: 'https://www.bain.com/insights/decisions-who-does-what/' },
  'horowitz-culture': { title: 'Ben Horowitz, What You Do Is Who You Are (notes)', url: 'https://www.goodreads.com/notes/44797779-what-you-do-is-who-you-are/82147598-joshua-kroo' },
};

export function classDef(id: string | null | undefined): AlignmentClassDef | undefined { return ALIGNMENT_CLASS_DEFS.find((c) => c.id === id); }
export function isAlignmentClass(v: unknown): v is AlignmentClass { return typeof v === 'string' && ALIGNMENT_CLASSES.includes(v); }

export const CLASS_LABEL: Record<string, string> = Object.fromEntries(ALIGNMENT_CLASS_DEFS.map((c) => [c.id, c.label]));
export const ITEM_LABEL: Record<AlignmentItemType, string> = { vision: 'direction', strategy: 'strategy', objective: 'objective', key_result: 'key result', project: 'project bet' };

/** The default class of an item type (the owner may classify it into another). */
export function classOf(itemType: string): AlignmentClass {
  return ALIGNMENT_CLASS_DEFS.find((c) => (c.defaultFor as string[]).includes(itemType))?.id ?? 'okr';
}

export function isAlignmentItemType(v: unknown): v is AlignmentItemType {
  return typeof v === 'string' && (ALIGNMENT_ITEM_TYPES as readonly string[]).includes(v);
}

/** An actor the gate binds: the chief and agents (humans align by acting). */
export function isAgentish(actor: string | null | undefined): boolean {
  const a = actor ?? '';
  return a === 'chief' || a.startsWith('agent:');
}

// ---- the decision criteria: does this need the CEO? ----

/** The questions an owning agent answers when it classifies an item (data; the tools and the UI show them). */
export const ALIGNMENT_CRITERIA: Array<{ id: string; question: string; values: string; needsWhen: string }> = [
  { id: 'reversibility', question: 'Can it be undone cheaply if it is wrong (a two-way door), or not (a one-way door)?', values: 'two_way | one_way', needsWhen: 'one_way' },
  { id: 'blastRadius', question: 'Who does it touch: your team, your unit, several units, the whole company, people outside it?', values: 'team | unit | cross_unit | company | external', needsWhen: 'company or external; cross_unit counts toward the score' },
  { id: 'costShare', question: 'What share (0–1) of the monthly company envelope does it commit?', values: 'a number 0–1', needsWhen: 'at or above alignment.costShare' },
  { id: 'externalCommitment', question: 'Does it promise anything outside the company (a customer, a partner, the public, a contract, a price)?', values: 'true | false', needsWhen: 'true' },
  { id: 'novelty', question: 'Is it within the aligned vision and strategy, an extension of them, or something new?', values: 'within | extends | new', needsWhen: 'new; extends counts toward the score' },
  { id: 'conflicts', question: 'Does it conflict with a charter, the constitution (the CEO\'s rules), the values or an aligned strategy?', values: 'true | false', needsWhen: 'true' },
];

export interface AlignmentCriteria {
  reversibility?: 'two_way' | 'one_way';
  blastRadius?: 'team' | 'unit' | 'cross_unit' | 'company' | 'external';
  costShare?: number;
  externalCommitment?: boolean;
  novelty?: 'within' | 'extends' | 'new';
  conflicts?: boolean;
}

export function parseCriteria(raw: unknown): AlignmentCriteria {
  const v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => (typeof v[k] === 'string' && (allowed as readonly string[]).includes(v[k] as string) ? v[k] as T : undefined);
  const bool = (k: string) => (typeof v[k] === 'boolean' ? v[k] as boolean : v[k] === 'true' ? true : v[k] === 'false' ? false : undefined);
  const n = Number(v.costShare);
  const out: AlignmentCriteria = {};
  const rev = pick('reversibility', ['two_way', 'one_way'] as const); if (rev) out.reversibility = rev;
  const blast = pick('blastRadius', ['team', 'unit', 'cross_unit', 'company', 'external'] as const); if (blast) out.blastRadius = blast;
  if (v.costShare !== undefined && v.costShare !== null && v.costShare !== '' && Number.isFinite(n)) out.costShare = Math.max(0, Math.min(1, n));
  const ext = bool('externalCommitment'); if (ext !== undefined) out.externalCommitment = ext;
  const nov = pick('novelty', ['within', 'extends', 'new'] as const); if (nov) out.novelty = nov;
  const con = bool('conflicts'); if (con !== undefined) out.conflicts = con;
  return out;
}

/** Model-free: what the criteria say — whether it needs the CEO, why, and the class they point to. */
export function assessCriteria(c: AlignmentCriteria, costShareThreshold: number): { needs: boolean; reasons: string[]; suggestedClass: AlignmentClass | null } {
  const reasons: string[] = [];
  let suggested: AlignmentClass | null = null;
  let score = 0;
  if (c.conflicts) { reasons.push('it conflicts with a charter, the constitution, the values or the strategy'); suggested ??= 'policy'; }
  if (c.externalCommitment) { reasons.push('it commits the company outside itself'); suggested ??= 'externalCommitment'; }
  if (c.reversibility === 'one_way') { reasons.push('it is a one-way door'); suggested ??= 'oneWayDoor'; }
  if (c.costShare !== undefined && c.costShare >= costShareThreshold) { reasons.push(`it commits ${Math.round(c.costShare * 100)}% of the monthly envelope (threshold ${Math.round(costShareThreshold * 100)}%)`); suggested ??= 'budget'; }
  if (c.novelty === 'new') { reasons.push('it is new against the aligned vision and strategy'); suggested ??= 'direction'; }
  if (c.blastRadius === 'company' || c.blastRadius === 'external') reasons.push(`its blast radius is ${c.blastRadius === 'company' ? 'the whole company' : 'outside the company'}`);
  if (c.blastRadius === 'cross_unit') score++;
  if (c.novelty === 'extends') score++;
  if (reasons.length === 0 && score >= 2) reasons.push('it crosses units and extends the strategy');
  return { needs: reasons.length > 0, reasons, suggestedClass: suggested };
}

/** Words in a title or brief that suggest a commitment the criteria should have caught (the spot-check, model-free). */
export const ESCALATION_HINTS = /\b(contracts?|pricing|prices?|partners?(hip)?|announce\w*|press release|launch\w*|legal|lawsuit|delet\w*|migrat\w*|shut ?down|sunset|rebrand\w*|acquisition|vendors?)\b/i;

// ---- tunables ----

const BASE: Diagnosis = { stage: 'growth', cultureType: 'balanced', speed: false, rigor: false };

export const ALIGNMENT_TUNABLES: Record<string, TunableDef> = {
  ...Object.fromEntries(ALIGNMENT_CLASS_DEFS.flatMap((c): Array<[string, TunableDef]> => {
    const base = c.derive(BASE);
    return [
      [`alignment.required.${c.id}`, { default: base.required, min: 0, max: 2, area: 'intent', description: `Who aligns ${c.label} items in an autonomous company: 0 auto-granted and logged, 1 the chief of staff, 2 the CEO. ${c.covers}` }],
      [`alignment.floor.${c.id}`, { default: base.floor, min: 0, max: 1, area: 'intent', description: `Supervised company: 1 every ${c.label} item goes to the CEO (the model-free floor); 0 the owning agent decides by the criteria whether it needs the CEO, and the chief and the auditor spot-check it.` }],
    ];
  })),
  'alignment.costShare': { default: 0.2, min: 0.01, max: 1, area: 'intent', description: 'Share (0–1) of the monthly company envelope at or above which an item\'s cost alone means it needs alignment (reserved-matters practice: consent for material deviations).' },
  'alignment.discoveryCap': { default: 2, min: 0, max: 10, area: 'intent', description: 'Open discovery tasks (class discovery) allowed under one item that is not aligned yet: the shaping work needed to write its alignment brief.' },
  'alignment.unsortedCap': { default: 5, min: 0, max: 50, area: 'intent', description: 'Open agent-created, non-operating tasks a unit\'s Unsorted project may hold while alignment is required; more wait as unassigned proposals (work that serves nothing aligned is limited).' },
  'alignment.tolerance.targetShare': { default: 0.1, min: 0, max: 1, area: 'intent', description: 'How far (share of the aligned value) a key result\'s target or a project\'s appetite may move before the change is material and re-opens alignment.' },
  'alignment.tolerance.days': { default: 14, min: 0, max: 180, area: 'intent', description: 'Days a due date or target date may move before the change is material and re-opens alignment.' },
  'alignment.tolerance.textShare': { default: 0.5, min: 0.05, max: 1, area: 'intent', description: 'How much (0–1, share of words) a title, scope or memo may change before the edit is material rather than cosmetic.' },
  'alignment.cadenceDays.direction': { default: 365, min: 0, max: 730, area: 'intent', description: 'Days after which an aligned direction is due for re-alignment with the CEO (0 never).' },
  'alignment.cadenceDays.strategy': { default: 180, min: 0, max: 365, area: 'intent', description: 'Days after which an aligned strategy is due for re-alignment (0 never).' },
  'alignment.cadenceDays.okr': { default: 90, min: 0, max: 365, area: 'intent', description: 'Days after which aligned OKRs are due for re-alignment — the quarterly OKR alignment (0 never).' },
  'alignment.cadenceDays.projectBet': { default: 0, min: 0, max: 365, area: 'intent', description: 'Days after which an aligned project bet is due for re-alignment (0 never: appetite and the breaker review bets).' },
};
registerTunables(ALIGNMENT_TUNABLES);

const ALIGNERS: Aligner[] = ['auto', 'chief', 'ceo'];
const keyClass = (cls: string) => (isAlignmentClass(cls) ? cls : 'okr');

/** Who aligns an item of this class here. Supervised: the CEO. Autonomous:
 *  the tunable. Off (no company mode): nobody — the gate is open. */
export function alignerFor(org: { tunables?: string | null } | null | undefined, mode: string | null | undefined, cls: AlignmentClass): Aligner {
  if (mode === 'supervised') return 'ceo';
  if (mode !== 'autonomous') return 'auto';
  return ALIGNERS[Math.round(tunable(org, `alignment.required.${keyClass(cls)}`))] ?? 'ceo';
}

/** The model-free floor: in a supervised company a class whose floor is 1 always goes to the CEO — the agent cannot classify it out. */
export function floorRequired(org: { tunables?: string | null } | null | undefined, mode: string | null | undefined, cls: AlignmentClass): boolean {
  return mode === 'supervised' && tunable(org, `alignment.floor.${keyClass(cls)}`) >= 1;
}

/** Whether any class needs someone's alignment in this mode (the Unsorted cap applies then). */
export function gateActive(org: { tunables?: string | null } | null | undefined, mode: string | null | undefined): boolean {
  return ALIGNMENT_CLASSES.some((c) => alignerFor(org, mode, c) !== 'auto');
}

export interface Tolerances { targetShare: number; days: number; textShare: number }
export function tolerancesOf(org: { tunables?: string | null } | null | undefined): Tolerances {
  return { targetShare: tunable(org, 'alignment.tolerance.targetShare'), days: tunable(org, 'alignment.tolerance.days'), textShare: tunable(org, 'alignment.tolerance.textShare') };
}

export function cadenceDaysOf(org: { tunables?: string | null } | null | undefined, cls: AlignmentClass): number {
  const key = `alignment.cadenceDays.${cls}`;
  return ALIGNMENT_TUNABLES[key] ? tunable(org, key) : 0;
}

/** Starting values from the profile: each class's floor and aligner by its
 *  own rule (ALIGNMENT_CLASS_DEFS), then the shared cost share, caps,
 *  tolerances and cadences — a control or rigour culture tightens them,
 *  speed and an early stage loosen them. Pure; within every bound. */
export function deriveAlignmentTunables(d: Diagnosis): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const control = c === 'hierarchy' || rigor;
  const fast = speed && stage === 'early';
  const perClass = ALIGNMENT_CLASS_DEFS.flatMap((def) => {
    const v = def.derive(d);
    return [
      { key: `alignment.required.${def.id}`, value: v.required, why: v.why },
      { key: `alignment.floor.${def.id}`, value: v.floor, why: v.floor ? `${def.label}: always the CEO's in a supervised company` : `${def.label}: the owner decides by the criteria; the chief and the auditor spot-check` },
    ];
  });
  return [
    ...perClass,
    { key: 'alignment.costShare', value: control ? 0.1 : speed ? 0.3 : 0.2, why: control ? 'a tenth of the envelope is material' : speed ? 'only large commitments wait for the CEO' : 'a fifth of the envelope is material (reserved-matters practice)' },
    { key: 'alignment.discoveryCap', value: speed || c === 'adhocracy' ? 3 : c === 'hierarchy' ? 1 : 2, why: speed || c === 'adhocracy' ? 'room to explore before the brief' : c === 'hierarchy' ? 'one shaping task, then the brief' : 'two shaping tasks before the brief' },
    { key: 'alignment.unsortedCap', value: c === 'hierarchy' ? 3 : speed || c === 'adhocracy' ? 8 : 5, why: c === 'hierarchy' ? 'little work that serves no aligned goal' : speed || c === 'adhocracy' ? 'loose work is tolerated longer' : 'a few loose tasks, then they wait as proposals' },
    { key: 'alignment.tolerance.targetShare', value: control ? 0.05 : speed ? 0.2 : 0.1, why: control ? 'a target that moves 5% is a new commitment' : speed ? 'targets flex by a fifth before the CEO is asked again' : 'a target moving more than 10% re-opens alignment' },
    { key: 'alignment.tolerance.days', value: c === 'hierarchy' ? 7 : speed ? 21 : 14, why: c === 'hierarchy' ? 'a week\'s slip is a new commitment' : speed ? 'dates flex by three weeks' : 'dates flex by two weeks' },
    { key: 'alignment.tolerance.textShare', value: control ? 0.35 : 0.5, why: control ? 'rewording a third of a scope is a scope change' : 'rewording half of it is' },
    { key: 'alignment.cadenceDays.direction', value: stage === 'early' ? 180 : 365, why: stage === 'early' ? 'an early company re-checks its direction twice a year' : 'the direction is re-aligned yearly' },
    { key: 'alignment.cadenceDays.strategy', value: stage === 'early' || c === 'hierarchy' ? 90 : 180, why: stage === 'early' || c === 'hierarchy' ? 'the strategy is re-aligned every quarter' : 'the strategy is re-aligned twice a year' },
    { key: 'alignment.cadenceDays.okr', value: fast ? 60 : 90, why: fast ? 'short OKR cycles while early and fast' : 'quarterly OKR alignment' },
    { key: 'alignment.cadenceDays.projectBet', value: c === 'hierarchy' ? 90 : 0, why: c === 'hierarchy' ? 'bets are re-confirmed each quarter' : 'bets are reviewed through their appetite, not a calendar' },
  ].map((t) => { const def = ALIGNMENT_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}

// ---- the brief ----

/** What the owner prepares before asking for alignment. */
export interface AlignmentBrief {
  what: string;
  why: string;
  options: string[];
  tradeoffs: string;
  measures: string;
  cost: string;
  unlocks: string;
}

export function parseAlignmentBrief(raw: unknown): AlignmentBrief {
  let v: Record<string, unknown> = {};
  if (typeof raw === 'string') { try { v = JSON.parse(raw || '{}') as Record<string, unknown>; } catch { v = {}; } } else if (raw && typeof raw === 'object') v = raw as Record<string, unknown>;
  const s = (k: string, ...alts: string[]) => { for (const key of [k, ...alts]) if (typeof v[key] === 'string' && (v[key] as string).trim()) return (v[key] as string).trim().slice(0, 3_000); return ''; };
  const opts = v.options ?? v.alternatives;
  const options = (Array.isArray(opts) ? opts.map(String) : typeof opts === 'string' ? opts.split(/\n+|;\s*/) : []).map((x) => x.trim().slice(0, 400)).filter(Boolean).slice(0, 6);
  return { what: s('what'), why: s('why'), options, tradeoffs: s('tradeoffs'), measures: s('measures', 'successMeasures', 'success'), cost: s('cost'), unlocks: s('unlocks') };
}

/** Model-free completeness: what a brief is missing before it may go to the aligner. */
export function briefGaps(b: AlignmentBrief): string[] {
  const gaps: string[] = [];
  if (b.what.length < 10) gaps.push('what (the item, said plainly)');
  if (b.why.length < 10) gaps.push('why (the problem or opportunity, and the evidence)');
  if (b.options.length === 0) gaps.push('options (the alternatives you considered, including "do nothing")');
  if (b.measures.length < 5) gaps.push('measures (how we will know it worked)');
  return gaps;
}

export function describeBrief(b: AlignmentBrief): string {
  const line = (k: string, v: string) => `${k}: ${v || '(not stated)'}`;
  return [line('What', b.what), line('Why', b.why), `Options considered: ${b.options.length ? b.options.map((o, i) => `(${i + 1}) ${o}`).join(' ') : '(not stated)'}`, line('Trade-offs', b.tradeoffs), line('Success measures', b.measures), line('Cost', b.cost), line('Unlocks', b.unlocks)].join('\n');
}

// ---- snapshots and material change ----

/** The fields of an item that alignment covers, as aligned. */
export interface AlignSnapshot {
  title?: string;
  description?: string;
  kind?: string;
  parentGoalId?: string | null;
  metric?: string;
  targetValue?: number | null;
  dueAt?: string | null;
  goalIds?: string[];
  scope?: string;
  appetiteDays?: number;
  appetiteUsd?: number;
  targetDate?: string | null;
  memo?: string;
}

export function snapshotOfGoal(g: { title: string; description?: string | null; kind: string; parentGoalId?: string | null; metric?: string | null; targetValue?: number | null; dueAt?: string | null }): AlignSnapshot {
  return { title: g.title, description: g.description ?? '', kind: g.kind, parentGoalId: g.parentGoalId ?? null, metric: g.metric ?? '', targetValue: g.targetValue ?? null, dueAt: g.dueAt ?? null };
}

export function snapshotOfProject(p: { title: string; goalIds?: string | string[] | null; brief?: string | null; appetiteDays?: number | null; appetiteUsd?: number | null; targetDate?: string | null }): AlignSnapshot {
  let goalIds: string[];
  if (Array.isArray(p.goalIds)) goalIds = p.goalIds;
  else { try { const v = JSON.parse(p.goalIds || '[]') as unknown; goalIds = Array.isArray(v) ? v.map(String) : []; } catch { goalIds = []; } }
  let brief: Record<string, unknown> = {};
  try { brief = JSON.parse(p.brief || '{}') as Record<string, unknown>; } catch { brief = {}; }
  const scope = ['problem', 'hypothesis', 'done_when', 'mvp'].map((k) => (typeof brief[k] === 'string' ? brief[k] as string : '')).join(' \n ').trim();
  return { title: p.title, goalIds: [...new Set(goalIds)].sort(), scope, appetiteDays: p.appetiteDays ?? 0, appetiteUsd: p.appetiteUsd ?? 0, targetDate: p.targetDate ?? null };
}

export function snapshotOfStrategy(memo: string): AlignSnapshot { return { memo: memo ?? '' }; }

const WORD = /[\p{L}\p{N}]{3,}/gu;
function words(s: string): Set<string> { return new Set((s.toLowerCase().match(WORD) ?? [])); }

/** Share of words that differ between two texts (1 − Jaccard), 0 when both are empty. */
export function textDistance(a: string | null | undefined, b: string | null | undefined): number {
  const A = words(a ?? ''); const B = words(b ?? '');
  if (A.size === 0 && B.size === 0) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return 1 - both / (A.size + B.size - both);
}

function dayShift(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const x = Date.parse(a); const y = Date.parse(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return a === b ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(x - y) / 86_400_000;
}

function relShift(a: number | null | undefined, b: number | null | undefined): number {
  if ((a ?? null) === (b ?? null)) return 0;
  if (a === null || a === undefined || b === null || b === undefined) return Number.POSITIVE_INFINITY;
  if (a === b) return 0;
  return Math.abs(b - a) / Math.max(Math.abs(a), 1e-9);
}

/**
 * Why an edit to an aligned item is material — the scope, the target, the
 * metric or the timeline moved beyond tolerance — or [] when it is cosmetic
 * (a typo, a rewording within `textShare`, a date within `days`). Pure.
 */
export function materialChanges(before: AlignSnapshot, after: AlignSnapshot, tol: Tolerances): string[] {
  const out: string[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (before.memo !== undefined || after.memo !== undefined) {
    const d = textDistance(before.memo, after.memo);
    if (d > tol.textShare) out.push(`the strategy was rewritten (${pct(d)} of its words changed; tolerance ${pct(tol.textShare)})`);
    return out;
  }
  if (before.kind !== undefined && after.kind !== undefined && before.kind !== after.kind) out.push(`it changed from ${before.kind.replace('_', ' ')} to ${after.kind.replace('_', ' ')}`);
  if ((before.parentGoalId ?? null) !== (after.parentGoalId ?? null) && (before.parentGoalId !== undefined || after.parentGoalId !== undefined)) out.push('it moved under another goal');
  const title = textDistance(before.title, after.title);
  if (title > tol.textShare) out.push(`the title changed in substance (${pct(title)} of its words)`);
  if ((before.kind === 'vision' || before.kind === 'objective') && textDistance(before.description, after.description) > tol.textShare && (before.description ?? '').trim().length + (after.description ?? '').trim().length > 40) out.push('its description (scope) was rewritten');
  if ((before.metric ?? '').trim().toLowerCase() !== (after.metric ?? '').trim().toLowerCase() && (before.metric || after.metric)) out.push(`the metric changed ("${before.metric || 'none'}" → "${after.metric || 'none'}")`);
  const target = relShift(before.targetValue, after.targetValue);
  if (target > tol.targetShare) out.push(`the target moved ${Number.isFinite(target) ? pct(target) : ''} (${before.targetValue ?? 'none'} → ${after.targetValue ?? 'none'}; tolerance ${pct(tol.targetShare)})`.replace('  ', ' '));
  const due = dayShift(before.dueAt, after.dueAt);
  if (due > tol.days) out.push(`the due date moved${Number.isFinite(due) ? ` ${Math.round(due)} days` : ''} (tolerance ${tol.days} days)`);
  if (before.goalIds !== undefined || after.goalIds !== undefined) {
    const a = (before.goalIds ?? []).join(','); const b = (after.goalIds ?? []).join(',');
    if (a !== b) out.push('the key results it moves changed');
    const scope = textDistance(before.scope, after.scope);
    if (scope > tol.textShare && ((before.scope ?? '').length + (after.scope ?? '').length) > 20) out.push(`its scope (brief) was rewritten (${pct(scope)} of its words)`);
    const days = relShift(before.appetiteDays || null, after.appetiteDays || null);
    if (days > tol.targetShare && (before.appetiteDays || after.appetiteDays)) out.push(`its appetite in days moved (${before.appetiteDays ?? 0} → ${after.appetiteDays ?? 0})`);
    const usd = relShift(before.appetiteUsd || null, after.appetiteUsd || null);
    if (usd > tol.targetShare && (before.appetiteUsd || after.appetiteUsd)) out.push(`its appetite in USD moved (${before.appetiteUsd ?? 0} → ${after.appetiteUsd ?? 0})`);
    const td = dayShift(before.targetDate, after.targetDate);
    if (td > tol.days && (before.targetDate || after.targetDate)) out.push(`its target date moved${Number.isFinite(td) ? ` ${Math.round(td)} days` : ''}`);
  }
  return out;
}

// ---- the task gate's predicates ----

/** What the gate reads of a task being created (process fields may not exist yet). */
export interface GateTask {
  title?: string | null;
  source?: string | null;
  class?: string | null;
  brief?: unknown;
  createdBy?: string | null;
  /** The kind of the project the task lands in (project | unsorted | operating). */
  projectKind?: string | null;
  /** Process engine fields, when present (a materialised process step). */
  processRunId?: unknown;
  processNodeId?: unknown;
  processCategory?: unknown;
  process?: unknown;
}

const OPERATING_SOURCES = new Set(['incident', 'escalation', 'retro']);
/** Classes that are operating work outside any bet: not counted against the Unsorted cap. */
const OPERATING_CLASSES = new Set(['ops', 'triage', 'review']);

function constraintsOf(brief: unknown): string {
  if (typeof brief === 'string') { try { const v = JSON.parse(brief) as { constraints?: unknown }; return typeof v.constraints === 'string' ? v.constraints : ''; } catch { return ''; } }
  if (brief && typeof brief === 'object') { const c = (brief as { constraints?: unknown }).constraints; return typeof c === 'string' ? c : ''; }
  return '';
}

/** The category of the process a task materialises from, tolerating the
 *  process engine's fields not existing (processCategory, process.category,
 *  or a `process:operating` tag in the constraints). */
export function processCategoryOf(t: GateTask): string {
  if (typeof t.processCategory === 'string') return t.processCategory.toLowerCase();
  if (t.process && typeof t.process === 'object' && typeof (t.process as { category?: unknown }).category === 'string') return ((t.process as { category: string }).category).toLowerCase();
  const m = /\bprocess:\s*([a-z_-]+)/i.exec(constraintsOf(t.brief));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Whether a task is operating work that never waits on alignment: an
 * incident, an escalation or a retro action; a step of an operating process
 * (source `process` with category operating); or a task in a unit's
 * Operating improvements project. Everything else is gated by what it
 * serves. Pure, and tolerant of fields that do not exist yet.
 */
export function isAlignmentExempt(t: GateTask): boolean {
  const source = String(t.source ?? '');
  if (OPERATING_SOURCES.has(source)) return true;
  if (source === 'process' || t.processRunId) return processCategoryOf(t) === 'operating';
  if (t.projectKind === 'operating') return true;
  return false;
}

/** Discovery / shaping work that prepares an alignment brief (class discovery, or tagged so). */
export function isDiscovery(t: GateTask): boolean {
  if (String(t.class ?? '').toLowerCase() === 'discovery') return true;
  if (/^\s*discovery\s*:/i.test(String(t.title ?? ''))) return true;
  return /\bdiscovery\b/i.test(constraintsOf(t.brief));
}

/** Operating classes that the Unsorted cap does not count. */
export function isOperatingClass(t: GateTask): boolean {
  return OPERATING_CLASSES.has(String(t.class ?? '').toLowerCase());
}

/** The refusal an agent reads when it builds on an item that is not aligned. */
export function gateRefusal(item: { label: string; title: string; state: AlignmentState; aligner: Aligner; unclassified?: boolean }, discovery: { open: number; cap: number }): string {
  if (item.unclassified && item.state === 'draft') return `refused: ${item.label} "${item.title}" is not classified yet. Decide whether it needs ${item.aligner === 'ceo' ? 'the CEO\'s' : 'the chief of staff\'s'} alignment with org_classify_alignment — needsAlignment, the class and your reasoning against the criteria (reversibility, blast radius, cost share, external commitment, novelty, conflicts) — and request alignment with org_request_alignment if it does; or do preparatory work tagged as discovery (class: discovery — ${discovery.open} of ${discovery.cap} open under it).`;
  const who = item.aligner === 'ceo' ? 'CEO' : item.aligner === 'chief' ? 'the chief of staff\'s' : '';
  const state = item.state === 'in_alignment' ? `awaiting ${who} alignment` : item.state === 'realign' ? `changed materially and needs ${who} re-alignment` : item.state === 'rejected' ? `not aligned (the ${item.aligner === 'ceo' ? 'CEO' : 'chief'} rejected it)` : `not aligned with ${item.aligner === 'ceo' ? 'the CEO' : 'the chief of staff'} yet`;
  return `refused: ${item.label} "${item.title}" is ${state}. ${item.state === 'in_alignment' ? 'Wait for the decision, answer the comments with org_alignment_comment, ' : 'Prepare the brief and request alignment with org_request_alignment, '}or do preparatory work tagged as discovery (class: discovery — ${discovery.open} of ${discovery.cap} open under it, alignment.discoveryCap).`;
}
