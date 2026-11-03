/** Decision routing in the SPA (docs/owners-seat.md §7): the CEO sees the
 *  route a card climbed ("Writer → Head of Content → Chief → you") with each
 *  manager's recommendation, on Home and in the Inbox; a card a manager still
 *  holds is not in the CEO's list yet. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeData, HomeNeed, OrgApproval } from '../src/lib/api';
import { HomeBoard } from '../src/components/HomeBoard';
import { DecisionChain } from '../src/components/OrganizationView';
import { buildInbox } from '../src/lib/inbox';
import { hopLine, inReviewBelow, managerHops, waitsOnViewer } from '../src/lib/decisions';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const NOW = new Date('2026-11-03T08:00:00');
const iso = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

const hops = [
  { at: iso(-300), action: 'raised', by: 'agent:w', byName: 'Writer', from: '', to: 'agent:h', toName: 'Head of Content' },
  { at: iso(-200), action: 'escalated', by: 'agent:h', byName: 'Head of Content', from: 'agent:h', to: 'agent:c', toName: 'Chief', recommendation: 'approve', reasoning: 'margins are thin' },
  { at: iso(-100), action: 'timed_out', by: 'system', byName: 'System', from: 'agent:c', to: 'ceo', toName: 'CEO', recommendation: '', reasoning: 'no recommendation (timed out)' },
];

const approval = (over: Partial<OrgApproval> = {}): OrgApproval => ({
  id: 'a1', orgId: 'o1', kind: 'escalation', payload: JSON.stringify({ title: 'Price change', taskKey: 'SAL-4', reason: 'raise list price 10%?' }), requestedBy: 'agent:w', recommendation: '',
  status: 'pending', decidedAt: null, decisionNote: '', expiresAt: null, createdAt: iso(-300), holder: 'ceo', forYou: true,
  chainLine: 'Writer → Head of Content → Chief → you', chainHops: hops, reserved: '', ...over,
});

describe('decision routing helpers', () => {
  it('words each manager hop and keeps only the climbing ones', () => {
    expect(managerHops(hops).map((h) => h.action)).toEqual(['escalated', 'timed_out']);
    expect(hopLine(hops[1])).toBe('Head of Content recommends approve — margins are thin');
    expect(hopLine(hops[2])).toBe('A manager did not answer in time — no recommendation');
    expect(hopLine({ action: 'escalated', byName: 'Chief', recommendation: '', reasoning: '' })).toBe('Chief passed it up without a recommendation');
  });
  it('a card a manager still holds is not the viewer\'s yet', () => {
    expect(waitsOnViewer(approval())).toBe(true);
    expect(waitsOnViewer(approval({ forYou: false }))).toBe(false);
    expect(waitsOnViewer(approval({ forYou: undefined }))).toBe(true);
    expect(inReviewBelow([approval(), approval({ forYou: false }), approval({ forYou: false, status: 'approved' })])).toBe(1);
  });
});

describe('the Inbox', () => {
  it('lists only what waits on you, with the route it climbed', () => {
    const items = buildInbox({ approvals: [approval(), approval({ id: 'a2', forYou: false, holder: 'agent:h' })], plans: [], tasks: null, incidents: [], heldActions: 0 });
    expect(items.map((i) => i.refId)).toEqual(['a1']);
    expect(items[0].detail).toContain('Writer → Head of Content → Chief → you');
  });
  it('the approvals card shows the chain and every recommendation', () => {
    render(<DecisionChain a={approval({ reserved: 'raised for a decision only the CEO can make' })} />);
    const chain = screen.getByTestId('decision-chain');
    expect(chain.textContent).toContain('Writer → Head of Content → Chief → you');
    expect(chain.textContent).toContain('CEO-reserved');
    expect(within(chain).getAllByTestId('decision-hop').map((x) => x.textContent)).toEqual(['Head of Content recommends approve — margins are thin', 'A manager did not answer in time — no recommendation']);
  });
  it('a card that came straight to you shows no route', () => {
    const { container } = render(<DecisionChain a={approval({ chainLine: 'Chief → you'.replace(' → you', ''), chainHops: [] })} />);
    expect(container.textContent).toBe('');
  });
});

describe('Home', () => {
  const need = (over: Partial<HomeNeed> = {}): HomeNeed => ({
    id: 'approval:a1', kind: 'escalation', subkind: 'escalation', title: 'task "Price change": raise list price 10%?', detail: '', severity: 'high', createdAt: iso(-300),
    deadline: iso(600), defaultAction: 'deny', recommendation: '', recommendedAction: 'approve', reversibility: 'reversible', confidence: 0.5, requestedBy: 'Writer',
    ref: { approvalId: 'a1' }, actions: ['approve', 'reject'], ...over,
  });
  const data = (needs: HomeNeed[]): HomeData => ({
    workspaceId: 'ws1', generatedAt: NOW.toISOString(), since: iso(-600), firstVisit: false,
    company: { orgId: 'o1', name: 'Acme', mode: 'supervised', status: 'active', chiefAgentId: 'c', chiefName: 'Chief', memberCount: 3 },
    headline: { tasksDone: 0, needsYou: needs.length, todayUsd: 0, monthUsd: 0, monthCapUsd: null }, needs,
    recap: { tasksDone: 0, tasksBlocked: 0, decisionsCount: 0, artifactsChanged: 0, decisions: [], people: [], brief: null, pulse: null },
    goals: [], team: [], activity: [], spend: { todayUsd: 0, monthUsd: 0, monthCapUsd: null, projectedUsd: null, forecastState: null, tokens: null },
    health: { status: 'ok', openIncidents: [], providers: [], audit: null }, upcoming: [], artifacts: [], partial: [],
  } as unknown as HomeData);

  it('a decision card shows the chain it climbed and each manager\'s recommendation', () => {
    const chained = need({ chain: { line: 'Writer → Head of Content → Chief → you', reserved: '', hops: [
      { at: iso(-200), action: 'escalated', by: 'Head of Content', recommendation: 'approve', reasoning: 'margins are thin' },
      { at: iso(-100), action: 'escalated', by: 'Chief', recommendation: 'modify', reasoning: '5% now, 5% next quarter' },
    ] } });
    render(<HomeBoard data={data([chained, need({ id: 'approval:a2', ref: { approvalId: 'a2' } })])} narrow={false} wide now={NOW} name="Linh" onAct={vi.fn()} onOpen={vi.fn()} onAllAgents={vi.fn()} />);
    expect(screen.queryAllByTestId('need-chain')).toHaveLength(0); // folded until the row opens
    for (const b of screen.getAllByRole('button', { name: 'Show details' })) fireEvent.click(b);
    const chains = screen.getAllByTestId('need-chain');
    expect(chains).toHaveLength(1);
    expect(chains[0].textContent).toContain('Writer → Head of Content → Chief → you');
    expect(within(chains[0]).getAllByTestId('need-chain-hop').map((x) => x.textContent)).toEqual(['Head of Content recommends approve — margins are thin', 'Chief recommends changes — 5% now, 5% next quarter']);
  });
});
