/** The rest of the CEO's seat (docs/company-vision.md §6–§9; items 22–24):
 *  plan actions as a diff, the veto countdown, citation chips, the replay day,
 *  cost rows and the overspend flag, forecast states, routing tiers, the
 *  blueprint plan summary, the graph as grouped lists, lesson audiences. */
import { describe, expect, it } from 'vitest';
import {
  audienceLabel, blueprintFileName, blueprintPlanSummary, citationLabel, citationsToChips, classRows, costRows, countdownLabel, dayKey, forecastLine, forecastRows, groupGraph, groupPlanActions,
  groupReplayByHour, hiresByRole, humanizePlanAction, parseCitations, parsePlanActions, parsePlanResults, planGroupOf, planStoppedAt, planTriggerLabel, playbookOutcomeLine, playbookRoles,
  routingRows, shiftDay, tierModelLabel,
} from '../src/lib/org2';
import type { BlueprintImportPlan, CostReport, EnvelopeForecast, OrgGraph, ReplayEntry } from '../src/lib/api';

describe('plans as a diff (§8)', () => {
  const names = (id: string) => ({ a1: 'Scout', a2: 'Chief' }[id]);
  it('humanises each captured action from its tool and input and groups them in a fixed order', () => {
    expect(humanizePlanAction({ tool: 'org_hire', input: { name: 'Quill', title: 'Writer', templateOrPack: 'role:writer', reportsToAgentId: 'a2' }, summary: '' }, names)).toBe('Hire Quill as Writer from role:writer reporting to Chief');
    expect(humanizePlanAction({ tool: 'org_terminate', input: { agentId: 'a1', reason: 'idle' }, summary: '' }, names)).toBe('Terminate Scout — idle');
    expect(humanizePlanAction({ tool: 'org_reorg', input: { agentId: 'a1', reportsToAgentId: 'a2' }, summary: '' }, names)).toBe('Move Scout under Chief');
    expect(humanizePlanAction({ tool: 'org_widen_scope', input: { agentId: 'a1', scopes: ['tool:browser'] }, summary: '' }, names)).toBe('Widen Scout with tool:browser');
    expect(humanizePlanAction({ tool: 'org_allocate_budget', input: { objectiveId: 'obj12345678', monthlyUsd: 20, buys: 'KR1' }, summary: '' })).toBe('Allocate $20.00/month to objective obj12345 — KR1');
    expect(humanizePlanAction({ tool: 'org_raise_budget', input: { scope: 'company', monthlyUsd: 120 }, summary: '' })).toBe('Raise the company envelope to $120.00/month');
    expect(humanizePlanAction({ tool: 'org_set_routing', input: { class: 'review', tier: 'strong' }, summary: '' })).toBe('Route review → strong');
    expect(humanizePlanAction({ tool: 'org_tune', input: { key: 'planning.cooldownMinutes', value: 30 }, summary: '' })).toBe('Tune planning.cooldownMinutes → 30');
    expect(humanizePlanAction({ tool: 'org_hire', input: {}, summary: 'the runtime wrote this' })).toBe('the runtime wrote this');
    expect(planGroupOf('org_set_routing')).toBe('routing');
    expect(planGroupOf('something_else')).toBe('other');
    const groups = groupPlanActions([
      { tool: 'org_tune', input: { key: 'k', value: 1 }, estimateUsd: 0, summary: '' },
      { tool: 'org_hire', input: { name: 'Quill' }, estimateUsd: 25, summary: '' },
      { tool: 'org_hire', input: { name: 'Ink' }, estimateUsd: 15, summary: '' },
    ], [{ tool: 'org_tune', summary: '', ok: true, output: '' }, { tool: 'org_hire', summary: '', ok: false, output: 'agent cap reached' }]);
    expect(groups.map((g) => g.group)).toEqual(['hire', 'tune']);
    expect(groups[0].estimateUsd).toBe(40);
    expect(groups[0].rows[0].result).toMatchObject({ ok: false, output: 'agent cap reached' });
    expect(groups[0].rows[1].result).toBeNull();
    expect(planStoppedAt(parsePlanResults('[{"tool":"a","ok":true},{"tool":"b","ok":false,"output":"no"}]'))).toBe(1);
    expect(planStoppedAt([])).toBeNull();
    expect(parsePlanActions('not json')).toEqual([]);
    expect(parsePlanActions('[{"tool":"org_hire","input":{"name":"Q"},"estimateUsd":"3"},{"nope":1}]')).toEqual([{ tool: 'org_hire', input: { name: 'Q' }, estimateUsd: 3, summary: '' }]);
  });
  it('counts down the veto window and names the trigger', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(countdownLabel('2026-11-01T12:12:00Z', now)).toBe('applies in 12m');
    expect(countdownLabel('2026-11-01T13:05:00Z', now)).toBe('applies in 1h 05m');
    expect(countdownLabel('2026-11-01T14:00:00Z', now)).toBe('applies in 2h');
    expect(countdownLabel('2026-11-01T11:59:00Z', now)).toBe('applying now');
    expect(countdownLabel(null, now)).toBe('no window');
    expect(planTriggerLabel('at_risk')).toBe('a key result went at risk');
    expect(planTriggerLabel('weird_thing')).toBe('weird thing');
  });
});

describe('citations (§6)', () => {
  it('finds every [kind:id] once, turns them into chips and labels them from the verified list', () => {
    const text = 'We dropped it [decision:d1234567] after [task:t1] stalled; see [decision:d1234567] and [audit:42].';
    expect(parseCitations(text)).toEqual([{ kind: 'decision', id: 'd1234567' }, { kind: 'task', id: 't1' }, { kind: 'audit', id: '42' }]);
    expect(citationsToChips(text)).toBe('We dropped it #decision:d1234567 after #task:t1 stalled; see #decision:d1234567 and #audit:42.');
    const cits = [{ kind: 'decision' as const, id: 'd1234567-full', title: 'Drop onboarding objective because the team shrank and the metric moved' }];
    expect(citationLabel('decision', 'd1234567', cits)).toBe('Drop onboarding objective because the team shra…');
    expect(citationLabel('task', 't1abcdefgh', [])).toBe('task t1abcdef');
    expect(citationLabel('audit', '42', [])).toBe('audit #42');
  });
});

describe('replay (§8)', () => {
  it('groups a day by local hour, earliest first, with the hour spend summed', () => {
    const e = (at: string, kind: ReplayEntry['kind'], usd: number | null, seq: number | null = null): ReplayEntry => ({ at, kind, seq, title: kind, usd, refType: 'task', refId: 't' });
    const d = (h: number, m: number) => new Date(2026, 10, 1, h, m).toISOString();
    const groups = groupReplayByHour([e(d(9, 30), 'ran', 0.4, 2), e(d(8, 5), 'woke', null, 1), e(d(9, 1), 'decided', null, 3), e(d(9, 45), 'spend', 0.1)]);
    expect(groups.map((g) => g.hour)).toEqual(['08:00', '09:00']);
    expect(groups[1].rows.map((r) => r.kind)).toEqual(['decided', 'ran', 'spend']);
    expect(groups[1].usd).toBeCloseTo(0.5);
    expect(dayKey(new Date(2026, 0, 9))).toBe('2026-01-09');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('costs and forecast (§7)', () => {
  const obj = (over: Partial<CostReport['objectives'][number]>): CostReport['objectives'][number] => ({
    goalId: 'g', title: 'Objective', status: 'active', unitId: null, spentUsd: 10, runs: 3, shareOfSpend: 0.5, envelopeUsd: 20, envelopeSource: 'allocation', envelopePct: 50, progress: 0.4,
    keyResults: { total: 2, achieved: 0, measuredPct: 35 }, allocation: { monthlyUsd: 20, buys: 'KR1, KR2' }, overspend: false, byClass: {}, ...over,
  });
  it('builds the cost-per-outcome rows, flags overspend first and explains it', () => {
    const rows = costRows({ margin: 0.2, objectives: [obj({ goalId: 'a', spentUsd: 4 }), obj({ goalId: 'b', spentUsd: 30, shareOfSpend: 0.8, progress: 0.1, overspend: true, envelopePct: 150 })] });
    expect(rows.map((r) => r.goalId)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ overspend: true, color: 'var(--red)', sharePct: 80, progressPct: 10, envelopePct: 150, note: '80% of spend for 10% progress — more than the 20-point margin allows' });
    expect(rows[1]).toMatchObject({ overspend: false, color: 'var(--green)', measuredPct: 35, buys: 'KR1, KR2', note: 'in proportion' });
    expect(costRows({ margin: 0.2, objectives: [obj({ envelopePct: 85 })] })[0]).toMatchObject({ color: 'var(--amber)', note: 'near its envelope' });
    expect(costRows({ margin: 0.2, objectives: [obj({ envelopePct: null, envelopeSource: 'none', keyResults: { total: 0, achieved: 0, measuredPct: null } })] })[0]).toMatchObject({ envelopePct: null, measuredPct: null });
    expect(classRows({ review: 3, triage: 1 })).toEqual([{ cls: 'review', usd: 3, pct: 75 }, { cls: 'triage', usd: 1, pct: 25 }]);
    expect(classRows({})).toEqual([]);
  });
  it('labels forecast states and sorts the envelopes worst first', () => {
    const f = (name: string, state: EnvelopeForecast['state'], projectedPct: number | null, capUsd = 50): EnvelopeForecast => ({ scope: 'agent', refId: name, name, capUsd, spentUsd: 12.4, dailyBurnUsd: 1.2, projectedUsd: 36, projectedPct, state });
    expect(forecastLine(f('Scout', 'onTrack', 72))).toBe('on track · $36.00 of $50.00 projected (72%) · $1.20/day');
    expect(forecastLine(f('Scout', 'stop', null, 0))).toBe('will stop · $36.00 (no cap) projected · $1.20/day');
    const rows = forecastRows({ company: f('Company', 'onTrack', 40), agents: [f('A', 'stop', 130), f('B', 'warn', 90)], projects: [f('P', 'warn', 95)], objectives: [] });
    expect(rows.map((r) => r.name)).toEqual(['A', 'P', 'B', 'Company']);
  });
});

describe('routing (§7)', () => {
  it('resolves a tier to the pinned model, the agent\'s own model or the provider\'s strong model', () => {
    const routing = { classes: { review: 'strong' as const, triage: 'cheap' as const }, models: { strong: 'claude-opus-4-5-pinned' } };
    const agent = { provider: 'openai', model: 'gpt-5-mini' };
    expect(tierModelLabel(routing, 'strong', agent)).toEqual({ model: 'claude-opus-4-5-pinned', pinned: true });
    expect(tierModelLabel(routing, 'standard', agent)).toEqual({ model: 'gpt-5-mini', pinned: false });
    expect(tierModelLabel({ classes: {}, models: {} }, 'strong', agent)).toEqual({ model: 'gpt-5.1', pinned: false });
    expect(tierModelLabel({ classes: {}, models: {} }, 'cheap', agent)).toEqual({ model: 'cheapest openai model', pinned: false });
    expect(tierModelLabel({ classes: {}, models: {} }, 'strong', null).model).toBe("the provider's strong model");
    const rows = routingRows({ ...routing, classes: { ...routing.classes, custom: 'standard' } }, ['triage', 'research', 'review']);
    expect(rows).toEqual([{ cls: 'triage', tier: 'cheap' }, { cls: 'research', tier: null }, { cls: 'review', tier: 'strong' }, { cls: 'custom', tier: 'standard' }]);
  });
});

describe('blueprints (§9)', () => {
  const plan: BlueprintImportPlan = {
    ok: true, name: 'Newsroom', mode: 'supervised', chief: { title: 'Chief of staff', scopes: ['tool:fs_read'], dropped: ['tool:shell'], modelTier: 'standard', model: 'm' },
    hires: [
      { title: 'Writer', roleId: 'writer', reportsTo: 'Chief of staff', requestedScopes: ['tool:fs_write'], scopes: ['tool:fs_write'], dropped: [], modelTier: 'standard', model: 'm', monthlyUsd: 20 },
      { title: 'Writer', roleId: 'writer', reportsTo: 'Chief of staff', requestedScopes: [], scopes: [], dropped: ['tool:browser'], modelTier: 'standard', model: 'm', monthlyUsd: 20 },
      { title: 'Fact checker', reportsTo: 'Chief of staff', requestedScopes: [], scopes: [], dropped: [], modelTier: 'strong', model: 'm', monthlyUsd: 30 },
    ],
    units: [{ title: 'Editorial', parent: null }], budget: { monthlyUsd: 120, allocations: { 'Grow readership': 60 }, allocated: 60 }, tunables: [{ key: 'k', value: 1, applied: 1 }],
    profile: { values: true, culture: false, rules: true }, vision: { title: 'Trusted local news', horizonDays: 180 }, playbooks: [{ name: 'org-fact-check' }], cadences: { count: 2, applied: false, note: 'listed' },
    recommendedCards: [], recommendedConnections: ['google-gmail'], approval: 'blueprint', notes: [],
  };
  it('summarises the plan in one paragraph and groups hires by role', () => {
    expect(blueprintPlanSummary(plan)).toBe('3 hires under a Chief of staff, 1 unit, $120.00/month ($60.00 allocated to objectives), 1 playbook as drafts, 1 tunable, the vision "Trusted local news". 2 requested scopes dropped (outside what the chief holds). The hires wait on one approval card.');
    expect(blueprintPlanSummary({ ...plan, hires: [plan.hires[2]], chief: { ...plan.chief, dropped: [] }, approval: 'none', units: [], playbooks: [], tunables: [], vision: null, budget: { monthlyUsd: 0, allocations: {}, allocated: 0 } })).toBe('1 hire under a Chief of staff, $0.00/month. The hires are made at once.');
    expect(hiresByRole(plan.hires).map((g) => [g.role, g.rows.length])).toEqual([['writer', 2], ['Fact checker', 1]]);
    expect(blueprintFileName('The Newsroom, Inc.')).toBe('the-newsroom-inc.COMPANY.json');
    expect(blueprintFileName('')).toBe('company.COMPANY.json');
  });
});

describe('the graph as lists (§6)', () => {
  it('groups neighbours by kind with their relation and hop count, root left out', () => {
    const g: OrgGraph = {
      root: 'task:t1', depth: 2, truncated: false,
      nodes: [
        { key: 'task:t1', kind: 'task', id: 't1', title: 'Write the brief' },
        { key: 'goal:g1', kind: 'goal', id: 'g1', title: 'Launch', status: 'active' },
        { key: 'decision:d1', kind: 'decision', id: 'd1', title: 'Ship in March' },
        { key: 'meeting:m1', kind: 'meeting', id: 'm1', title: 'Weekly review' },
        { key: 'agent:a1', kind: 'agent', id: 'a1', title: 'Scout' },
      ],
      edges: [{ from: 'task:t1', to: 'goal:g1', rel: 'serves' }, { from: 'decision:d1', to: 'task:t1', rel: 'about' }, { from: 'meeting:m1', to: 'decision:d1', rel: 'decided_in' }, { from: 'agent:a1', to: 'task:t1', rel: 'owns' }],
    };
    const groups = groupGraph(g);
    expect(groups.map((x) => x.label)).toEqual(['Goals', 'Decisions', 'Meetings', 'Members']);
    expect(groups[0].rows[0]).toMatchObject({ id: 'g1', rel: 'serves', hops: 1 });
    expect(groups[2].rows[0]).toMatchObject({ id: 'm1', rel: 'decided_in', hops: 2 });
    expect(groupGraph({ root: 'task:x', depth: 1, nodes: [{ key: 'task:x', kind: 'task', id: 'x', title: 'alone' }], edges: [], truncated: false })).toEqual([]);
  });
});

describe('lessons and playbooks (§6)', () => {
  it('labels lesson audiences and reads playbook outcomes and roles', () => {
    expect(audienceLabel('member')).toBe('for the member');
    expect(audienceLabel('unit')).toBe('for the unit');
    expect(audienceLabel('company')).toBe('for everyone');
    expect(audienceLabel('odd')).toBe('odd');
    expect(playbookOutcomeLine('{"uses":3,"up":2,"down":1,"successRate":0.667}')).toBe('3 uses · 67% success');
    expect(playbookOutcomeLine('{"uses":1}')).toBe('1 use');
    expect(playbookOutcomeLine('{}')).toBe('not used yet');
    expect(playbookOutcomeLine('bad')).toBe('not used yet');
    expect(playbookRoles('["Writer","Editor"]')).toEqual(['Writer', 'Editor']);
    expect(playbookRoles('[]')).toEqual(['everyone']);
    expect(playbookRoles(null)).toEqual(['everyone']);
  });
});
