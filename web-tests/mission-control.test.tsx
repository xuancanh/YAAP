/** The org chart's mission control (docs/mission-control.md): the totals
 *  strip, the hierarchy with connectors and folding, the filters (needs
 *  attention, blocked, erroring, a unit, a search), the waiting chains, the
 *  phone list, and the pure helpers under them. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionControl, MissionNode } from '../src/lib/api';
import { MissionControlBoard } from '../src/components/OrgMissionControl';
import { NO_FILTER, buildForest, chainHighlight, flattenForest, matching, nodeLine, subtreeOf, totalsLine, waitChain } from '../src/lib/overview';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const NOW = new Date('2026-11-02T10:00:00Z');
const iso = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

const node = (id: string, name: string, reportsTo: string | null, over: Partial<MissionNode> = {}): MissionNode => ({
  id, agentId: id, name, emoji: '🙂', colors: '["#111","#222"]', title: `${name} title`, state: 'idle', doing: '', taskId: null,
  lastActiveAt: iso(-5), lastBeatAt: iso(-5), isChief: false, errors: [], live: null, doingSince: null, waitingOnYou: 0, blockedCount: 0, open: 1,
  lastRunAt: null, memberStatus: 'active', reportsToAgentId: reportsTo, leadsUnitId: null, wip: { open: 1, limit: 3 },
  spend: { todayUsd: 0.1, monthUsd: 1, monthCapUsd: 0 }, waits: [], liveLabel: '', ...over,
});

function fixture(): MissionControl {
  const nodes = [
    node('chief', 'Chief', null, { isChief: true, state: 'working', doing: 'Weekly plan', leadsUnitId: 'u-root' }),
    node('sales', 'Sales Head', 'chief', { state: 'working', doing: 'Q4 pipeline', leadsUnitId: 'u-sales', liveLabel: 'writing org/sales/reports/2026-W45.md', live: { sessionId: 's', sessionName: '', origin: 'org', startedAt: iso(-2), tool: 'fs_write', toolLabel: 'writing org/sales/reports/2026-W45.md', toolAt: iso(-1), calls: 2 } }),
    node('content', 'Content Head', 'chief', { state: 'blocked', doing: 'Blocked on "Pricing"', leadsUnitId: 'u-content', waitingOnYou: 1, blockedCount: 1,
      waits: [{ taskId: 't-pricing', title: 'Pricing', waitsOn: { kind: 'ceo', id: null, name: 'You', taskId: null }, reason: 'Need the price', since: iso(-60) }] }),
    node('rep', 'Rep', 'sales', { state: 'error', errors: [{ kind: 'turn', message: 'provider rejected model claude-opus-4-5', at: iso(-3) }] }),
    node('writer', 'Writer', 'content', { state: 'blocked', blockedCount: 1, waits: [{ taskId: 't-post', title: 'Launch post', waitsOn: { kind: 'agent', id: 'content', name: 'Content Head', taskId: null }, reason: 'Tone?', since: iso(-30) }] }),
    node('editor', 'Editor', 'content'),
  ];
  return {
    workspaceId: 'ws1', orgId: 'o1', generatedAt: NOW.toISOString(),
    company: { name: 'Acme', status: 'active', mode: 'autonomous', chiefAgentId: 'chief' },
    totals: { working: 2, blocked: 2, idle: 1, paused: 0, error: 1, tasksInFlight: 4, waitingOnYou: 3, spendTodayUsd: 4.2, monthUsd: 12, monthCapUsd: 50 },
    units: [
      { id: 'u-root', name: 'Company', slug: 'company', leadAgentId: 'chief', parentUnitId: null, openTasks: 9 },
      { id: 'u-sales', name: 'Sales', slug: 'sales', leadAgentId: 'sales', parentUnitId: 'u-root', openTasks: 3 },
      { id: 'u-content', name: 'Content', slug: 'content', leadAgentId: 'content', parentUnitId: 'u-root', openTasks: 4 },
    ],
    nodes,
    humans: [{ id: 'h1', memberAccountId: 'acc-ana', title: 'Designer', reportsToAgentId: 'content' }],
    edges: [{ from: 'content', to: 'ceo', taskId: 't-pricing', title: 'Pricing' }, { from: 'writer', to: 'content', taskId: 't-post', title: 'Launch post' }],
    partial: [],
  };
}

const visibleNodes = () => screen.queryAllByTestId(/^node-/).filter((el) => el.style.opacity !== '0.45').map((el) => el.dataset.testid!.slice(5));

describe('the board', () => {
  it('the strip: states, tasks in flight, what waits on you, spend against the envelope', () => {
    const onYou = vi.fn();
    render(<MissionControlBoard mc={fixture()} now={NOW} onSelect={() => {}} onWaitingOnYou={onYou} />);
    expect(screen.getByTestId('total-error').textContent).toBe('1erroring');
    expect(screen.getByTestId('total-blocked').textContent).toBe('2blocked');
    expect(screen.getByText('tasks in flight').previousSibling?.textContent).toBe('4');
    fireEvent.click(screen.getByTestId('total-you'));
    expect(onYou).toHaveBeenCalled();
    expect(screen.getByText(/today · \$12\.00 of \$50\.00 this month/)).toBeTruthy();
  });

  it('the tree: the chief, its heads, their members; a card says what it is doing; humans sit under their manager; a subtree folds', () => {
    render(<MissionControlBoard mc={fixture()} now={NOW} onSelect={() => {}} nameOfHuman={(id) => (id === 'acc-ana' ? 'Ana' : id)} />);
    const tree = screen.getByTestId('mission-tree');
    const chief = within(tree).getByTestId('node-chief');
    const groups = within(tree).getAllByRole('group');
    expect(groups[0].getAttribute('aria-label')).toBe("Chief's reports");
    expect(within(groups[0]).getByTestId('node-sales')).toBeTruthy();
    expect(chief.textContent).toContain('Chief of staff');
    expect(chief.textContent).toContain('Company · 9 open');
    expect(screen.getByTestId('node-sales').textContent).toContain('Q4 pipeline · writing org/sales/reports/2026-W45.md');
    expect(screen.getByTestId('node-content').textContent).toContain('Blocked on “Pricing” · waiting on you');
    expect(screen.getByTestId('node-content').textContent).toContain('waits on you · 1');
    expect(screen.getByTestId('node-rep').textContent).toContain('provider rejected model claude-opus-4-5');
    expect(screen.getByTestId('node-rep').textContent).toContain('1/3 WIP');
    expect(screen.getByText('Ana')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Hide Content Head's 3 reports" }));
    expect(screen.queryByTestId('node-writer')).toBeNull();
    expect(screen.queryByText('Ana')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Show Content Head's 3 reports" }));
    expect(screen.getByTestId('node-writer')).toBeTruthy();
  });

  it('filters: needs attention, erroring, a unit, a search; nothing matching offers to show everyone', () => {
    render(<MissionControlBoard mc={fixture()} now={NOW} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Needs attention' }));
    expect(visibleNodes().sort()).toEqual(['content', 'rep', 'writer']);
    expect(screen.getByTestId('node-chief').style.opacity).toBe('0.45');
    fireEvent.click(screen.getByTestId('total-error'));
    expect(visibleNodes()).toEqual(['rep']);
    expect(screen.queryByTestId('node-editor')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Everyone' }));
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'u-content' } });
    expect(visibleNodes().sort()).toEqual(['content', 'editor', 'writer']);
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'pipeline' } });
    expect(visibleNodes()).toEqual(['sales']);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show everyone' }));
    expect(visibleNodes()).toHaveLength(6);
  });

  it('a selected agent outlines its waiting chain, up to you', () => {
    const onSelect = vi.fn();
    render(<MissionControlBoard mc={fixture()} now={NOW} selected="writer" onSelect={onSelect} />);
    expect(screen.getByTestId('wait-chain').textContent).toBe('Waiting chain: Writer → Content Head → You');
    expect(screen.getByTestId('node-content').dataset.lit).toBe('true');
    expect(screen.getByTestId('node-editor').dataset.lit).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Rep: Erroring' }));
    expect(onSelect).toHaveBeenCalledWith('rep');
  });

  it('phone width: an indented list, no sideways tree', () => {
    render(<MissionControlBoard mc={fixture()} now={NOW} narrow onSelect={() => {}} />);
    expect(screen.queryByTestId('mission-tree')).toBeNull();
    const items = within(screen.getByTestId('mission-list')).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('[data-testid^="node-"]')!.getAttribute('data-testid'))).toEqual(['node-chief', 'node-content', 'node-editor', 'node-writer', 'node-sales', 'node-rep']);
    expect(items[0].style.paddingLeft).toBe('0px');
    expect(items[2].style.paddingLeft).toBe('28px');
  });
});

describe('the helpers', () => {
  it('subtree, matching, the forest and its flat form', () => {
    const mc = fixture();
    expect([...subtreeOf(mc.nodes, 'content')].sort()).toEqual(['content', 'editor', 'writer']);
    expect([...matching(mc, { ...NO_FILTER, only: 'blocked' })].sort()).toEqual(['content', 'writer']);
    const forest = buildForest(mc.nodes, matching(mc, { ...NO_FILTER, only: 'error' }));
    expect(forest.map((t) => t.node.agentId)).toEqual(['chief']);
    expect(forest[0].children.map((t) => t.node.agentId)).toEqual(['sales']);
    const full = buildForest(mc.nodes);
    expect(full[0].children.map((t) => t.node.agentId)).toEqual(['content', 'sales']); // leads with reports first, then by name
    expect(flattenForest(full, new Set(['content'])).map((r) => `${r.depth}:${r.node.agentId}`)).toEqual(['0:chief', '1:content', '1:sales', '2:rep']);
  });

  it('waiting chains, the totals line, a node in words', () => {
    const mc = fixture();
    expect(waitChain(mc.edges, 'writer')).toEqual(['writer', 'content', 'ceo']);
    expect(waitChain([{ from: 'a', to: 'b', taskId: '', title: '' }, { from: 'b', to: 'a', taskId: '', title: '' }], 'a')).toEqual(['a', 'b']);
    expect([...chainHighlight(mc.edges, 'content')].sort()).toEqual(['ceo', 'content', 'writer']);
    expect(chainHighlight(mc.edges, 'editor').size).toBe(0);
    expect(totalsLine(mc.totals)).toBe('1 erroring, 2 blocked, 2 working, 1 idle');
    expect(nodeLine(node('x', 'X', null, { state: 'paused', memberStatus: 'active' }))).toBe('The company is paused');
    expect(nodeLine(node('x', 'X', null))).toBe('Nothing in progress');
  });
});
