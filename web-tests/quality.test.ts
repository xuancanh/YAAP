/** Quality control on screen (docs/quality.md §8): the lede, labels,
 *  evidence links and per-criterion rows the Quality page and the task's
 *  QC panel show. */
import { describe, expect, it } from 'vitest';
import { criterionRows, evidenceTarget, makersByYield, pct, qcRounds, qualityLede, ruleLines, scopeLabel, violationsByPolicy } from '../src/lib/quality';
import { sectionOfPane, paneHome } from '../src/lib/company-nav';
import type { PolicyViolation, QcResult, QualityOverview } from '../src/lib/api';

const figures = (o: Partial<QualityOverview['metrics']['overall']> = {}) => ({ tasks: 0, graded: 0, firstPassYield: null, reworkRate: null, escapes: 0, escapeRate: null, spotChecks: 0, spotCheckFails: 0, sameFamilyShare: null, ...o });
const overview = (o: Partial<QualityOverview> = {}): QualityOverview => ({
  standards: [], policies: [], templates: [], recent: [], violations: [],
  metrics: { days: 30, overall: figures(), byAgent: {}, byUnit: {}, byStandard: {}, policies: { violations: 0, byPolicy: {}, resultConformance: null } },
  ...o,
});
const qc = (o: Partial<QcResult> = {}): QcResult => ({
  id: 'q1', taskId: 't1', kind: 'review', standardId: 's1', standardVersion: 1, passScore: 3.5, makerAgentId: 'a', unitId: null, verifier: 'agent:b', independence: 'different_family',
  round: 0, outcome: 'pass', score: 4, note: '', spotTaskId: null, escapedAt: null, escapeReason: '', createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-01T01:00:00Z', checks: [],
  rubric: [{ id: 'answer', text: 'Answers it', weight: 2 }, { id: 'sources', text: 'Sourced', weight: 3, min: 3, evidence: ['url'] }],
  scores: [{ criterion: 'answer', score: 4, note: 'ok', refs: [] }, { criterion: 'sources', score: 2, note: 'two unsourced', refs: ['url:https://x.test'] }],
  evidence: [{ criterion: 'answer', refs: [{ raw: 'file:/org/a.md', kind: 'file', ok: true, detail: '' }] }],
  ...o,
});

describe('quality helpers', () => {
  it('says where quality stands in one sentence', () => {
    expect(qualityLede(overview())).toMatch(/No quality standards or policies yet/);
    const q = overview({ metrics: { ...overview().metrics, overall: figures({ tasks: 4, firstPassYield: 0.75, escapes: 1 }), policies: { violations: 2, byPolicy: {}, resultConformance: 1 } } });
    expect(qualityLede(q)).toBe('75% of work passed review first time, 1 accepted result came back, 2 policy violations in the last 30 days.');
    expect(pct(null)).toBe('—');
    expect(pct(0.333)).toBe('33%');
  });

  it('labels scopes and rules in words', () => {
    expect(scopeLabel({ scopeKind: 'company', scopeRef: '', unitId: null })).toBe('Company');
    expect(scopeLabel({ scopeKind: 'deliverable', scopeRef: 'research', unitId: 'u1' }, () => 'Marketing')).toBe('Deliverable: research (in Marketing)');
    expect(ruleLines({ kind: 'predicate', appliesAt: 'action', rule: { tools: ['shop_set_*'], require: [{ field: 'price', op: 'gte', value: 10 }] } })).toEqual(['Before calls — tools shop_set_*', 'Requires price gte 10']);
    expect(ruleLines({ kind: 'judged', appliesAt: 'result', rule: {} })).toEqual(['At review', 'Judged by an independent checker']);
  });

  it('turns evidence into links: files open in the panel, URLs in a tab', () => {
    expect(evidenceTarget('file:/org/research/a.md#sha256=abcd1234')).toEqual({ kind: 'file', path: 'org/research/a.md' });
    expect(evidenceTarget('url:https://x.test/p')).toEqual({ kind: 'url', href: 'https://x.test/p' });
    expect(evidenceTarget('tool:web_search')).toEqual({ kind: 'text' });
  });

  it('shows each criterion with its score, floor and evidence; rounds in order', () => {
    const rows = criterionRows(qc());
    expect(rows.map((r) => [r.id, r.score, r.below])).toEqual([['answer', 4, false], ['sources', 2, true]]);
    expect(rows[0].refs).toEqual(['file:/org/a.md']);
    expect(rows[1].refs).toEqual(['url:https://x.test']);
    const order = qcRounds([qc({ id: 'spot', kind: 'spot_check', createdAt: '2026-11-02' }), qc({ id: 'r2', createdAt: '2026-11-03' }), qc({ id: 'r1', createdAt: '2026-11-01' })]);
    expect(order.map((r) => r.id)).toEqual(['r1', 'r2', 'spot']);
  });

  it('groups violations and ranks members worst first', () => {
    const v = (id: string, policyId: string, at: string) => ({ id, policyId, createdAt: at }) as PolicyViolation;
    const m = violationsByPolicy([v('1', 'p', '2026-11-01'), v('2', 'p', '2026-11-03'), v('3', 'q', '2026-11-02')]);
    expect(m.get('p')!.map((x) => x.id)).toEqual(['2', '1']);
    const q = overview({ metrics: { ...overview().metrics, byAgent: { a: figures({ tasks: 2, firstPassYield: 1 }), b: figures({ tasks: 3, firstPassYield: 0.3, escapes: 1 }) } } });
    expect(makersByYield(q).map((x) => x.agentId)).toEqual(['b', 'a']);
  });

  it('lives in Oversight', () => {
    expect(sectionOfPane('quality')).toBe('oversight');
    expect(paneHome('quality')).toEqual({ section: 'oversight', pane: 'quality' });
  });
});
