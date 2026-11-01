/** The SPA of items 27–30 (item 32, part one): provenance, the selector
 *  tester, check summaries and the check builder, the verification badge,
 *  the trust grid and legend, action decisions and held reasons, incident
 *  timelines and containment, the health strip, experiments, calibration,
 *  reconciliation and the optional decision-card fields. */
import { describe, expect, it } from 'vitest';
import {
  actionCallText, actionDecisionLabel, auditorQuality, baselineVsCurrent, buildCheck, calibrationLabel, checkSummary, containedNow, containmentLabel, decisionExtras, degradedChatNote, describeCheck,
  effectLabel, experimentGroup, experimentHints, experimentProgress, groupGaps, headerError, healthStrip, heldReason, incidentTimeline, keyButtonLabel, LEVEL_LEGEND, normalizeSeries,
  pendingSpotChecks, provenanceLabel, revertRuleLabel, sortIncidents, testSelector, trustRows, verdictText, verificationBadge, lastRedTeam,
} from '../src/lib/org3';
import type { ActionLogRow, OrgAuditRun, OrgExperiment, OrgHealth, OrgIncident, TaskCheckResult, TrustOverview } from '../src/lib/api';

const action = (over: Partial<ActionLogRow>): ActionLogRow => ({
  id: 'act-1', key: 'k', workspaceId: 'w', agentId: 'a1', sessionId: 's', orgId: null, tool: 'gmail_send', class: 'external_irreversible', channel: 'gmail', inputHash: '', input: '{"to":"x@y.z","subject":"Hi"}',
  status: 'succeeded', decision: 'run', level: 1, keys: '{}', stagedRef: '', result: '', resultHash: '', dedupeCount: 0, revertedAt: null, note: '', createdAt: '2026-11-02T10:00:00Z', finishedAt: null, ...over,
});
const incident = (over: Partial<OrgIncident>): OrgIncident => ({
  id: 'inc-1', orgId: 'o', workspaceId: 'w', kind: 'breaker', severity: 'major', status: 'open', title: 'Loop', detail: 'same call 3×', agentId: 'a1', actionClass: null, refType: 'task', refId: 't1',
  detectedBy: 'system', containment: [], postmortemMeetingId: null, openedAt: '2026-11-02T10:00:00Z', containedAt: null, resolvedAt: null, resolution: '', ...over,
});
const audit = (over: Partial<OrgAuditRun>): OrgAuditRun => ({
  id: 'au1', orgId: 'o', auditorAgentId: 'aud', trigger: 'cadence', startedAt: '2026-11-02T10:00:00Z', endedAt: null, sampled: '{}', findings: '[]', summary: '', singleModel: 0, model: '', usd: 0, status: 'done', createdAt: '2026-11-02T10:00:00Z', ...over,
});

describe('sensing (item 27)', () => {
  it('labels provenance by kind, with the response hash', () => {
    expect(provenanceLabel('{"kind":"http_json","url":"https://x.io/s","status":200,"responseHash":"abcdef0123456789"}')).toBe('GET https://x.io/s → 200 · sha abcdef0123');
    expect(provenanceLabel({ kind: 'webhook', responseHash: '1234567890ab' })).toBe('posted to the webhook · sha 1234567890');
    expect(provenanceLabel({ kind: 'connection', query: 'gmail_unread', service: 'gmail' })).toBe('gmail_unread over gmail connection');
    expect(provenanceLabel({ kind: 'manual_attested', by: 'user', note: 'from Stripe' })).toBe('attested by the owner — "from Stripe"');
    expect(provenanceLabel('not json')).toBe('no provenance recorded');
  });

  it('tests a selector against a pasted response like the poll would', () => {
    const doc = JSON.stringify({ stats: { subscribers: '450' }, items: [{ amount: 2 }, { amount: 3, meta: { amount: 1 } }], flag: true, ['odd.key']: { x: 7 } });
    expect(testSelector(doc, 'stats.subscribers')).toEqual({ ok: true, value: 450 });
    expect(testSelector(doc, '$.items.length')).toEqual({ ok: true, value: 2 });
    expect(testSelector(doc, 'items.sum(amount)')).toEqual({ ok: true, value: 5 });
    expect(testSelector(doc, 'items.count(meta)')).toEqual({ ok: true, value: 1 });
    expect(testSelector(doc, 'flag')).toEqual({ ok: true, value: 1 });
    expect(testSelector(doc, '["odd.key"].x')).toEqual({ ok: true, value: 7 });
    expect(testSelector(doc, 'items[0]')).toMatchObject({ ok: false });
    expect(testSelector(doc, 'items.max(amount)')).toMatchObject({ ok: false, error: expect.stringContaining('not supported') });
    expect(testSelector('{oops', 'a')).toEqual({ ok: false, error: 'the sample is not valid JSON' });
  });

  it('refuses a credential header that is not a secret reference', () => {
    expect(headerError('Authorization', 'Bearer abc123')).toMatch(/credential/);
    expect(headerError('Authorization', 'Bearer {{secret:API}}')).toBeNull();
    expect(headerError('X-Api-Key', '{{secret:KEY}}')).toBeNull();
    expect(headerError('Accept', 'application/json')).toBeNull();
    expect(headerError('bad name', 'x')).toMatch(/not valid/);
  });

  it('summarises check results into the outcome review would see', () => {
    const r = (status: TaskCheckResult['status']): TaskCheckResult => ({ index: 0, check: { kind: 'file_exists', path: 'a.md' }, status, detail: '', evidence: {} });
    expect(checkSummary([]).outcome).toBe('none');
    expect(checkSummary([r('pass'), r('pass')])).toMatchObject({ outcome: 'pass', label: '2/2 pass — accepted by check at review' });
    expect(checkSummary([r('pass'), r('fail'), r('error')]).outcome).toBe('fail');
    expect(checkSummary([r('pass'), r('error')]).label).toBe('1/2 pass · 1 could not run — falls back to a model review');
    expect(checkSummary([r('pending')]).outcome).toBe('pending');
    expect(describeCheck({ kind: 'metric_at_least', sourceId: 'src12345678', value: 10 }, (id) => (id === 'src12345678' ? 'Subscribers' : undefined))).toBe('Subscribers ≥ 10');
    expect(describeCheck({ kind: 'connection_query', service: 'gmail_unread', query: 'from:x', days: 7, atLeast: 2 })).toBe('gmail_unread "from:x" counts ≥ 2');
  });

  it('builds checks from the builder fields and names what is missing', () => {
    expect(buildCheck('metric_at_least', { sourceId: 's1', value: '10' })).toEqual({ kind: 'metric_at_least', sourceId: 's1', value: 10 });
    expect(buildCheck('metric_at_least', { sourceId: '', value: '10' })).toBe('a source is required');
    expect(buildCheck('http_json_match', { url: 'https://x.io', selector: 'a.b', atLeast: '3' })).toEqual({ kind: 'http_json_match', url: 'https://x.io', selector: 'a.b', atLeast: 3 });
    expect(buildCheck('http_json_match', { url: 'https://x.io', selector: 'a.b' })).toBe('give equals, contains or at least');
    expect(buildCheck('file_exists', { path: '../etc/passwd' })).toMatch(/no \.\./);
    expect(buildCheck('file_matches', { path: 'out/report.json', jsonSchemaKeys: 'a, b.c' })).toEqual({ kind: 'file_matches', path: 'out/report.json', jsonSchemaKeys: ['a', 'b.c'] });
    expect(buildCheck('connection_query', { service: 'drive_changed', atLeast: '1', days: '120' })).toBe('days must be 1–90');
    expect(buildCheck('metric_increased', { sourceId: 's', by: '5', sinceTaskStart: false })).toEqual({ kind: 'metric_increased', sourceId: 's', by: 5, sinceTaskStart: false });
  });

  it('badges how a done task was verified, and scales a sparkline', () => {
    expect(verificationBadge('check')?.label).toBe('✓ by check');
    expect(verificationBadge('review')?.label).toBe('by review');
    expect(verificationBadge('none')?.label).toBe('unverified');
    expect(verificationBadge(null)).toBeNull();
    expect(normalizeSeries([10, 20, 15])).toEqual([0, 100, 50]);
    expect(normalizeSeries([3, 3])).toEqual([50, 50]);
  });
});

describe('actions and trust (item 28)', () => {
  const overview: TrustOverview = {
    workspaceId: 'w', orgMode: 'supervised', ceilings: { read: 3, internal_write: 3, external_reversible: 2, external_irreversible: 1, money: 0 }, matrix: [],
    agents: [{ agentId: 'a1', name: 'Writer', classes: [
      { actionClass: 'read', level: 3, ceiling: 3, effective: 3, cleanCount: 0, rejectStreak: 0, lastIncidentAt: null, lastChangedAt: null, reason: '', counts: {} },
      { actionClass: 'external_reversible', level: 2, ceiling: 2, effective: 1, cleanCount: 4, rejectStreak: 0, lastIncidentAt: '2026-11-01T09:00:00Z', lastChangedAt: null, reason: 'promoted', counts: { success: 4 } },
    ] }],
  };
  it('builds the agents × classes grid with the effective cap and the last incident; the legend has four levels', () => {
    const rows = trustRows(overview);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map((c) => c.cls)).toEqual(['internal_write', 'external_reversible', 'external_irreversible', 'money']);
    const ext = rows[0].cells[1];
    expect(ext).toMatchObject({ level: 2, ceiling: 2, effective: 1, capped: true, clean: 4 });
    expect(ext.title).toContain('effective 1');
    expect(rows[0].lastIncidentAt).toBe('2026-11-01T09:00:00Z');
    expect(trustRows(overview, { withRead: true })[0].cells).toHaveLength(5);
    expect(LEVEL_LEGEND.map((l) => l.level)).toEqual([0, 1, 2, 3]);
  });

  it('labels how each action was decided', () => {
    expect(actionDecisionLabel(action({})).label).toBe('acted');
    expect(actionDecisionLabel(action({ decision: 'run_notify' })).label).toBe('acted, you heard after');
    expect(actionDecisionLabel(action({ status: 'held', decision: 'hold' })).label).toBe('held');
    expect(actionDecisionLabel(action({ status: 'held', decision: 'frozen' })).label).toBe('frozen');
    expect(actionDecisionLabel(action({ status: 'staged', decision: 'stage' })).label).toBe('staged');
    expect(actionDecisionLabel(action({ decision: 'cosign', keys: '{"agent":{"verdict":"approve"}}' })).label).toBe('co-signed');
    expect(actionDecisionLabel(action({ dedupeCount: 2 })).label).toBe('deduplicated');
    expect(actionDecisionLabel(action({ status: 'denied' })).label).toBe('denied');
  });

  it('says why an action is held and exactly what the key will run', () => {
    expect(heldReason(action({ status: 'held', decision: 'frozen' }))).toMatch(/incident froze external, irreversible/);
    expect(heldReason(action({ status: 'held', decision: 'cosign→hold', keys: '{"singleFamily":true}' }))).toMatch(/Two-key rule/);
    expect(heldReason(action({ status: 'held', decision: 'hold', level: 0, keys: '{"why":"nobody is at the keyboard"}' }))).toBe('Held: external, irreversible at trust level 0 — nobody is at the keyboard.');
    expect(actionCallText(action({}))).toBe('gmail_send({\n  "to": "x@y.z",\n  "subject": "Hi"\n})');
    expect(keyButtonLabel(action({ status: 'staged' }))).toBe('Send the draft (my key)');
    expect(keyButtonLabel(action({ status: 'held', tool: 'http_request' }))).toBe('Approve — run http_request (my key)');
  });
});

describe('incidents and health (item 29)', () => {
  it('orders the timeline detection → containment → postmortem → resolution and words containment', () => {
    const i = incident({
      status: 'resolved', containedAt: '2026-11-02T10:00:01Z', postmortemMeetingId: 'm1', resolvedAt: '2026-11-02T12:00:00Z', resolution: 'fixed the prompt',
      containment: [
        { action: 'pause_member', at: '2026-11-02T10:00:01Z', result: 'paused Writer', reversible: true, undone: true, data: { agentId: 'a1', name: 'Writer' } },
        { action: 'note', at: '2026-11-02T10:00:00Z', result: 'signal opened', reversible: false },
        { action: 'freeze_class', at: '2026-11-02T10:00:01Z', result: 'froze', reversible: true, data: { actionClass: 'external_irreversible' } },
      ],
    });
    const t = incidentTimeline(i);
    expect(t.map((e) => e.kind)).toEqual(['detected', 'contain', 'contain', 'contain', 'contained', 'postmortem', 'resolved']);
    expect(t[2].text).toBe('Paused Writer — undone');
    expect(t[3].text).toBe('Froze external, irreversible actions');
    expect(containmentLabel({ action: 'pause_member', at: '', result: 'not paused: Chief is the chief of staff (the CEO decides)', reversible: false })).toBe('Not paused: Chief is the chief of staff (the CEO decides)');
    expect(containedNow(i).map((s) => s.action)).toEqual(['freeze_class']);
  });

  it('sorts incidents open-first by severity, then resolved newest first', () => {
    const { open, resolved } = sortIncidents([
      incident({ id: 'a', severity: 'minor' }), incident({ id: 'b', severity: 'critical' }), incident({ id: 'c', status: 'resolved', resolvedAt: '2026-11-01T00:00:00Z' }),
      incident({ id: 'd', status: 'resolved', resolvedAt: '2026-11-02T00:00:00Z' }), incident({ id: 'e', severity: 'major', status: 'contained' }),
    ]);
    expect(open.map((i) => i.id)).toEqual(['b', 'e', 'a']);
    expect(resolved.map((i) => i.id)).toEqual(['d', 'c']);
  });

  it('writes the health strip and the degraded chat note', () => {
    const h: OrgHealth = {
      status: 'degraded', orgStatus: 'active', mode: 'supervised', lines: [], openIncidents: [],
      providers: [{ provider: 'anthropic', state: 'degraded', since: '2026-11-02T14:02:00Z', until: '2026-11-02T14:12:00Z', failures: 3, lastError: '529' }],
      connections: [{ connectionId: 'c', provider: 'google', accountEmail: 'me@x.io', reason: 'refresh 400', since: '2026-11-02T13:00:00Z' }],
      frozenClasses: ['external_irreversible'], pausedByIncident: [{ agentId: 'a1', name: 'Writer', incidentId: 'i' }],
    };
    expect(healthStrip(h).map((x) => x.text)).toEqual([
      'anthropic degraded since 14:02 UTC · retry 14:12 UTC', 'google connection me@x.io degraded since 13:00 UTC', 'external, irreversible frozen', 'Writer paused by an incident',
    ]);
    expect(healthStrip(null)).toEqual([]);
    expect(degradedChatNote('{"from":"anthropic:claude-x","to":"openai:gpt-y"}', null, 'anthropic')).toBe('running on gpt-y — anthropic degraded');
    expect(degradedChatNote(null, h, 'anthropic-compatible')).toBe('anthropic degraded — the next turn runs on a fallback model');
    expect(degradedChatNote(null, h, 'openai')).toBeNull();
  });

  it('reads auditor quality, pending spot checks and the last red-team run', () => {
    const audits = [
      audit({ id: 'rt', trigger: 'redteam', findings: '[{"kind":"redteam_breach"}]', summary: 'breached' }),
      audit({ id: 'a2', noRotation: 1, spotChecks: '[{"itemId":"i1","kind":"finding","refType":"task","refId":"t","title":"x","agree":null,"note":"","answeredAt":null}]' }),
      audit({ id: 'a1', precision: 1, recall: 0.5 }),
    ];
    const q = auditorQuality(audits);
    expect(q).toMatchObject({ precision: 1, recall: 0.5, noRotation: true });
    expect(q.text).toBe('precision 100%, recall 50% from your spot checks');
    expect(pendingSpotChecks(audits).map((c) => `${c.auditId}:${c.itemId}`)).toEqual(['a2:i1']);
    expect(lastRedTeam(audits)).toMatchObject({ breach: true, summary: 'breached' });
    expect(lastRedTeam([audit({})])).toBeNull();
  });
});

describe('experiments, calibration, reconciliation (item 30)', () => {
  const exp = (over: Partial<OrgExperiment>): OrgExperiment => ({
    id: 'e', orgId: 'o', unitId: null, title: 'T', hypothesis: 'H', changeKind: 'tunable', change: { key: 'k', value: 2 }, metricSourceId: 's', direction: 'up', expectedEffect: 0.2, effectKind: 'relative', windowDays: 14,
    design: 'before_after', slice: {}, baseline: { mean: 100, n: 10 }, result: {}, status: 'running', revertRule: { worseBy: 0.1, relative: true }, extensions: 0, proposedBy: 'user', approvalId: null, changeApprovalId: null,
    startedAt: '2026-11-01T00:00:00Z', endsAt: '2026-11-15T00:00:00Z', lastCheckAt: null, decidedAt: null, decisionId: null, createdAt: '2026-11-01T00:00:00Z', ...over,
  });
  it('shows progress through the window and the verdict sentence', () => {
    expect(experimentProgress(exp({}), new Date('2026-11-04T12:00:00Z'))).toMatchObject({ label: 'day 4 of 14' });
    expect(experimentProgress(exp({}), new Date('2026-11-20T00:00:00Z')).label).toBe('window over — verdict due');
    expect(experimentProgress(exp({ startedAt: null, endsAt: null, status: 'proposed' })).label).toBe('14-day window, not started');
    expect(effectLabel(exp({}))).toBe('+20% (up is better)');
    expect(revertRuleLabel({ worseBy: 0.1, relative: true })).toBe('reverts at once if 10% worse than the baseline');
    expect(baselineVsCurrent(exp({ result: { mean: 112, n: 12 } }))).toBe('baseline 100 (n 10) → now 112 (n 12)');
    expect(verdictText(exp({}))).toBeNull();
    expect(verdictText(exp({ status: 'kept', result: { verdict: 'improved', relative: 0.12, threshold: 4, met: false } }))).toBe('Improved: +12% (noise ±4), below the expected effect — kept');
    expect(experimentGroup('extended')).toBe('running');
    expect(experimentGroup('abandoned')).toBe('decided');
    expect(experimentHints({ title: 'x', hypothesis: 'y', changeKind: 'tunable', change: { key: 'experiments.windowDays', value: 3 }, expectedEffect: 0.1, metric: 's', windowDays: 2 }))
      .toEqual(['a window of 3–90 days', 'a tunable outside experiments.*']);
  });

  it('labels calibration against the trust bar with bias', () => {
    const row = { agentId: 'a', name: 'W', resolved: 6, open: 1, brier: 0.2, calibration: 0.62, bias: 0.2, biasLabel: 'over' as const };
    expect(calibrationLabel(row)).toEqual({ text: '62% — below the 70% bar: discount its estimates; promotion waits', below: true, bias: 'over-forecasts' });
    expect(calibrationLabel({ ...row, calibration: 0.9, biasLabel: 'balanced' }).below).toBe(false);
    expect(calibrationLabel({ ...row, calibration: null, biasLabel: null })).toEqual({ text: 'not scored yet (6 resolved)', below: null, bias: '—' });
  });

  it('groups reconciliation gaps with deep links, and renders optional decision-card fields', () => {
    const groups = groupGaps([
      { kind: 'report_drift', refType: 'org', refId: 'o', title: 'spend', detail: '' },
      { kind: 'overclaim', refType: 'goal', refId: 'g1', title: 'KR', detail: '' },
      { kind: 'claim_mismatch', refType: 'task', refId: 't1', title: 'Task', detail: '' },
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['claim_mismatch', 'overclaim', 'report_drift']);
    expect(groups[0].gaps[0].link).toEqual({ kind: 'task', id: 't1' });
    expect(groups[1].gaps[0].link).toEqual({ kind: 'goal', id: 'g1' });
    expect(groups[2].gaps[0].link).toBeNull();
    expect(decisionExtras({ recommendation: 'Approve', confidence: 0.8, deadline: '2026-11-05T09:00:00Z', alternatives: [{ title: 'Wait' }, 'Hire'], other: 1 }, [], new Date('2026-11-05T06:00:00Z'))).toEqual([
      { key: 'recommendation', label: 'Recommendation', value: 'Approve' }, { key: 'alternatives', label: 'Alternatives', value: 'Wait · Hire' },
      { key: 'confidence', label: 'Confidence', value: '80%' }, { key: 'deadline', label: 'Decide by', value: '2026-11-05 09:00 UTC (in 3h 0m)', tone: 'amber' },
    ]);
    expect(decisionExtras({ card: { defaultAction: 'reject' } })).toEqual([{ key: 'defaultAction', label: 'If you do not answer', value: 'reject' }]);
    expect(decisionExtras({ recommendation: 'x' }, ['recommendation'])).toEqual([]);
  });
});

describe('experiment changes in words', () => {
  it('reads a stored { apply, revert } change and a bare draft alike', async () => {
    const { changeSummary } = await import('../src/lib/org3');
    expect(changeSummary('tunable', { apply: { key: 'planning.cooldownMinutes', value: 30 }, revert: { key: 'planning.cooldownMinutes', value: 60 } })).toBe('tune planning.cooldownMinutes → 30');
    expect(changeSummary('routing', { class: 'review', tier: 'strong' })).toBe('route review → strong');
    expect(changeSummary('playbook', { apply: { playbookId: 'p1', title: 'Launch', action: 'retire' } })).toBe('retire playbook Launch');
    expect(changeSummary('cadence', { apply: { unitId: 'u', kind: 'standup', cron: null } })).toBe('standup cadence of u → off');
    expect(changeSummary('other', { description: 'new onboarding email' })).toBe('new onboarding email');
  });
});

describe('item 31 on screen', () => {
  it('renders the decision card from the approval row: JSON alternatives, countdown, the default with its time', async () => {
    const { decisionExtras, countdown, decidedViaBadge } = await import('../src/lib/org3');
    const now = new Date('2026-11-02T10:00:00Z');
    const rows = decisionExtras({ recommendedAction: 'approve', alternatives: '["wait a week","hire cheaper"]', reversibility: 'irreversible', confidence: 0.6, deadline: '2026-11-02T08:00:00Z', defaultAction: 'deny' }, [], now);
    expect(rows.map((r) => [r.key, r.value, r.tone])).toEqual([
      ['recommendedAction', 'approve', undefined], ['alternatives', 'wait a week · hire cheaper', undefined], ['reversibility', 'irreversible', 'red'],
      ['confidence', '60%', undefined], ['deadline', '2026-11-02 08:00 UTC (2h 0m overdue)', 'red'], ['defaultAction', 'deny at 2026-11-02 08:00 UTC', undefined],
    ]);
    expect(decisionExtras({ alternatives: '[]', defaultAction: '' })).toEqual([]);
    expect(countdown('2026-11-05T12:00:00Z', now)?.text).toBe('in 3d 2h');
    expect(countdown('2026-11-02T10:30:00Z', now)).toEqual({ text: 'in 30m', overdue: false, soon: true });
    expect(decidedViaBadge('default')?.label).toBe('decided by default');
    expect(decidedViaBadge('delegate:human:acc1', () => 'Dana')?.label).toBe('decided by delegate Dana');
    expect(decidedViaBadge('delegate:role:controller')?.label).toBe('decided by delegate (controller)');
    expect(decidedViaBadge('')).toBeNull();
  });

  it('offers delegable kinds and names why some never are', async () => {
    const { delegationOptions } = await import('../src/lib/org3');
    const rules = [
      { kind: 'tunable', match: 'actions.*, trust.*, seat.*', verdict: 'propose', reason: 'the external-action floor', delegable: false },
      { kind: 'tunable', match: 'incidents.*', verdict: 'propose', reason: 'safety floors', delegable: true },
      { kind: 'budget', match: 'the company envelope', verdict: 'propose', reason: 'money beyond the envelope', delegable: false },
    ];
    const opts = delegationOptions(rules);
    expect(opts.find((o) => o.kind === 'metric_source')).toMatchObject({ disabled: true, note: 'a metric source defines what counts as truth' });
    expect(opts.find((o) => o.kind === 'budget_raise')).toMatchObject({ disabled: true });
    expect(opts.find((o) => o.kind === 'tune')).toMatchObject({ disabled: false, note: expect.stringContaining('never for actions.*') });
    expect(opts.find((o) => o.kind === 'hire')).toMatchObject({ disabled: false, note: '' });
    expect(opts.some((o) => o.kind === 'money')).toBe(true);
    expect(opts.some((o) => o.kind === 'read')).toBe(false);
  });

  it('words eval runs, deadlines, expected durations, WIP and value against spend', async () => {
    const { evalRunText, dueBadge, expectedLabel, wipLabel, roiText, movementText } = await import('../src/lib/org3');
    expect(evalRunText({ passRate: 0.6, baselinePassRate: 0.8, verdict: 'regress' })).toEqual({ text: '60% vs baseline 80% (-20 pts) — regression, blocked', color: 'var(--red)' });
    expect(evalRunText({ passRate: 0.8, baselinePassRate: 0.8, verdict: 'pass' }).text).toBe('80% vs baseline 80% (+0 pts) — pass');
    const now = new Date('2026-11-02T10:00:00Z');
    expect(dueBadge('2026-11-02T09:00:00Z', 'todo', now)).toMatchObject({ label: 'overdue 1h 0m', color: 'var(--red)' });
    expect(dueBadge('2026-11-02T20:00:00Z', 'todo', now)).toMatchObject({ label: 'due in 10h 0m', color: 'var(--amber)' });
    expect(dueBadge('2026-11-02T09:00:00Z', 'done', now)).toBeNull();
    expect(expectedLabel({ runs: 2, hours: 1.5, samples: 4, basis: 'class' })).toBe('≈2 runs, 1.5h');
    expect(expectedLabel({ runs: null, hours: null, samples: 0, basis: 'none' })).toBeNull();
    expect(wipLabel({ open: 3, wip: 3, atLimit: true, expectedHours: 6 })).toEqual({ text: '3/3 · ≈6h', color: 'var(--red)' });
    expect(roiText({ valueUsd: 30, spentUsd: 10, roi: 3 })).toEqual({ text: '$30.00 realised · $10.00 spent · 3×', color: 'var(--green)' });
    expect(roiText({ valueUsd: 0, spentUsd: 0, roi: null }).text).toBe('$0.00 realised · $0.00 spent · no spend');
    expect(movementText({ measured: true, movement7d: 12, value: 450, target: 1000 })).toBe('+12 this week · 450 of 1000');
    expect(movementText({ measured: false, movement7d: null, value: 3, target: 5 })).toBe('self-reported — no measured movement');
  });
});

describe('golden-set roles', () => {
  it('slugs a member title like the server', async () => {
    const { roleKeyOf } = await import('../src/lib/org3');
    expect(roleKeyOf({ title: 'Senior Writer', agentId: 'abcdef123456' })).toBe('senior-writer');
    expect(roleKeyOf({ title: 'Éditeur', agentId: 'x' })).toBe('editeur');
    expect(roleKeyOf({ title: '', agentId: 'abcdef123456' })).toBe('agent-abcdef12');
  });
});

describe('member_settings cards', () => {
  it('words the patch and offers the kind for delegation by its member_* rows', async () => {
    const { memberSettingsLines, delegationOptions } = await import('../src/lib/org3');
    expect(memberSettingsLines({ patch: { model: 'claude-x', agentTypeId: null, name: 'Quill' }, heartbeat: { enabled: true, cron: '0 * * * *' }, applyToChats: true }))
      .toEqual(['model → claude-x', 'agent type → (default)', 'name → Quill', 'heartbeat → on (0 * * * *)', 'also switches its existing chats']);
    expect(memberSettingsLines({})).toEqual([]);
    const opts = delegationOptions([{ kind: 'member_folder', match: 'a member\'s assigned workspace folder', verdict: 'propose', reason: 'it widens files', delegable: true }]);
    expect(opts.find((o) => o.kind === 'member_settings')).toMatchObject({ disabled: false, note: '' });
  });
});
