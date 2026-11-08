/** The visual process editor (docs/processes.md "The editor"): the pure
 *  edits (add a step after another, move it to a role or a stage, link two
 *  steps — a link back is a bounded loop, in a "performer chooses" stage an
 *  "available after" —, delete, undo/redo), the canvas layout and hit test,
 *  the live check with the server's own validator; and the editor on screen:
 *  the palette, the inspector, keyboard delete and undo, validation keeping
 *  Save off, and the save payload through the author path. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessDef } from '../src/lib/api';
import {
  addNode, addStage, allLanes, checkProcess, connect, deleteNode, disconnect, hitTest, historyReducer, initHistory, layoutEditor, moveNode, setEdge, setStageMode, tidy, G,
} from '../src/lib/process-editor';

afterEach(cleanup);

const base = (): ProcessDef => ({
  title: 'Release checklist', category: 'delivery', triggers: [{ kind: 'manual' }],
  stages: [{ id: 'check', title: 'Check', mode: 'strict' }, { id: 'ship', title: 'Ship', mode: 'strict' }],
  nodes: [
    { id: 'scope', title: 'List the changes', kind: 'task', stage: 'check', lane: 'owner', must: ['Every change closes a task'] },
    { id: 'ci', title: 'CI green', kind: 'task', stage: 'check', lane: 'owner' },
    { id: 'go', title: 'Go / no-go', kind: 'approval', stage: 'check', approver: 'manager', question: 'Ship?' },
    { id: 'deploy', title: 'Deploy', kind: 'task', stage: 'ship', lane: 'owner' },
  ],
  edges: [{ from: 'scope', to: 'ci' }, { from: 'ci', to: 'go' }],
});

describe('editor operations (pure)', () => {
  it('adds a step after another: a lone onward link is taken over (A→new→B); the result validates', () => {
    const r = addNode(base(), 'task', { stage: 'check', after: 'scope' });
    const id = r.select && r.select.kind === 'node' ? r.select.id : '';
    expect(r.def.nodes.map((n) => n.id)).toEqual(['scope', id, 'ci', 'go', 'deploy']);
    expect(r.def.edges).toEqual(expect.arrayContaining([{ from: 'scope', to: id }, { from: id, to: 'ci' }, { from: 'ci', to: 'go' }]));
    expect(r.def.edges).toHaveLength(3);
    expect(checkProcess(r.def)).toEqual([]);
  });

  it('adds an approval and a wait that are valid as dropped; an undo step undoes the step it was dropped on', () => {
    let d = addNode(base(), 'approval', { stage: 'ship', lane: 'ceo' }).def;
    d = addNode(d, 'wait', { stage: 'ship' }).def;
    const appr = d.nodes.find((n) => n.kind === 'approval' && n.stage === 'ship')!;
    expect(appr.approver).toBe('ceo');
    expect(d.nodes.find((n) => n.kind === 'wait')!.waitHours).toBe(24);
    const u = addNode(d, 'undo', { stage: 'check', undoFor: 'deploy' });
    const undo = u.def.nodes.find((n) => n.compensation)!;
    expect(undo.title).toBe('Undo: Deploy');
    expect(u.def.nodes.find((n) => n.id === 'deploy')!.compensate).toBe(undo.id);
    expect(checkProcess(u.def)).toEqual([]);
  });

  it('moves a step to another role and to another stage (links across stages are removed with a note); a task cannot sit in the approvers\' row', () => {
    const lane = moveNode(base(), 'ci', { lane: 'Release manager' });
    expect(lane.def.nodes.find((n) => n.id === 'ci')!.lane).toBe('Release manager');
    const stage = moveNode(base(), 'ci', { stage: 'ship', lane: 'owner' });
    expect(stage.def.nodes.find((n) => n.id === 'ci')!.stage).toBe('ship');
    expect(stage.def.edges).toEqual([]);
    expect(stage.note).toMatch(/2 links removed/);
    const refused = moveNode(base(), 'ci', { lane: 'manager' });
    expect(refused.def.nodes.find((n) => n.id === 'ci')!.lane).toBe('owner');
    expect(refused.note).toMatch(/needs a role/);
    const before = moveNode(base(), 'deploy', { before: 'scope' });
    expect(before.def.nodes[0].id).toBe('deploy');
    expect(before.def.nodes[0].stage).toBe('check');
  });

  it('connects steps; a link back is the loop (with a round limit), even when an older link would otherwise count as it', () => {
    const fwd = connect(base(), 'scope', 'go');
    expect(fwd.def.edges).toContainEqual({ from: 'scope', to: 'go' });
    const loop = connect(base(), 'go', 'scope', 3);
    expect(loop.def.edges).toContainEqual({ from: 'go', to: 'scope', loopMax: 2 });
    expect(loop.note).toMatch(/loop/);
    expect(checkProcess(loop.def, { loopMaxCeiling: 3 })).toEqual([]);
    // declared out of order: the new link back is still the loop
    const d = { ...base(), nodes: [base().nodes[2], base().nodes[1], base().nodes[0], base().nodes[3]] };
    const r = connect(d, 'go', 'scope', 3);
    expect(r.def.edges.find((e) => e.from === 'go')!.loopMax).toBe(2);
    expect(checkProcess(r.def, { loopMaxCeiling: 3 })).toEqual([]);
    expect(connect(base(), 'scope', 'deploy').error).toMatch(/within a stage/);
    expect(connect(base(), 'scope', 'ci').error).toMatch(/already leads/);
  });

  it('in a "performer chooses" stage a link is "available after"; a cycle is refused; switching the mode converts links both ways', () => {
    const dyn = setStageMode(base(), 'check', 'dynamic').def;
    expect(dyn.edges).toEqual([]);
    expect(dyn.nodes.find((n) => n.id === 'ci')!.availableWhen).toEqual({ after: ['scope'] });
    expect(checkProcess(dyn)).toEqual([]);
    const linked = connect(dyn, 'scope', 'go');
    expect(linked.def.nodes.find((n) => n.id === 'go')!.availableWhen).toEqual({ after: ['ci', 'scope'] });
    expect(linked.select).toEqual({ kind: 'link', from: 'scope', to: 'go' });
    expect(connect(dyn, 'go', 'scope').error).toMatch(/wait on each other/);
    const back = setStageMode(dyn, 'check', 'strict').def;
    expect(back.edges).toEqual(expect.arrayContaining([{ from: 'scope', to: 'ci' }, { from: 'ci', to: 'go' }]));
    expect(back.nodes.find((n) => n.id === 'ci')!.availableWhen).toBeUndefined();
  });

  it('deletes a step with its links and undo references; removes a link; sets a condition', () => {
    const del = deleteNode(base(), 'ci').def;
    expect(del.nodes.map((n) => n.id)).not.toContain('ci');
    expect(del.edges).toEqual([]);
    expect(disconnect(base(), { kind: 'edge', from: 'ci', to: 'go' }).def.edges).toEqual([{ from: 'scope', to: 'ci' }]);
    const cond = setEdge(base(), 'ci', 'go', { when: 'ci_result == green' }).def;
    expect(cond.edges[1].when).toBe('ci_result == green');
    expect(setEdge(cond, 'ci', 'go', { when: null }).def.edges[1].when).toBeUndefined();
  });

  it('undo/redo: every edit is a step back; typing in one field within a second is one', () => {
    let h = initHistory(base());
    const a = addStage(h.present, 'dynamic').def;
    h = historyReducer(h, { type: 'set', def: a });
    h = historyReducer(h, { type: 'set', def: { ...a, title: 'R' }, key: 'title', now: 1_000 });
    h = historyReducer(h, { type: 'set', def: { ...a, title: 'Re' }, key: 'title', now: 1_300 });
    expect(h.past).toHaveLength(2);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present.title).toBe('Release checklist');
    expect(h.present.stages).toHaveLength(3);
    h = historyReducer(h, { type: 'undo' });
    expect(h.present.stages).toHaveLength(2);
    h = historyReducer(h, { type: 'redo' });
    h = historyReducer(h, { type: 'redo' });
    expect(h.present.title).toBe('Re');
  });

  it('the live check is the server\'s validator, pinned to the step, link or stage, in plain words', () => {
    const d = base();
    d.nodes.push({ id: 'sub', title: 'Hand off', kind: 'subprocess', stage: 'ship' });
    d.edges.push({ from: 'go', to: 'scope' });
    d.stages.push({ id: 'empty', title: 'Later', mode: 'strict' });
    const ps = checkProcess(d);
    expect(ps.find((p) => p.target.kind === 'node')).toMatchObject({ target: { kind: 'node', id: 'sub' }, where: '“Hand off”', fix: 'pick the process it runs' });
    expect(ps.find((p) => p.target.kind === 'edge')).toMatchObject({ target: { kind: 'edge', from: 'go', to: 'scope' }, text: 'this link goes back (a loop) with no round limit' });
    expect(ps.find((p) => p.target.kind === 'stage')).toMatchObject({ target: { kind: 'stage', id: 'empty' } });
    expect(ps.map((p) => `${p.text} ${p.fix}`).join(' ')).not.toMatch(/loopMax|availableWhen|compensate/);
  });

  it('lays out stages, rows and steps; the hit test finds the step, row or stage under a point; Tidy keeps the loop', () => {
    const d = base();
    const L = layoutEditor(d, allLanes(d));
    expect(allLanes(d)).toEqual(['owner', 'manager']);
    const ci = L.nodes.get('ci')!;
    expect(L.nodes.get('scope')!.x).toBeLessThan(ci.x);
    expect(hitTest(L, ci.x + 5, ci.y + 5)).toEqual({ kind: 'node', id: 'ci' });
    const manager = L.stages[0].lanes.find((x) => x.lane === 'manager')!;
    expect(hitTest(L, 20, manager.y + 5)).toEqual({ kind: 'lane', stage: 'check', lane: 'manager' });
    expect(hitTest(L, 300, L.stages[1].y + 10)).toEqual({ kind: 'stage', stage: 'ship' });
    expect(L.edges.map((e) => e.key)).toEqual(['edge:scope>ci', 'edge:ci>go']);
    expect(G.CARD_W).toBeLessThan(G.COL_W);
    const looped = connect(d, 'go', 'scope', 3).def;
    const t = tidy(looped);
    expect(checkProcess(t.def, { loopMaxCeiling: 3 })).toEqual([]);
  });
});

// ---- on screen ----

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const validate = vi.fn(async () => ({ problems: [], name: 'release-checklist', loopMaxCeiling: 3, processNames: ['incident-response'] }));
const editOrgProcess = vi.fn(async (_ws: string, _id: string, body: { def: ProcessDef; reason?: string }) => ({ process: { id: 'p1', version: 4, pendingVersion: null, title: 'Release checklist' }, def: body.def, rollout: null }));
const createOrgProcess = vi.fn(async (_ws: string, body: { def: ProcessDef }) => ({ process: { id: 'p9', version: 1, status: 'active', title: body.def.title }, def: body.def }));
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: { validateOrgProcess: validate, editOrgProcess, createOrgProcess } }));
const { default: ProcessEditor } = await import('../src/components/ProcessEditor');

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { wsOrg: { units: [] }, showToast: vi.fn() });
  validate.mockClear(); editOrgProcess.mockClear(); createOrgProcess.mockClear();
});

const nodes = () => screen.getAllByTestId('editor-node').map((n) => n.getAttribute('data-id'));
const ready = () => waitFor(() => expect(screen.getByTestId('editor-valid')).toHaveTextContent('Ready to save'), { timeout: 2_000 });

describe('the process editor', () => {
  it('adds a step from the palette after the selected one, links it, deletes with the keyboard and undoes', async () => {
    render(<ProcessEditor wsId="ws1" initial={base()} process={{ id: 'p1', name: 'release-checklist', title: 'Release checklist', version: 3 }} onCancel={() => {}} onSaved={() => {}} />);
    expect(nodes()).toEqual(['scope', 'ci', 'go', 'deploy']);
    expect(screen.getByTestId('editor-save')).toBeDisabled(); // nothing changed yet
    // select "List the changes", then click Task: a new step after it
    fireEvent.pointerDown(screen.getAllByTestId('editor-node')[0], { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId('step-inspector')).toHaveAccessibleName('Step: List the changes');
    fireEvent.click(screen.getByTestId('palette-task'));
    expect(nodes()).toHaveLength(5);
    const ins = screen.getByTestId('step-inspector');
    expect(within(ins).getByTestId('step-title')).toHaveValue('New step');
    expect(ins).toHaveTextContent('Comes afterList the changes');
    expect(ins).toHaveTextContent('Leads toCI green');
    // rename, then move it to another role
    fireEvent.change(within(ins).getByTestId('step-title'), { target: { value: 'Security scan' } });
    fireEvent.change(within(ins).getByTestId('step-role'), { target: { value: 'chief' } });
    expect(screen.getAllByTestId('editor-lane').map((l) => l.getAttribute('data-lane'))).toContain('chief');
    await ready();
    // delete with the keyboard, then undo brings it back
    const node = screen.getAllByTestId('editor-node').find((n) => n.getAttribute('aria-label')?.startsWith('Security scan'))!;
    fireEvent.keyDown(node, { key: 'Delete' });
    expect(nodes()).toHaveLength(4);
    fireEvent.keyDown(screen.getByTestId('process-editor'), { key: 'z', ctrlKey: true });
    expect(nodes()).toHaveLength(5);
    fireEvent.keyDown(screen.getByTestId('process-editor'), { key: 'z', ctrlKey: true, shiftKey: true });
    expect(nodes()).toHaveLength(4);
  });

  it('keeps Save off while a problem stands, pins it on the step, and saves the definition with a reason through the author path', async () => {
    const onSaved = vi.fn();
    render(<ProcessEditor wsId="ws1" initial={base()} process={{ id: 'p1', name: 'release-checklist', title: 'Release checklist', version: 3 }} onCancel={() => {}} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('palette-subprocess'));
    await waitFor(() => expect(screen.getByTestId('editor-problem-count')).toHaveTextContent('1 problem'));
    expect(screen.getByTestId('editor-save')).toBeDisabled();
    expect(screen.getByTestId('inspector-problems')).toHaveTextContent('A sub-process step names no process — pick the process it runs');
    const bad = screen.getAllByTestId('editor-node').find((n) => n.className.includes('bad'))!;
    expect(bad.getAttribute('aria-label')).toMatch(/1 problem/);
    // the server's check is asked too, read-only
    await waitFor(() => expect(validate).toHaveBeenCalled());
    expect(validate.mock.calls.at(-1)).toEqual(['ws1', expect.objectContaining({ process: 'p1' })]);
    fireEvent.change(screen.getByLabelText('Process to run'), { target: { value: 'incident-response' } });
    await ready();
    fireEvent.click(screen.getByTestId('editor-save'));
    expect(screen.getByTestId('editor-confirm')).toBeDisabled(); // a reason first
    fireEvent.change(screen.getByTestId('editor-reason'), { target: { value: 'hand failures to incident response' } });
    await act(async () => { fireEvent.click(screen.getByTestId('editor-confirm')); });
    expect(editOrgProcess).toHaveBeenCalledTimes(1);
    const [ws, pid, body] = editOrgProcess.mock.calls[0];
    expect([ws, pid, body.reason]).toEqual(['ws1', 'p1', 'hand failures to incident response']);
    const sub = (body as { def: ProcessDef }).def.nodes.find((n) => n.kind === 'subprocess')!;
    expect(sub).toMatchObject({ process: 'incident-response', stage: 'ship' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.anything(), { kind: 'applied', text: 'v4 is active: new runs start on it.' }));
  });

  it('a server-only problem (a name that exists) also keeps Save off', async () => {
    validate.mockResolvedValueOnce({ problems: [{ where: 'title', problem: 'a process "release-checklist" exists', fix: 'give this one another title, or edit the existing process' }], name: 'release-checklist', loopMaxCeiling: 3, processNames: [] } as never);
    render(<ProcessEditor wsId="ws1" initial={base()} template={{ id: 'release-checklist', title: 'Release checklist' }} onCancel={() => {}} onSaved={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('editor-problem-count')).toHaveTextContent('1 problem'), { timeout: 2_000 });
    expect(screen.getByTestId('editor-save')).toBeDisabled();
    expect(screen.getByTestId('process-inspector')).toHaveTextContent('exists');
    expect(validate.mock.calls[0]).toEqual(['ws1', expect.objectContaining({ template: 'release-checklist', name: 'release-checklist' })]);
  });

  it('creates a new process from a blank page: a stage, a step, a title, then POST with the definition', async () => {
    const onSaved = vi.fn();
    render(<ProcessEditor wsId="ws1" initial={{ title: '', category: 'delivery', triggers: [{ kind: 'manual' }], stages: [{ id: 'main', title: 'Main', mode: 'strict' }], nodes: [], edges: [] }} onCancel={() => {}} onSaved={onSaved} />);
    expect(screen.getByTestId('editor-problem-count')).toHaveTextContent('3 problems'); // no title, no steps, an empty stage
    fireEvent.click(screen.getByTestId('palette-task'));
    fireEvent.click(screen.getByTestId('palette-stage-dynamic'));
    expect(screen.getByTestId('stage-inspector')).toHaveTextContent('Stage 2 of 2');
    fireEvent.click(screen.getByTestId('palette-meeting')); // into the selected stage
    fireEvent.click(screen.getByLabelText('Close the step'));
    fireEvent.change(screen.getByTestId('process-title'), { target: { value: 'Customer escalation' } });
    await ready();
    fireEvent.click(screen.getByTestId('editor-save'));
    fireEvent.change(screen.getByTestId('editor-reason'), { target: { value: 'escalations are handled differently every time' } });
    await act(async () => { fireEvent.click(screen.getByTestId('editor-confirm')); });
    const body = createOrgProcess.mock.calls[0][1] as { def: ProcessDef; reason: string; unitId: string | null };
    expect(body.def.title).toBe('Customer escalation');
    expect(body.def.stages.map((s) => s.mode)).toEqual(['strict', 'dynamic']);
    expect(body.def.nodes.map((n) => [n.kind, n.stage])).toEqual([['task', 'main'], ['meeting', body.def.stages[1].id]]);
    expect(body.unitId).toBeNull();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
