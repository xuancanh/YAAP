/** Company onboarding helpers (execution plan item 25; docs/group-chat.md §5
 *  "Onboarding"): horizon → ISO, the steps per choice, validation, role
 *  ranking by the profile, the bootstrap body built only from what is on
 *  screen, the review summary, the toast and the tolerant role reader. */
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapBody, buildSummary, CADENCE_CARDS, hiresEstimate, horizonLabel, horizonToIso, initialWizardState, MODE_CARDS, rankRoles, roleCostLabel, roleHireRef, successToast, validateAll, validateStep, wizardSteps,
} from '../src/lib/onboarding';
import { normalizeRoles, type OrgRole } from '../src/lib/api';

const now = new Date('2026-11-01T12:00:00Z');

describe('horizon', () => {
  it('turns 30/90/180/365 days into an ISO date from now, and a picked date into local midnight', () => {
    expect(horizonToIso(90, '', now)).toBe('2027-01-30T12:00:00.000Z');
    expect(horizonToIso(30, '', now)).toBe('2026-12-01T12:00:00.000Z');
    const picked = horizonToIso('date', '2027-03-01', now)!;
    expect(new Date(picked).getFullYear()).toBe(2027);
    expect(new Date(picked).getMonth()).toBe(2);
    expect(new Date(picked).getDate()).toBe(1);
    expect(horizonToIso('date', '', now)).toBeNull();
    expect(horizonToIso('date', 'not a date', now)).toBeNull();
  });
  it('labels the choice in plain words', () => {
    expect(horizonLabel(90, '')).toBe('90 days');
    expect(horizonLabel(365, '')).toBe('A year');
    expect(horizonLabel('date', '')).toBe('no date');
    expect(horizonLabel('date', '2027-03-01')).toMatch(/2027/);
  });
});

describe('steps', () => {
  it('shows name only for a new workspace, the company steps only for a company mode, hires only when the catalog answered', () => {
    const s = initialWizardState();
    expect(wizardSteps({ ...s, mode: 'none' }, { existing: false, rolesAvailable: true })).toEqual(['name', 'mode', 'review']);
    expect(wizardSteps({ ...s, mode: 'none' }, { existing: true, rolesAvailable: true })).toEqual(['mode', 'review']);
    expect(wizardSteps({ ...s, mode: 'supervised' }, { existing: false, rolesAvailable: false })).toEqual(['name', 'mode', 'chief', 'vision', 'profile', 'budget', 'rhythm', 'review']);
    expect(wizardSteps({ ...s, mode: 'autonomous' }, { existing: true, rolesAvailable: true })).toEqual(['mode', 'chief', 'vision', 'profile', 'budget', 'rhythm', 'hires', 'review']);
  });
  it('has a plain-language consequence on every mode card and a blurb on every cadence card', () => {
    expect(MODE_CARDS.map((c) => c.mode)).toEqual(['none', 'supervised', 'autonomous']);
    for (const c of MODE_CARDS) expect(c.consequence.length).toBeGreaterThan(20);
    expect(CADENCE_CARDS.map((c) => c.mode)).toEqual(['profile', 'default', 'light', 'none']);
    expect(CADENCE_CARDS.find((c) => c.mode === 'light')!.blurb).toMatch(/no standup/);
  });
});

describe('validation', () => {
  it('requires a name for a new workspace, a chief name or an agent, a vision line, a date when the horizon is a date, and a budget within the fence', () => {
    const s = initialWizardState();
    expect(validateStep('name', s).name).toMatch(/name/);
    expect(validateStep('name', { ...s, name: 'Lab' })).toEqual({});
    expect(validateStep('name', s, { existing: true })).toEqual({});
    expect(validateStep('chief', { ...s, chief: { kind: 'create', name: '  ', provider: '', model: '' } }).chiefName).toBeTruthy();
    expect(validateStep('chief', { ...s, chief: { kind: 'existing', agentId: '' } }).chiefAgent).toBeTruthy();
    expect(validateStep('chief', { ...s, chief: { kind: 'existing', agentId: 'a1' } })).toEqual({});
    expect(validateStep('vision', s).title).toBeTruthy();
    expect(validateStep('vision', { ...s, vision: { ...s.vision, title: 'Ship', horizon: 'date', date: '' } }).date).toBeTruthy();
    expect(validateStep('vision', { ...s, vision: { ...s.vision, title: 'Ship', horizon: 'date', date: '2027-01-01' } })).toEqual({});
    expect(validateStep('budget', { ...s, budget: { monthlyUsd: '-3', agentCap: '12' } }).monthlyUsd).toBeTruthy();
    expect(validateStep('budget', { ...s, budget: { monthlyUsd: '', agentCap: '12' } }).monthlyUsd).toBeTruthy();
    expect(validateStep('budget', { ...s, budget: { monthlyUsd: '0', agentCap: '0' } }).agentCap).toMatch(/1 and 50/);
    expect(validateStep('budget', { ...s, budget: { monthlyUsd: '0', agentCap: '51' } }).agentCap).toBeTruthy();
    expect(validateStep('budget', { ...s, budget: { monthlyUsd: '20', agentCap: '12' } })).toEqual({});
    expect(validateStep('profile', s)).toEqual({});
  });
  it('collects every step\'s errors for the review, and none for a plain workspace with a name', () => {
    const s = initialWizardState({ name: 'Lab', mode: 'none' });
    expect(validateAll(s, { existing: false, rolesAvailable: false })).toEqual([]);
    const all = validateAll(initialWizardState({ mode: 'supervised' }), { existing: false, rolesAvailable: false });
    expect(all.map((e) => e.step)).toEqual(['name', 'vision']);
  });
});

describe('roles (item 24 catalog)', () => {
  const role = (id: string, title: string, fits: string[], competencies: string[] = [], over: Partial<OrgRole> = {}): OrgRole => ({ id, title, charter: `You are the ${title} of {company}.`, competencies, toolScopes: ['tool:fs_read'], modelTier: 'standard', estMonthlyUsd: 8, fits, ...over });
  const roles: OrgRole[] = [
    role('chief-of-staff', 'Chief of staff', ['any', 'company'], ['planning'], { modelTier: 'strong', estMonthlyUsd: 15 }),
    role('researcher', 'Researcher', ['research', 'evidence', 'market'], ['source verification']),
    role('marketer', 'Marketer', ['marketing', 'newsletter', 'content', 'audience'], ['campaigns']),
    role('controller', 'Controller', ['finance', 'invoices', 'budget'], ['monthly close'], { modelTier: 'cheap', estMonthlyUsd: 4 }),
  ];
  it('ranks by fits tags the way the server does, never offers the chief as a hire, keeps catalog order on ties and drops nothing else', () => {
    expect(rankRoles(roles, 'A weekly newsletter: content for a growing audience; cite your evidence.').map((r) => r.id)).toEqual(['marketer', 'researcher', 'controller']);
    expect(rankRoles(roles, 'invoices every month').map((r) => r.id)[0]).toBe('controller');
    expect(rankRoles(roles, '').map((r) => r.id)).toEqual(['researcher', 'marketer', 'controller']);
    expect(rankRoles(roles, 'zzz').map((r) => r.id)).toEqual(['researcher', 'marketer', 'controller']);
    // a competency word breaks a tie, a fits tag outweighs it
    expect(rankRoles(roles, 'campaigns').map((r) => r.id)[0]).toBe('marketer');
    expect(rankRoles(roles, 'campaigns research').map((r) => r.id)[0]).toBe('researcher');
  });
  it('names a hire as role:<id>, labels the tier and cost, and sums the estimate', () => {
    expect(roleHireRef('marketer')).toBe('role:marketer');
    expect(roleHireRef('role:marketer')).toBe('role:marketer');
    expect(roleCostLabel(roles[3])).toBe('cheap tier · ~$4/mo');
    expect(roleCostLabel({ modelTier: 'standard', estMonthlyUsd: 0 })).toBe('standard tier');
    expect(hiresEstimate(roles, ['marketer', 'role:controller', 'nope'])).toBe(12);
  });
  it('reads the route\'s { profile, roles } shape and a bare array, defaults the list fields, and skips rows without an id and a title', () => {
    const got = normalizeRoles({ profile: 'x', roles: [{ id: 'researcher', title: 'Researcher', charter: 'c', competencies: ['a'], toolScopes: ['tool:fs_read'], modelTier: 'standard', estMonthlyUsd: 8, fits: ['research'], score: 1, matched: ['research'] }, { id: 'x' }, null, { id: 'y', name: 'Y' }] });
    expect(got).toEqual([
      { id: 'researcher', title: 'Researcher', charter: 'c', competencies: ['a'], toolScopes: ['tool:fs_read'], modelTier: 'standard', estMonthlyUsd: 8, fits: ['research'], score: 1, matched: ['research'] },
      { id: 'y', title: 'Y', charter: '', competencies: [], toolScopes: [], modelTier: 'standard', estMonthlyUsd: 0, fits: [] },
    ]);
    expect(normalizeRoles([{ id: 'a', title: 'A' }])).toHaveLength(1);
    expect(normalizeRoles(null)).toEqual([]);
    expect(normalizeRoles('nope')).toEqual([]);
  });
});

describe('bootstrap body and summary', () => {
  const full = initialWizardState({
    name: 'Letters', mode: 'autonomous',
    chief: { kind: 'create', name: ' Nova ', provider: 'anthropic', model: '' },
    vision: { title: ' Be forwarded ', description: 'A weekly letter.', horizon: 90, date: '', rules: 'No paid promotion.' },
    profile: { values: 'ship weekly', culture: 'terse, async' },
    budget: { monthlyUsd: '40', agentCap: '8' }, cadences: 'light', roles: ['marketer'], planNow: true,
  });
  it('builds the body only from what is on screen: trimmed, no empty optional fields, provider only when picked', () => {
    const body = buildBootstrapBody(full, now);
    expect(body).toEqual({
      mode: 'autonomous', chief: { create: { name: 'Nova', provider: 'anthropic' } }, monthlyUsd: 40, agentCap: 8, cadences: 'light', planNow: true,
      vision: { title: 'Be forwarded', description: 'A weekly letter.', dueAt: '2027-01-30T12:00:00.000Z', rules: 'No paid promotion.' },
      profile: { values: 'ship weekly', culture: 'terse, async' }, roles: ['role:marketer'],
    });
    const bare = buildBootstrapBody(initialWizardState({ mode: 'supervised', chief: { kind: 'existing', agentId: 'a1' }, budget: { monthlyUsd: '', agentCap: '' }, planNow: false }), now);
    expect(bare).toEqual({ mode: 'supervised', chief: { agentId: 'a1' }, monthlyUsd: 0, agentCap: 12, cadences: 'profile', planNow: false });
    expect('vision' in bare).toBe(false);
    expect(() => buildBootstrapBody(initialWizardState({ mode: 'none' }), now)).toThrow(/no company/);
  });
  it('summarises what will be created in order, naming the agent, the caps and the hire path', () => {
    const lines = buildSummary(full, { existing: false, caps: { maxDepth: 3, maxDirectReports: 5, defaultAgentCap: 12, rules: [], vetoWindowMinutes: 30 }, roleName: (id) => (id === 'marketer' ? 'Marketer' : undefined) });
    expect(lines.map((l) => l.label)).toEqual(['Workspace', 'Run as', 'Chief of staff', 'Vision', 'Standing rules', 'Values', 'Culture', 'Budget', 'Caps', 'Rhythm', 'First hires', 'Then']);
    expect(lines.find((l) => l.label === 'Chief of staff')!.value).toBe('Nova (new, anthropic)');
    expect(lines.find((l) => l.label === 'Vision')!.value).toBe('Be forwarded · 90 days');
    expect(lines.find((l) => l.label === 'Caps')!.value).toMatch(/veto window 30 min/);
    expect(lines.find((l) => l.label === 'First hires')!.value).toBe('Marketer (seated at once)');
    expect(lines.find((l) => l.label === 'Then')!.value).toMatch(/first planning session/);
    const plain = buildSummary(initialWizardState({ mode: 'none' }), { existing: true });
    expect(plain).toEqual([{ label: 'Run as', value: 'Just a workspace', step: 'mode' }]);
    const existing = buildSummary({ ...full, mode: 'supervised', chief: { kind: 'existing', agentId: 'a1' }, budget: { monthlyUsd: '0', agentCap: '3' } }, { existing: true, agentName: (id) => (id === 'a1' ? 'Atlas' : undefined) });
    expect(existing[0].label).toBe('Run as');
    expect(existing.find((l) => l.label === 'Chief of staff')!.value).toBe('Atlas (existing)');
    expect(existing.find((l) => l.label === 'Budget')!.value).toMatch(/no envelope/);
    expect(existing.find((l) => l.label === 'First hires')!.value).toMatch(/approval cards/);
    expect(existing.some((l) => l.label === 'Caps')).toBe(false);
  });
  it('says the chief is planning only when planning was queued, and counts the cards', () => {
    expect(successToast({ planning: 'queued', hires: [{ status: 'proposed' }, { status: 'skipped' }], chief: { name: 'Nova' } })).toBe('Company ready — Nova is planning; 1 hire card awaits you');
    expect(successToast({ planning: 'not_requested', hires: [], chief: { name: 'Nova' } })).toBe('Company ready — Nova is chief of staff');
    expect(successToast({ planning: 'unavailable', hires: [{ status: 'proposed' }, { status: 'proposed' }], chief: { name: 'Nova' } })).toMatch(/2 hire cards await you/);
  });
});
