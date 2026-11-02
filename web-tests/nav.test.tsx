/** The main menu and the Company rail: Artifacts is a main item; Inbox
 *  (with the combined badge) and Company show only in organization mode;
 *  the Company rail groups its panes (collapse kept per viewer); the removed
 *  panes (Ask, Playbooks, Metrics, Experiments, Outcomes, Evals) and the
 *  panes that moved (Approvals, My tasks → Inbox; Brief, Capital, Replay →
 *  tabs) are not rail entries; deep links route to their new home. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgApproval, OrgPlan, OrgTask } from '../src/lib/api';
import { buildInbox, filterInbox, inboxBadge, paneHome, tabsOf, COMPANY_GROUPS } from '../src/lib/inbox';

afterEach(cleanup);

// A mutable fake of the store: each test sets what it needs.
const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const { ActivityBar, BottomNav } = await import('../src/components/Shell');
const { WorkspaceRail } = await import('../src/components/Rails');

function orgOn(extra: Record<string, unknown> = {}) {
  Object.assign(fake, {
    section: 'overview', go: vi.fn(), theme: 'dark', toggleTheme: vi.fn(),
    companiesEnabled: true,
    wsOrg: { mode: 'supervised', orgStatus: 'active', orgId: 'o1', pendingApprovals: 2, units: [] },
    orgHeldActions: 1, orgPendingPlans: 1, orgMyTasks: 3,
    orgHealth: { openIncidents: [{ id: 'i1', kind: 'error_rate', severity: 'major', status: 'open', title: 'Spike', agentId: null, openedAt: '2026-11-01T00:00:00Z' }, { id: 'i2', kind: 'x', severity: 'minor', status: 'contained', title: 'Old', agentId: null, openedAt: '2026-10-01T00:00:00Z' }] },
    orgPane: null, orgUnitId: null, setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(),
    orgIntent: [], orgCadences: [], agents: [], channels: [], homeView: 'chat', currentChannel: null,
    ...extra,
  });
}

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  try { localStorage.clear(); } catch { /* jsdom */ }
});

describe('main menu', () => {
  it('shows Inbox (with the combined badge), Company and Artifacts in organization mode', () => {
    orgOn();
    render(<ActivityBar />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter(Boolean);
    expect(labels).toEqual(['Home', 'Chat', 'Inbox', 'Company', 'Artifacts', 'Apps', 'Market']);
    // 2 cards + 1 key + 1 plan + 1 open (uncontained) incident + 3 tasks
    expect(within(screen.getByRole('button', { name: 'Inbox' })).getByTestId('inbox-badge')).toHaveTextContent('8');
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
    expect(fake.go).toHaveBeenCalledWith('artifacts');
  });

  it('hides Inbox and Company when organization mode is off; Artifacts stays', () => {
    orgOn({ wsOrg: { mode: 'off', pendingApprovals: 0 } });
    render(<BottomNav />);
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Home', 'Chat', 'Artifacts', 'Apps', 'Market', 'Settings']);
    expect(screen.queryByTestId('inbox-badge')).toBeNull();
  });

  it('has no badge when nothing waits', () => {
    orgOn({ wsOrg: { mode: 'autonomous', pendingApprovals: 0, units: [] }, orgHeldActions: 0, orgPendingPlans: 0, orgMyTasks: 0, orgHealth: null });
    render(<BottomNav />);
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-badge')).toBeNull();
  });
});

describe('the Company rail', () => {
  it('groups the panes and leaves out the removed and moved ones', () => {
    orgOn({ section: 'workspace' });
    render(<WorkspaceRail />);
    for (const g of ['teams', 'direction', 'operations', 'people', 'oversight']) expect(screen.getByTestId(`company-group-${g}`)).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    for (const gone of ['Ask', 'Playbooks', 'Metrics', 'Experiments', 'Outcomes', 'Evals', 'Approvals', 'My tasks', 'Brief', 'Capital', 'Replay']) expect(text).not.toContain(gone);
    for (const here of ['Vision', 'Goals', 'Plans', 'Decisions', 'Pulse', 'Meetings', 'Incidents', 'Org chart', 'Spend', 'Audit']) expect(text).toContain(here);
    // no header chips any more: the counts moved to the Inbox
    expect(text).not.toMatch(/\d+ keys?|\d+ plans?\b|\d+ incidents?/);
    fireEvent.click(screen.getByText('Spend'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('spend');
  });

  it('collapses a group and remembers it per viewer', () => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, clear: () => mem.clear() });
    orgOn({ section: 'workspace' });
    const { unmount } = render(<WorkspaceRail />);
    fireEvent.click(screen.getByTestId('company-group-oversight'));
    expect(screen.queryByText('Audit')).toBeNull();
    unmount();
    render(<WorkspaceRail />);
    expect(screen.queryByText('Audit')).toBeNull();
    expect(screen.getByTestId('company-group-oversight')).toHaveAttribute('aria-expanded', 'false');
    vi.unstubAllGlobals();
  });

  it('works without storage', () => {
    orgOn({ section: 'workspace' });
    const blocked = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, clear: blocked });
    render(<WorkspaceRail />);
    fireEvent.click(screen.getByTestId('company-group-direction'));
    expect(screen.queryByText('Vision')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('routing and the Inbox list', () => {
  it('sends approvals and my tasks to the Inbox; merged panes open on their tab', () => {
    expect(paneHome('approvals')).toEqual({ section: 'inbox', filter: 'approvals' });
    expect(paneHome('mytasks')).toEqual({ section: 'inbox', filter: 'mytasks' });
    expect(paneHome('capital')).toEqual({ section: 'workspace', pane: 'capital' });
    expect(tabsOf('brief')).toEqual(['pulse', 'brief']);
    expect(tabsOf('capital')).toEqual(['spend', 'capital']);
    expect(tabsOf('replay')).toEqual(['audit', 'replay']);
    expect(tabsOf('vision')).toBeNull();
    const panes = COMPANY_GROUPS.flatMap((g) => g.entries.map((e) => e.pane));
    expect(panes).not.toContain('approvals');
    expect(panes).not.toContain('mytasks');
  });

  it('builds one list: cards, escalations, the keys row, plans, my tasks, open incidents', () => {
    const appr = (id: string, kind: string, payload: Record<string, unknown>, createdAt: string, status = 'pending') => ({ id, kind, payload: JSON.stringify(payload), status, createdAt, recommendation: '' }) as unknown as OrgApproval;
    const items = buildInbox({
      approvals: [appr('a1', 'hire', { name: 'Ada' }, '2026-11-01T10:00:00Z'), appr('a2', 'escalation', { title: 'Ship it', reason: 'blocked' }, '2026-11-01T12:00:00Z'), appr('a3', 'two_key', {}, '2026-11-01T11:00:00Z'), appr('a4', 'hire', {}, '2026-11-01T09:00:00Z', 'approved')],
      plans: [{ id: 'p1', status: 'pending', summary: 'Hire a writer', trigger: 't', createdAt: '2026-11-01T08:00:00Z', applyAt: null } as unknown as OrgPlan],
      tasks: { assigned: [{ id: 't1', title: 'Write copy', status: 'todo', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' } as OrgTask, { id: 't2', title: 'Done one', status: 'done', createdAt: '', updatedAt: '' } as OrgTask], reviewing: [] },
      incidents: [{ id: 'i1', kind: 'error_rate', severity: 'major', status: 'open', title: 'Spike', agentId: null, openedAt: '2026-11-01T13:00:00Z' }, { id: 'i2', kind: 'x', severity: 'minor', status: 'contained', title: 'Old', agentId: null, openedAt: '2026-10-01T00:00:00Z' }],
      heldActions: 2,
    });
    expect(items.map((i) => i.kind)).toEqual(['keys', 'incidents', 'escalations', 'approvals', 'plans', 'mytasks']);
    expect(items[0].title).toBe('2 actions waiting for your key');
    expect(items.find((i) => i.kind === 'approvals')?.title).toBe('hire: Ada');
    expect(items.find((i) => i.kind === 'escalations')?.title).toBe('Escalation: Ship it');
    expect(filterInbox(items, 'plans').map((i) => i.refId)).toEqual(['p1']);
    expect(inboxBadge({ pendingApprovals: 1, heldActions: 2, pendingPlans: 3, openIncidents: 4, myTasks: 5 })).toBe(15);
  });
});
