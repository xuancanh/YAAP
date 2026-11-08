/** Processes on screen (docs/processes.md; src/lib/processes.ts, the
 *  routes): the pane and a process's page have addresses that round-trip,
 *  Operations lists the page, a strict stage lays out in the engine's
 *  order with loops as "back to", a dynamic step's availability reads as a
 *  sentence, and the words for health, triggers and authors. */
import { describe, expect, it } from 'vitest';
import { navOf, parseRoute, placeOf, routeHref, type NavState } from '../src/lib/routes';
import { sectionDef, sectionOfPane } from '../src/lib/company-nav';
import { authorWords, availabilityWords, cohortRows, compensationsOf, edgeWords, hrs, layoutStage, meetingWords, pct, processSummary, triggerWords } from '../src/lib/processes';
import type { OrgProcess, ProcessDef, ProcessRollout } from '../src/lib/api';

const def: ProcessDef = {
  title: 'Content', category: 'delivery', triggers: [{ kind: 'manual' }, { kind: 'event', event: 'incident_opened', severity: 'major' }, { kind: 'cadence', cron: '0 9 * * 1', enabled: false }],
  stages: [{ id: 'make', title: 'Make', mode: 'strict' }, { id: 'adopt', title: 'Adopt', mode: 'dynamic' }],
  nodes: [
    { id: 'draft', title: 'Draft', kind: 'task', stage: 'make' },
    { id: 'edit', title: 'Edit', kind: 'task', stage: 'make' },
    { id: 'legal', title: 'Legal', kind: 'task', stage: 'make' },
    { id: 'publish', title: 'Publish', kind: 'task', stage: 'make' },
    { id: 'setup', title: 'Set up', kind: 'task', stage: 'adopt', required: true },
    { id: 'train', title: 'Train', kind: 'task', stage: 'adopt', availableWhen: { after: ['setup'], vars: ['users'] } },
  ],
  edges: [{ from: 'draft', to: 'edit' }, { from: 'draft', to: 'legal' }, { from: 'edit', to: 'publish' }, { from: 'legal', to: 'publish' }, { from: 'edit', to: 'draft', when: 'verdict == revise', loopMax: 2 }],
};

describe('process addresses', () => {
  it('the pane and a process page round-trip, and the page lives in Operations', () => {
    expect(parseRoute('/c/operations/processes')?.place).toEqual({ kind: 'section', section: 'operations', pane: 'processes' });
    expect(parseRoute('/c/processes')?.place).toEqual({ kind: 'section', section: 'operations', pane: 'processes' });
    expect(parseRoute('/c/processes/abc-123')?.place).toEqual({ kind: 'process', id: 'abc-123' });
    expect(routeHref({ company: 'c', place: { kind: 'process', id: 'abc-123' } })).toBe('/c/processes/abc-123');
    const patch = navOf({ kind: 'process', id: 'abc-123' });
    expect(patch).toMatchObject({ section: 'operations', orgPane: 'processes', routeProcess: 'abc-123' });
    const s = { section: 'operations', orgPane: 'processes', routeProcess: 'abc-123', routeTask: null, routeProject: null, meetingId: null } as unknown as NavState;
    expect(placeOf(s)).toEqual({ kind: 'process', id: 'abc-123' });
    expect(placeOf({ ...s, routeProcess: null })).toEqual({ kind: 'section', section: 'operations', pane: 'processes' });
    expect(navOf({ kind: 'project', key: 'P-1' })).toMatchObject({ routeProcess: null });
    expect(sectionOfPane('processes')).toBe('operations');
    expect(sectionDef('operations').pages.map((p) => p.pane)).toContain('processes');
  });
});

describe('the graph in words', () => {
  it('lays a strict stage out in columns, the join after both branches, the loop not counted as an edge forward', () => {
    expect(layoutStage(def, 'make').map((c) => c.map((n) => n.id))).toEqual([['draft'], ['edit', 'legal'], ['publish']]);
    const e = edgeWords(def, 'edit');
    expect(e.after).toEqual(['Draft']);
    expect(e.next).toEqual(['Publish']);
    expect(e.loops).toEqual(['back to Draft when verdict == revise, at most 2×']);
    expect(edgeWords(def, 'draft').after).toEqual([]);
  });
  it('says when a dynamic step is available', () => {
    expect(availabilityWords(def, def.nodes[4])).toBe('Available from the start of the stage');
    expect(availabilityWords(def, def.nodes[5])).toBe('Available when "Set up" is done and users is known');
  });
  it('words for triggers, authors, numbers and the summary', () => {
    expect(triggerWords(def.triggers)).toBe('by hand · when an incident opens (major or worse) · on a schedule (0 9 * * 1) (off)');
    expect(authorWords('agent:a1', (id) => (id === 'a1' ? 'Writer' : undefined))).toBe('Writer');
    expect(authorWords('approval:x', () => undefined)).toBe('an approved card');
    expect(authorWords('system', () => undefined)).toBe('the template library');
    expect(pct(0.5)).toBe('50%');
    expect(pct(null)).toBe('—');
    expect(hrs(0.5)).toBe('30m');
    expect(hrs(3)).toBe('3.0h');
    expect(hrs(72)).toBe('3.0d');
    const p = (health: OrgProcess['metrics']['health'], active: number, reviewDue = false) => ({ status: 'active', reviewDue, metrics: { health, active } }) as unknown as OrgProcess;
    expect(processSummary([p('revise', 2, true), p('healthy', 1), { ...p('healthy', 3), status: 'retired' } as OrgProcess])).toEqual({ active: 2, open: 3, revise: 1, due: 1 });
  });
  it('a meeting step, the compensations outside the layout, and a ramp\'s comparison as rows', () => {
    const saga: ProcessDef = { ...def, stages: [def.stages[0]], nodes: [
      { id: 'draft', title: 'Draft', kind: 'task', stage: 'make', compensate: 'undo-draft' },
      { id: 'sync', title: 'Sync', kind: 'meeting', stage: 'make', meetingKind: 'weekly_review', attendees: ['owner', 'unit'] },
      { id: 'undo-draft', title: 'Delete the draft', kind: 'task', stage: 'make', compensation: true },
    ], edges: [{ from: 'draft', to: 'sync' }] };
    expect(layoutStage(saga, 'make').map((c) => c.map((n) => n.id))).toEqual([['draft'], ['sync']]);
    expect(meetingWords(saga.nodes[1])).toBe('holds a weekly review with the owner, the department');
    expect(compensationsOf(saga).map((x) => `${x.comp.title} ← ${x.undoes.map((u) => u.title).join(',')}`)).toEqual(['Delete the draft ← Draft']);
    const r = { rows: [{ metric: 'completion', stable: 1, candidate: 0.5, worse: true }, { metric: 'cycle', stable: 2, candidate: 3, worse: false }] } as unknown as ProcessRollout;
    expect(cohortRows(r)).toEqual([{ label: 'Completed', stable: '100%', candidate: '50%', worse: true }, { label: 'Cycle time (median)', stable: '2.0h', candidate: '3.0h', worse: false }]);
  });
});
