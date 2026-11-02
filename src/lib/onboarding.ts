/** Company onboarding helpers (execution plan item 25; docs/group-chat.md §5
 *  "Onboarding", docs/company-vision.md §1b): the pure part of the New
 *  workspace wizard — the horizon → ISO date, the three run modes and the
 *  three cadence modes with their plain-language consequences, role ranking
 *  by the profile text, validation per step, the review summary and the
 *  bootstrap body. Nothing here is a hidden default: every value the wizard
 *  sends is on screen in the review step. */
import type { BootstrapBody, OrgCaps, OrgRole } from './api';


export type RunMode = 'none' | 'supervised' | 'autonomous';
export type CadenceMode = 'profile' | 'default' | 'light' | 'none';
export type HorizonChoice = 30 | 90 | 180 | 365 | 'date';

export const WORKSPACE_COLORS = ['#F5C451', '#8b8cf0', '#5cc2f2', '#6fcf97', '#f08b8b', '#f0a35c', '#c58bf0', '#8bd3f0'];

export interface ModeCard { mode: RunMode; title: string; blurb: string; consequence: string }
export const MODE_CARDS: ModeCard[] = [
  { mode: 'none', title: 'Just a workspace', blurb: 'Channels and agents; no org chart, no chief of staff.', consequence: 'You run every agent yourself. You can enable a company later from Settings.' },
  { mode: 'supervised', title: 'Company, supervised', blurb: 'A chief of staff plans and proposes; you approve hires, scopes and spend.', consequence: 'Nothing structural happens without your approval card; the chief still assigns and reviews work on its own.' },
  { mode: 'autonomous', title: 'Company, autonomous', blurb: 'The chief acts within hard caps; every action is audited and announced in #company.', consequence: 'Hires, reorganisations and envelopes apply at once within the caps below; plans wait a veto window first. You can still pause everything.' },
];

export interface CadenceCard { mode: CadenceMode; title: string; blurb: string }
export const CADENCE_CARDS: CadenceCard[] = [
  { mode: 'profile', title: 'Fit to my profile', blurb: 'The chief of staff derives the rituals from your stage, values and culture; you can edit every one.' },
  { mode: 'default', title: 'Default rhythm', blurb: 'Daily standup, Friday review and retro, Monday board.' },
  { mode: 'light', title: 'Light', blurb: 'Friday review and Monday board only — no standup, no retro.' },
  { mode: 'none', title: 'No rituals', blurb: 'Nothing scheduled; you or the chief call meetings by hand.' },
];

/** One line per ritual, for the Rhythm step. */
export const RITUAL_LINES: Array<{ kind: string; title: string; line: string }> = [
  { kind: 'standup', title: 'Standup', line: 'A short daily thread per unit: what moved, what is blocked.' },
  { kind: 'weekly_review', title: 'Weekly review', line: 'Each key result owner checks in a value and a confidence; the lead replans.' },
  { kind: 'retro', title: 'Retro', line: 'What to keep, drop and try, written into the memory.' },
  { kind: 'board', title: 'Board', line: 'The chief walks the CEO through the week on the root unit, with decisions.' },
];

export const HORIZONS: Array<{ value: HorizonChoice; label: string }> = [
  { value: 30, label: '30 days' }, { value: 90, label: '90 days' }, { value: 180, label: '180 days' }, { value: 365, label: 'A year' }, { value: 'date', label: 'A date…' },
];

export interface WizardState {
  name: string;
  color: string;
  mode: RunMode;
  chief: { kind: 'create'; name: string; provider: string; model: string } | { kind: 'existing'; agentId: string };
  vision: { title: string; description: string; horizon: HorizonChoice; date: string; rules: string };
  profile: { values: string; culture: string };
  budget: { monthlyUsd: string; agentCap: string };
  cadences: CadenceMode;
  roles: string[];
  planNow: boolean;
}

export const MAX_AGENT_CAP = 50;

export function initialWizardState(over: Partial<WizardState> = {}): WizardState {
  return {
    name: '', color: WORKSPACE_COLORS[0], mode: 'supervised',
    chief: { kind: 'create', name: 'Chief of staff', provider: '', model: '' },
    vision: { title: '', description: '', horizon: 90, date: '', rules: '' },
    profile: { values: '', culture: '' },
    budget: { monthlyUsd: '20', agentCap: '12' },
    cadences: 'profile', roles: [], planNow: true,
    ...over,
  };
}

/** The vision's due date: N days from `now` as an ISO string, the picked
 *  date (local midnight → ISO), or null when the date is empty/invalid. */
export function horizonToIso(choice: HorizonChoice, date: string, now = new Date()): string | null {
  if (choice === 'date') {
    if (!date) return null;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00` : date);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return new Date(now.getTime() + choice * 86_400_000).toISOString();
}

export function horizonLabel(choice: HorizonChoice, date: string): string {
  if (choice === 'date') return date ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'no date';
  return HORIZONS.find((h) => h.value === choice)?.label ?? `${choice} days`;
}

export type WizardStep = 'name' | 'mode' | 'chief' | 'vision' | 'profile' | 'budget' | 'rhythm' | 'hires' | 'review';

/** The steps the wizard shows, in order: name only for a brand-new workspace,
 *  the company steps only when a company mode is picked, hires only when the
 *  role catalog answered. */
export function wizardSteps(state: WizardState, opts: { existing: boolean; rolesAvailable: boolean }): WizardStep[] {
  const steps: WizardStep[] = [];
  if (!opts.existing) steps.push('name');
  steps.push('mode');
  if (state.mode !== 'none') {
    steps.push('chief', 'vision', 'profile', 'budget', 'rhythm');
    if (opts.rolesAvailable) steps.push('hires');
  }
  steps.push('review');
  return steps;
}

export const STEP_TITLES: Record<WizardStep, string> = {
  name: 'Name and colour', mode: 'Run this workspace as a company?', chief: 'Chief of staff', vision: 'Mission and vision', profile: 'Values and culture',
  budget: 'Budget', rhythm: 'Rhythm', hires: 'First hires', review: 'Review',
};

/** Field errors for one step; an empty object means the step may be left. */
export function validateStep(step: WizardStep, state: WizardState, opts: { existing: boolean } = { existing: false }): Record<string, string> {
  const errors: Record<string, string> = {};
  switch (step) {
    case 'name':
      if (!opts.existing && !state.name.trim()) errors.name = 'Give the workspace a name.';
      else if (state.name.trim().length > 60) errors.name = 'Keep the name under 60 characters.';
      break;
    case 'chief':
      if (state.chief.kind === 'create' && !state.chief.name.trim()) errors.chiefName = 'The chief needs a name.';
      if (state.chief.kind === 'existing' && !state.chief.agentId) errors.chiefAgent = 'Pick an agent, or create one.';
      break;
    case 'vision':
      if (!state.vision.title.trim()) errors.title = 'One line: what this company is for.';
      if (state.vision.horizon === 'date' && !horizonToIso('date', state.vision.date)) errors.date = 'Pick a date for the horizon.';
      break;
    case 'budget': {
      const usd = Number(state.budget.monthlyUsd);
      if (state.budget.monthlyUsd.trim() === '' || !Number.isFinite(usd) || usd < 0) errors.monthlyUsd = 'A monthly amount in USD (0 means no envelope).';
      const cap = Number(state.budget.agentCap);
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_AGENT_CAP) errors.agentCap = `Between 1 and ${MAX_AGENT_CAP} members, the chief included.`;
      break;
    }
    default: break;
  }
  return errors;
}

/** Every step's errors, for the review step's "fix this first" list. */
export function validateAll(state: WizardState, opts: { existing: boolean; rolesAvailable: boolean }): Array<{ step: WizardStep; message: string }> {
  const out: Array<{ step: WizardStep; message: string }> = [];
  for (const step of wizardSteps(state, opts)) for (const message of Object.values(validateStep(step, state, opts))) out.push({ step, message });
  return out;
}

/** Rank the catalog roles against the profile + vision text the way the
 *  server does (item 24 `rankRoles`: a `fits` tag mentioned whole or as a
 *  stem scores one), with the title and competencies as tie-breakers; ties
 *  keep catalog order and no role is dropped, so the list is never empty.
 *  The chief's own role is not a first hire. */
export function rankRoles(roles: OrgRole[], profileText: string): OrgRole[] {
  const text = profileText.toLowerCase();
  const words = new Set(tokens(text));
  const hireable = roles.filter((r) => r.id !== 'chief-of-staff');
  if (words.size === 0) return hireable;
  const score = (r: OrgRole) => {
    const fits = (r.fits ?? []).filter((tag) => tag !== 'any' && (words.has(tag) || text.includes(tag))).length;
    const extra = tokens(`${r.title} ${(r.competencies ?? []).join(' ')}`).reduce((n, w) => n + (words.has(w) ? 1 : 0), 0);
    return fits * 10 + extra;
  };
  return hireable.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.r);
}

/** The `templateOrPack` a hire of this role sends: `role:<id>`. */
export const roleHireRef = (roleId: string): string => (roleId.startsWith('role:') ? roleId : `role:${roleId}`);

/** The chip's second line: tier and estimated cost. */
export function roleCostLabel(r: Pick<OrgRole, 'modelTier' | 'estMonthlyUsd'>): string {
  return `${r.modelTier} tier${r.estMonthlyUsd > 0 ? ` · ~$${r.estMonthlyUsd}/mo` : ''}`;
}

/** What the first hires would cost a month at the catalog's estimates. */
export function hiresEstimate(roles: OrgRole[], picked: string[]): number {
  return picked.reduce((n, id) => n + (roles.find((r) => roleHireRef(r.id) === roleHireRef(id))?.estMonthlyUsd ?? 0), 0);
}

const STOP = new Set(['the', 'and', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'with', 'we', 'our', 'is', 'are', 'be', 'that', 'this', 'it', 'as', 'by', 'or', 'not', 'never', 'always', 'at', 'from']);
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/** The body of POST …/org/bootstrap, built only from what is on screen. */
export function buildBootstrapBody(state: WizardState, now = new Date()): BootstrapBody {
  if (state.mode === 'none') throw new Error('no company to bootstrap');
  const dueAt = horizonToIso(state.vision.horizon, state.vision.date, now);
  const body: BootstrapBody = {
    mode: state.mode,
    chief: state.chief.kind === 'existing'
      ? { agentId: state.chief.agentId }
      : { create: { name: state.chief.name.trim() || 'Chief of staff', ...(state.chief.provider ? { provider: state.chief.provider } : {}), ...(state.chief.model ? { model: state.chief.model } : {}) } },
    monthlyUsd: Math.max(0, Number(state.budget.monthlyUsd) || 0),
    agentCap: Math.min(MAX_AGENT_CAP, Math.max(1, parseInt(state.budget.agentCap, 10) || 12)),
    cadences: state.cadences,
    planNow: state.planNow,
  };
  if (state.vision.title.trim()) {
    body.vision = { title: state.vision.title.trim(), description: state.vision.description.trim(), ...(dueAt ? { dueAt } : {}), ...(state.vision.rules.trim() ? { rules: state.vision.rules.trim() } : {}) };
  }
  if (state.profile.values.trim() || state.profile.culture.trim()) body.profile = { values: state.profile.values.trim(), culture: state.profile.culture.trim() };
  if (state.roles.length > 0) body.roles = state.roles.slice(0, 5).map(roleHireRef);
  return body;
}

export interface SummaryLine { label: string; value: string; step: WizardStep }

/** The review step: one line per thing that will be created, in the order it happens. */
export function buildSummary(state: WizardState, opts: { existing: boolean; agentName?: (id: string) => string | undefined; caps?: OrgCaps | null; roleName?: (id: string) => string | undefined }): SummaryLine[] {
  const lines: SummaryLine[] = [];
  if (!opts.existing) lines.push({ label: 'Workspace', value: state.name.trim() || '(unnamed)', step: 'name' });
  const card = MODE_CARDS.find((c) => c.mode === state.mode)!;
  lines.push({ label: 'Run as', value: card.title, step: 'mode' });
  if (state.mode === 'none') return lines;
  lines.push({
    label: 'Chief of staff',
    value: state.chief.kind === 'existing' ? `${opts.agentName?.(state.chief.agentId) ?? 'an existing agent'} (existing)` : `${state.chief.name.trim() || 'Chief of staff'} (new${state.chief.provider ? `, ${state.chief.provider}${state.chief.model ? ` · ${state.chief.model}` : ''}` : ''})`,
    step: 'chief',
  });
  lines.push({ label: 'Vision', value: state.vision.title.trim() ? `${state.vision.title.trim()} · ${horizonLabel(state.vision.horizon, state.vision.date)}` : 'none yet — the chief will ask', step: 'vision' });
  if (state.vision.rules.trim()) lines.push({ label: 'Standing rules', value: clip(state.vision.rules), step: 'vision' });
  lines.push({ label: 'Values', value: state.profile.values.trim() ? clip(state.profile.values) : 'not written', step: 'profile' });
  lines.push({ label: 'Culture', value: state.profile.culture.trim() ? clip(state.profile.culture) : 'not written', step: 'profile' });
  const usd = Math.max(0, Number(state.budget.monthlyUsd) || 0);
  lines.push({ label: 'Budget', value: `$${usd.toFixed(2)} / month · up to ${state.budget.agentCap || '12'} members${usd <= 0 ? ' · no envelope: the chief cannot allocate budget' : ''}`, step: 'budget' });
  if (state.mode === 'autonomous' && opts.caps) lines.push({ label: 'Caps', value: `depth ≤ ${opts.caps.maxDepth}, ≤ ${opts.caps.maxDirectReports} reports each, veto window ${opts.caps.vetoWindowMinutes ?? 30} min`, step: 'budget' });
  lines.push({ label: 'Rhythm', value: CADENCE_CARDS.find((c) => c.mode === state.cadences)!.title, step: 'rhythm' });
  if (state.roles.length > 0) lines.push({ label: 'First hires', value: state.roles.map((r) => opts.roleName?.(r) ?? r).join(', ') + (state.mode === 'supervised' ? ' (as approval cards)' : ' (seated at once)'), step: 'hires' });
  lines.push({ label: 'Then', value: state.planNow && state.vision.title.trim() ? 'the chief runs its first planning session' : 'nothing runs until you ask', step: 'review' });
  return lines;
}

function clip(s: string, n = 90): string { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }

/** The toast after a successful bootstrap. */
export function successToast(r: { planning: string; hires: Array<{ status: string }>; chief: { name: string } }): string {
  const cards = r.hires.filter((h) => h.status === 'proposed').length;
  const tail = cards ? `; ${cards} hire card${cards === 1 ? ' awaits' : 's await'} you` : '';
  if (r.planning === 'queued') return `Company ready — ${r.chief.name} is planning${tail}`;
  return `Company ready — ${r.chief.name} is chief of staff${tail}`;
}
