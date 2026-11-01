/** Company onboarding helpers (execution plan item 25; docs/group-chat.md §5
 *  "Onboarding"): horizon → ISO, the steps per choice, validation, role
 *  ranking by the profile, the bootstrap body built only from what is on
 *  screen, the review summary, the toast and the tolerant role reader. */
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapBody, buildSummary, CADENCE_CARDS, horizonLabel, horizonToIso, initialWizardState, MODE_CARDS, rankRoles, successToast, validateAll, validateStep, wizardSteps,
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
    expect(CADENCE_CARDS.map((c) => c.mode)).toEqual(['default', 'light', 'none']);
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

describe('roles', () => {
  const roles: OrgRole[] = [
    { id: 'pro-marketing', name: 'Marketer', title: 'Marketing', summary: 'Create content, plan campaigns, track competitors.' },
    { id: 'pro-support', name: 'Support Desk', title: 'Support', summary: 'Answer customers, triage tickets.' },
    { id: 'pro-finance', name: 'Bookkeeper', title: 'Finance', summary: 'Invoices, ledgers, monthly close.' },
  ];
  it('ranks roles by overlap with the profile and vision text, keeps catalog order on ties and never drops a role', () => {
    const ranked = rankRoles(roles, 'A weekly newsletter: content and campaigns; never contact customers without approval.');
    expect(ranked.map((r) => r.id)).toEqual(['pro-marketing', 'pro-support', 'pro-finance']);
    expect(rankRoles(roles, 'invoices every month').map((r) => r.id)[0]).toBe('pro-finance');
    expect(rankRoles(roles, '')).toEqual(roles);
    expect(rankRoles(roles, 'zzz')).toEqual(roles);
  });
  it('reads the catalog in either shape and skips rows without an id or a name', () => {
    expect(normalizeRoles([{ id: 'a', name: 'A', tagline: 'does a' }, { packId: 'b', role: 'B' }, { id: 'c' }, null])).toEqual([
      { id: 'a', name: 'A', title: undefined, summary: 'does a' }, { id: 'b', name: 'B', title: 'B', summary: undefined },
    ]);
    expect(normalizeRoles({ roles: [{ id: 'x', name: 'X', description: 'd' }] })[0].summary).toBe('d');
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
    budget: { monthlyUsd: '40', agentCap: '8' }, cadences: 'light', roles: ['pro-marketing'], planNow: true,
  });
  it('builds the body only from what is on screen: trimmed, no empty optional fields, provider only when picked', () => {
    const body = buildBootstrapBody(full, now);
    expect(body).toEqual({
      mode: 'autonomous', chief: { create: { name: 'Nova', provider: 'anthropic' } }, monthlyUsd: 40, agentCap: 8, cadences: 'light', planNow: true,
      vision: { title: 'Be forwarded', description: 'A weekly letter.', dueAt: '2027-01-30T12:00:00.000Z', rules: 'No paid promotion.' },
      profile: { values: 'ship weekly', culture: 'terse, async' }, roles: ['pro-marketing'],
    });
    const bare = buildBootstrapBody(initialWizardState({ mode: 'supervised', chief: { kind: 'existing', agentId: 'a1' }, budget: { monthlyUsd: '', agentCap: '' }, planNow: false }), now);
    expect(bare).toEqual({ mode: 'supervised', chief: { agentId: 'a1' }, monthlyUsd: 0, agentCap: 12, cadences: 'default', planNow: false });
    expect('vision' in bare).toBe(false);
    expect(() => buildBootstrapBody(initialWizardState({ mode: 'none' }), now)).toThrow(/no company/);
  });
  it('summarises what will be created in order, naming the agent, the caps and the hire path', () => {
    const lines = buildSummary(full, { existing: false, caps: { maxDepth: 3, maxDirectReports: 5, defaultAgentCap: 12, rules: [], vetoWindowMinutes: 30 }, roleName: (id) => (id === 'pro-marketing' ? 'Marketer' : undefined) });
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
