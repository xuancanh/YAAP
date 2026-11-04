/** The roadmap and the project page (docs/work-tracking.md "Views"): the
 *  timeline's math (date → position, bar fallbacks, grouping by goal or
 *  unit), the Timeline (bars, milestones, today line, groups), the
 *  Now / Next / Later board (lanes, a lane change), and the project page's
 *  sections. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgramItem, ProjectPage, ProjectSummary, RoadmapData } from '../src/lib/api';
import { LaneBoard, ProjectPageView, RoadmapTimeline } from '../src/components/OrgRoadmapView';
import { appetiteUsed, blockedText, buildScale, dayMs, forecastLine, groupProjects, hillPoint, laneColumns, parseBlockedOn, spanOf, stepsCount, xOf } from '../src/lib/roadmap';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const TODAY = '2026-11-03';

const proj = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id, key: `P-${id}`, title: `Project ${id}`, kind: 'project', status: 'active', lane: 'now', rank: 0, unitId: 'u1', unitName: 'Content',
  lead: { kind: 'agent', id: 'w', name: 'Writer' }, goalIds: ['kr1'], goals: [{ id: 'kr1', title: '1,000 subscribers', kind: 'key_result', parentGoalId: 'o1' }],
  startDate: '2026-11-01', targetDate: '2026-12-01', milestones: [], progress: { done: 1, total: 4, pct: 25 }, hill: 0.3, hillInferred: true,
  health: 'on_track', healthReason: '', healthAsk: '', healthAt: '2026-11-02T00:00:00.000Z',
  update: { state: 'fresh', dueAt: '2026-11-09T00:00:00.000Z', cadenceDays: 7 },
  appetite: { days: 30, usd: 20, spentUsd: 5, usdShare: 0.25, daysUsed: 2, daysShare: 0.07, tripped: false, breakerAt: null },
  blocked: 0, late: false, overBudget: false,
  forecast: { state: 'insufficient', remaining: 3, samples: 2, p50: null, p85: null, note: 'Not enough history: 2 task(s) done in the last 8 weeks, 8 needed for a forecast.' },
  briefOk: true, ...over,
});

const roadmap = (projects: ProjectSummary[]): RoadmapData => ({
  generatedAt: `${TODAY}T08:00:00.000Z`, today: TODAY, projects,
  goals: [
    { id: 'o1', title: 'Grow the audience', kind: 'objective', parentGoalId: null, status: 'active', dueAt: null },
    { id: 'kr1', title: '1,000 subscribers', kind: 'key_result', parentGoalId: 'o1', status: 'active', dueAt: null },
    { id: 'kr2', title: '40% open rate', kind: 'key_result', parentGoalId: 'o1', status: 'active', dueAt: null },
  ],
  units: [{ id: 'u1', name: 'Content', parentUnitId: 'u0' }, { id: 'u2', name: 'Sales', parentUnitId: 'u0' }],
  system: [],
});

describe('roadmap math', () => {
  it('maps dates into the window and keeps today inside it', () => {
    const s = buildScale(TODAY, [{ start: dayMs('2026-11-01'), end: dayMs('2026-12-01') }], 'month');
    expect(xOf(s, dayMs(TODAY))).toBeGreaterThan(0);
    expect(xOf(s, dayMs(TODAY))).toBeLessThan(1);
    expect(xOf(s, dayMs('2026-12-01'))).toBeGreaterThan(xOf(s, dayMs('2026-11-01')));
    expect(xOf(s, s.start - 1e10)).toBe(0);
    expect(s.columns.length).toBeGreaterThan(5);
    const q = buildScale(TODAY, [], 'quarter');
    expect(q.end - q.start).toBeGreaterThan(s.end - s.start);
  });
  it('draws a bar from start to target, falls back to the appetite or the creation day, and leaves dateless projects unscheduled', () => {
    expect(spanOf(proj('a'))).toEqual({ start: dayMs('2026-11-01'), end: dayMs('2026-12-01'), estimated: false });
    expect(spanOf(proj('b', { targetDate: null }))).toEqual({ start: dayMs('2026-11-01'), end: dayMs('2026-12-01'), estimated: true });
    expect(spanOf(proj('c', { startDate: null, createdAt: '2026-10-20T00:00:00Z' }))!.start).toBe(dayMs('2026-10-20'));
    expect(spanOf(proj('d', { startDate: null, targetDate: null }))).toBeNull();
  });
  it('groups by objective → key result, puts unlinked projects under "No key result", or groups by unit', () => {
    const data = roadmap([proj('a'), proj('b', { goalIds: ['kr2'], goals: [] }), proj('c', { goalIds: [], goals: [], unitId: 'u2' })]);
    expect(groupProjects(data, 'goal').map((g) => [g.title, g.depth, g.projects.map((p) => p.id)])).toEqual([
      ['Grow the audience', 0, []], ['1,000 subscribers', 1, ['a']], ['40% open rate', 1, ['b']], ['No key result', 0, ['c']],
    ]);
    expect(groupProjects(data, 'unit').map((g) => [g.title, g.projects.map((p) => p.id)])).toEqual([['Content', ['a', 'b']], ['Sales', ['c']]]);
  });
  it('orders lanes by rank and keeps finished projects off the board', () => {
    const cols = laneColumns([proj('a', { rank: 2 }), proj('b', { rank: 1 }), proj('c', { lane: 'next' }), proj('d', { status: 'done' })]);
    expect(cols.now.map((p) => p.id)).toEqual(['b', 'a']);
    expect(cols.next.map((p) => p.id)).toEqual(['c']);
    expect(cols.later).toEqual([]);
  });
  it('words the blocker, the steps, the appetite, the forecast and the hill', () => {
    expect(blockedText(parseBlockedOn(JSON.stringify({ kind: 'ceo', ref: 'a1', reason: 'pick a sponsor', since: '' })))).toBe('Waits on you: pick a sponsor');
    expect(blockedText(parseBlockedOn(JSON.stringify({ kind: 'agent', ref: 'w', reason: 'review', since: '' })), () => 'Writer')).toBe('Waits on Writer: review');
    expect(parseBlockedOn('')).toBeNull();
    expect(stepsCount(JSON.stringify([{ done: true }, { done: false }, { done: true, dropped: true }]))).toEqual({ done: 1, total: 2 });
    expect(appetiteUsed(proj('a').appetite)).toBe(0.25);
    expect(forecastLine(proj('a').forecast)).toMatch(/Not enough history/);
    expect(forecastLine({ state: 'range', remaining: 3, samples: 9, p50: '2026-11-20', p85: '2026-12-04', note: '' })).toBe('Likely 2026-11-20, 85% by 2026-12-04');
    expect(hillPoint(0.5, 200, 60).y).toBeLessThan(hillPoint(0, 200, 60).y);
  });
});

describe('Timeline', () => {
  it('draws a bar per project from start to target, its progress fill, milestones as diamonds and a today line', () => {
    const onOpen = vi.fn();
    const data = roadmap([
      proj('a', { milestones: [{ id: 'm1', name: 'Beta', date: '2026-11-15', done: true }, { id: 'm2', name: 'Launch', date: '2026-11-28', done: false }], health: 'at_risk' }),
      proj('b', { startDate: '2026-11-10', targetDate: '2026-11-20' }),
      proj('c', { startDate: null, targetDate: null }),
    ]);
    render(<RoadmapTimeline data={data} groupBy="goal" zoom="month" onOpen={onOpen} />);
    const bars = screen.getAllByTestId('roadmap-bar');
    expect(bars).toHaveLength(2);
    const [a, b] = bars;
    expect(Number(b.dataset.left)).toBeGreaterThan(Number(a.dataset.left));
    expect(Number(b.dataset.width)).toBeLessThan(Number(a.dataset.width));
    expect(a.dataset.health).toBe('at_risk');
    expect(within(a).getByTestId('roadmap-fill').style.width).toBe('25%');
    const ms = screen.getAllByTestId('milestone');
    expect(ms.map((m) => m.dataset.done)).toEqual(['1', '0']);
    expect(ms[0].getAttribute('title')).toContain('Beta');
    const today = screen.getByTestId('today-line');
    expect(Number(today.dataset.x)).toBeGreaterThan(Number(a.dataset.left));
    // the dateless project is not drawn; the legend explains the marks and the bar is labelled
    expect(screen.getAllByTestId('roadmap-row')).toHaveLength(2);
    expect(screen.getByTestId('roadmap-legend').textContent).toMatch(/Milestone done/);
    expect(a.textContent).toContain('25% done · target');
    fireEvent.click(b);
    expect(onOpen).toHaveBeenCalledWith('b');
  });
  it('groups rows by goal or by unit', () => {
    const data = roadmap([proj('a'), proj('c', { goalIds: [], goals: [], unitId: 'u2' })]);
    const { rerender } = render(<RoadmapTimeline data={data} groupBy="goal" zoom="quarter" onOpen={() => {}} />);
    expect(screen.getAllByTestId('roadmap-group').map((g) => g.dataset.group)).toEqual(['Grow the audience', '1,000 subscribers', 'No key result']);
    rerender(<RoadmapTimeline data={data} groupBy="unit" zoom="quarter" onOpen={() => {}} />);
    expect(screen.getAllByTestId('roadmap-group').map((g) => g.dataset.group)).toEqual(['Content', 'Sales']);
  });
});

describe('Now / Next / Later', () => {
  it('puts each card in its lane with its health, update state, forecast and appetite; a lane change calls back', () => {
    const onLane = vi.fn(); const onOpen = vi.fn();
    render(<LaneBoard projects={[
      proj('a', { health: 'at_risk', healthReason: 'Two sponsors went quiet', healthAsk: 'An intro', update: { state: 'missing', dueAt: null, cadenceDays: 7 } }),
      proj('b', { lane: 'next' }), proj('c', { lane: 'later', appetite: { ...proj('c').appetite, tripped: true } }),
    ]} onOpen={onOpen} onLane={onLane} errors={{ b: 'refused: only the CEO' }} />);
    const now = screen.getByTestId('lane-now');
    expect(within(now).getAllByTestId('project-card')).toHaveLength(1);
    expect(now.textContent).toContain('At risk');
    expect(now.textContent).toContain('Update missing');
    expect(now.textContent).toContain('Two sponsors went quiet');
    expect(now.textContent).toMatch(/Not enough history/);
    expect(within(screen.getByTestId('lane-next')).getByRole('alert').textContent).toContain('only the CEO');
    expect(screen.getByTestId('lane-later').textContent).toContain('breaker tripped');
    // the card's menu moves it (keyboard path), dragging onto a lane does the same
    fireEvent.click(screen.getByLabelText('Lane of Project b'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Move to Now' }));
    expect(onLane).toHaveBeenCalledWith('b', 'now');
    const card = within(screen.getByTestId('lane-later')).getByTestId('project-card');
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? '', effectAllowed: '' };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId('lane-next'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('lane-next'), { dataTransfer });
    expect(onLane).toHaveBeenCalledWith('c', 'next');
    fireEvent.click(within(now).getByText('Project a'));
    expect(onOpen).toHaveBeenCalledWith('a');
  });
});

describe('The project page', () => {
  const page = (): ProjectPage => ({
    project: { ...proj('a', { milestones: [{ id: 'm1', name: 'Beta', date: '2026-11-15', done: false }] }), brief: { problem: 'Open rate fell', hypothesis: 'A cleaner template lifts opens', done_when: 'New template live', mvp: 'One issue' }, createdAt: '2026-11-01T00:00:00Z', createdBy: 'user', updateCadenceDays: null },
    updates: [{ id: 'u1', orgId: 'o', projectId: 'a', health: 'at_risk', reason: 'ESP review pending', ask: 'Approve the domain', body: '', hill: 0.3, diff: JSON.stringify({ done: 2, scope: 4, spentUsd: 1.5, blocked: 1 }), by: 'agent:w', createdAt: '2026-11-02T00:00:00Z' }],
    tasks: [
      { id: 't1', key: 'ENG-1', title: 'Design the template', status: 'done', assigneeAgentId: 'w', assigneeHumanId: null, source: 'plan', dueAt: null, doneAt: '2026-11-02T00:00:00Z', startedAt: null, updatedAt: '2026-11-02T00:00:00Z', unitId: 'u1', assigneeName: 'Writer', blockedOn: null, blockedText: '', steps: { done: 2, total: 3 } },
      { id: 't2', key: 'ENG-2', title: 'Ship it', status: 'blocked', assigneeAgentId: 'w', assigneeHumanId: null, source: 'retro', dueAt: null, doneAt: null, startedAt: null, updatedAt: '2026-11-02T00:00:00Z', unitId: 'u1', assigneeName: 'Writer', blockedOn: { kind: 'ceo', ref: '', reason: 'domain', since: '' }, blockedText: 'waits on the CEO: domain', steps: { done: 0, total: 0 } },
    ],
    blockers: [{ taskId: 't2', key: 'ENG-2', title: 'Ship it', kind: 'ceo', text: 'waits on the CEO: domain', since: '2026-11-02T00:00:00Z' }],
    decisions: [{ id: 'd1', kind: 'project_now', title: 'project now', status: 'approved', at: '2026-11-01T00:00:00Z', via: 'card' }],
    files: [{ path: 'shared/template.html', taskId: 't1' }],
    burn: [{ day: '2026-11-01', usd: 1 }, { day: '2026-11-02', usd: 0.5 }],
    throughput: [],
  });
  const handlers = () => ({ onBack: vi.fn(), onPatch: vi.fn(async () => {}), onPostUpdate: vi.fn(async () => {}), onAddMilestone: vi.fn(async () => {}), onToggleMilestone: vi.fn(async () => {}), onOpenTask: vi.fn() });
  it('renders the brief, milestones, progress and hill, the forecast note, health history, tasks by status, blockers, decisions and files', () => {
    const h = handlers();
    render(<ProjectPageView page={page()} {...h} />);
    expect(screen.getByTestId('project-brief').textContent).toContain('A cleaner template lifts opens');
    expect(screen.getByTestId('project-milestones').textContent).toContain('Beta');
    expect(screen.getByTestId('hill-chart')).toBeTruthy();
    expect(screen.getByTestId('project-forecast').textContent).toMatch(/Not enough history/);
    const upd = screen.getByTestId('health-update');
    expect(upd.textContent).toContain('ESP review pending');
    expect(upd.textContent).toContain('Ask: Approve the domain');
    expect(screen.getAllByTestId('task-group').map((g) => g.dataset.status)).toEqual(['blocked', 'done']);
    expect(screen.getByTestId('project-tasks').textContent).toContain('steps 2/3');
    expect(screen.getAllByTestId('source-badge').map((b) => b.textContent)).toEqual(['retro', 'plan']);
    expect(screen.getByTestId('project-blockers').textContent).toContain('waits on the CEO');
    expect(screen.getByTestId('project-decisions').textContent).toContain('approved');
    expect(screen.getByTestId('project-files').textContent).toContain('shared/template.html');
    fireEvent.click(screen.getByText('Design the template'));
    expect(h.onOpenTask).toHaveBeenCalledWith('ENG-1');
    fireEvent.click(within(screen.getByTestId('project-milestones')).getByRole('checkbox'));
    expect(h.onToggleMilestone).toHaveBeenCalledWith('m1', true);
  });
  it('posts a health update only with its reason, and an at-risk one with its ask', () => {
    const h = handlers();
    render(<ProjectPageView page={page()} {...h} />);
    fireEvent.click(screen.getAllByText('Post update')[0]);
    fireEvent.change(screen.getByLabelText('Health'), { target: { value: 'at_risk' } });
    const post = () => within(screen.getByTestId('project-health')).getAllByText('Post update').at(-1)! as HTMLButtonElement;
    expect(post().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'vendor slow' } });
    expect(post().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Ask'), { target: { value: 'call them' } });
    expect(post().disabled).toBe(false);
    fireEvent.click(post());
    expect(h.onPostUpdate).toHaveBeenCalledWith({ health: 'at_risk', reason: 'vendor slow', ask: 'call them', body: undefined });
  });
  it('the program block: the chief named as acting PM, the rhythms and the requests waiting on heads', () => {
    const h = handlers();
    const program: ProgramItem = {
      refType: 'project', id: 'a', key: 'P-a', kind: 'project', title: 'Project a', status: 'active', lane: 'now', health: 'on_track',
      owner: { agentId: 'c', name: 'Chief', role: 'acting_chief' },
      cadences: [{ kind: 'sync', label: 'Project sync', cron: '0 9 * * 1', everyDays: 7, nextAt: '2026-11-09T09:00:00.000Z', lastAt: null, enabled: true, stale: false }],
      team: [], requests: [], links: [], stale: false,
    };
    render(<ProjectPageView page={page()} program={program} {...h} />);
    expect(within(screen.getByTestId('project-page')).getAllByTestId('program-owner')[0].textContent).toBe('Chief · acting PM');
    expect(screen.getByTestId('program-block').textContent).toMatch(/Project sync.*next/);
    expect(screen.getByTestId('program-block').textContent).toMatch(/None waiting on a head/);
  });
  it('the board names each card\'s owner when the matrix is known', () => {
    render(<LaneBoard projects={[proj('a')]} onOpen={vi.fn()} onLane={vi.fn()} owners={new Map([['a', { agentId: 'c', name: 'Chief', role: 'acting_chief' as const }]])} />);
    expect(screen.getByTestId('program-owner').textContent).toBe('Chief · acting PM');
  });
});
