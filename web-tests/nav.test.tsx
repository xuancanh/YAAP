/** The main menu and the company sections (docs/company-vision.md §8 "On
 *  screen"): in organization mode the menu is Home · Inbox · Chat, the five
 *  company sections (Direction, Operations, People, Money, Oversight), then
 *  Artifacts · Apps · Foundry, with Settings at the foot; Inbox and the
 *  sections hide when the mode is off. Each section's rail is its dashboard
 *  then its pages; every page lives in exactly one section, what waits on
 *  the CEO in the Inbox. The phone bar folds the sections into a Company
 *  sheet and the rest into More. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxView, itemsOf, NEEDS_CHIPS } from '../src/lib/feed';
import { primeFeed } from '../src/lib/feed-store';
import { feedItem, feedPage } from './feed-fixtures';
import { COMPANY_SECTIONS, COMPANY_SECTION_IDS, paneHome, sectionOfPane } from '../src/lib/company-nav';
import { ORG_PANES } from '../src/store';

afterEach(cleanup);

// A mutable fake of the store: each test sets what it needs.
const fake: Record<string, unknown> = {};
vi.mock('../src/store', async (orig) => ({ ...(await orig<typeof import('../src/store')>()), useApp: () => fake, grad: () => 'none' }));

const { ActivityBar, BottomNav } = await import('../src/components/Shell');
const { CompanyRail } = await import('../src/components/Rails');

function orgOn(extra: Record<string, unknown> = {}) {
  Object.assign(fake, {
    section: 'overview', go: vi.fn(), theme: 'dark', toggleTheme: vi.fn(),
    companiesEnabled: true,
    wsOrg: { mode: 'supervised', orgStatus: 'active', orgId: 'o1', pendingApprovals: 2, units: [], org: { name: 'Acme' } },
    orgHeldActions: 1, orgPendingPlans: 1, orgMyTasks: 3,
    orgHealth: { openIncidents: [{ id: 'i1', kind: 'error_rate', severity: 'major', status: 'open', title: 'Spike', agentId: null, openedAt: '2026-11-01T00:00:00Z' }, { id: 'i2', kind: 'x', severity: 'minor', status: 'contained', title: 'Old', agentId: null, openedAt: '2026-10-01T00:00:00Z' }] },
    orgPane: null, orgUnitId: null, setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(),
    orgIntent: [], orgCadences: [], agents: [], channels: [], homeView: 'chat', currentChannel: null, workspaceId: 'ws1',
    ...extra,
  });
}

/** The owner's feed the badge reads: eight open items in Needs you, two unread updates. */
const needs = (n: number) => Array.from({ length: n }, (_, i) => feedItem({ id: `need:${i}`, ids: [`need:${i}`], type: 'decision', section: 'needs', actionable: true, read: i % 2 === 0 }));
function seedFeed() {
  primeFeed(feedPage([...needs(8), feedItem({ id: 'event:u1', ids: ['event:u1'], type: 'follow', section: 'updates' }), feedItem({ id: 'event:u2', ids: ['event:u2'], type: 'trust', section: 'updates' })]), 'ws1');
}

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
});

const labels = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')).filter((l) => l && l !== 'Theme');

describe('main menu', () => {
  it('in organization mode: Home · Inbox · Chat, the five company sections, Artifacts · Apps · Foundry, Settings', () => {
    orgOn();
    seedFeed();
    render(<ActivityBar />);
    expect(labels()).toEqual(['Home', 'Inbox', 'Chat', 'Direction', 'Operations', 'People', 'Money', 'Oversight', 'Artifacts', 'Apps', 'Foundry', 'Settings']);
    // the company sections are one visual group
    expect(within(screen.getByTestId('nav-group-company')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Direction', 'Operations', 'People', 'Money', 'Oversight']);
    // the badge is the feed's Needs you, read or not (the bell counts unread rows: 4 + 2 here)
    const badge = within(screen.getByRole('button', { name: 'Inbox' })).getByTestId('inbox-badge');
    expect(badge).toHaveTextContent('8');
    expect(badge).toHaveAttribute('title', '8 need you');
    // Operations carries the open-incident dot (the contained one does not count)
    expect(screen.getByTestId('nav-dot-operations')).toHaveAttribute('title', '1 open incident');
    fireEvent.click(screen.getByRole('button', { name: 'Money' }));
    expect(fake.go).toHaveBeenCalledWith('money');
  });

  it('marks the current section; the legacy Company id reads as Operations', () => {
    orgOn({ section: 'workspace' });
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-current', 'page');
    cleanup();
    orgOn({ section: 'people' });
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Operations' })).not.toHaveAttribute('aria-current');
  });

  it('hides Inbox and the company sections when organization mode is off; Artifacts stays', () => {
    orgOn({ wsOrg: { mode: 'off', pendingApprovals: 0 } });
    render(<BottomNav />);
    expect(labels()).toEqual(['Home', 'Chat', 'Artifacts', 'Apps', 'Foundry', 'Settings']);
    expect(screen.queryByTestId('inbox-badge')).toBeNull();
    cleanup();
    orgOn({ wsOrg: { mode: 'off', pendingApprovals: 0 } });
    render(<ActivityBar />);
    expect(screen.queryByTestId('nav-group-company')).toBeNull();
  });

  it('has no badge and no dot when nothing waits', () => {
    orgOn({ wsOrg: { mode: 'autonomous', pendingApprovals: 0, units: [] }, orgHeldActions: 0, orgPendingPlans: 0, orgMyTasks: 0, orgHealth: null });
    // unread updates do not badge the Inbox: only what needs you does
    primeFeed(feedPage([feedItem({ id: 'event:u1', ids: ['event:u1'], type: 'follow', section: 'updates' })]), 'ws1');
    render(<ActivityBar />);
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-badge')).toBeNull();
    expect(screen.queryByTestId('nav-dot-operations')).toBeNull();
  });
});

describe('the phone bar', () => {
  it('keeps five targets: the sections fold into Company, the rest into More', () => {
    orgOn();
    render(<BottomNav />);
    expect(labels()).toEqual(['Home', 'Inbox', 'Chat', 'Company', 'More']);
    expect(screen.getByTestId('nav-dot-company')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Company' }));
    const sheet = screen.getByTestId('nav-sheet-company');
    expect(within(sheet).getAllByRole('menuitem').map((b) => b.getAttribute('aria-label'))).toEqual(['Direction', 'Operations', 'People', 'Money', 'Oversight']);
    fireEvent.click(within(sheet).getByRole('menuitem', { name: 'Oversight' }));
    expect(fake.go).toHaveBeenCalledWith('oversight');
    expect(screen.queryByTestId('nav-sheet-company')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(within(screen.getByTestId('nav-sheet-more')).getAllByRole('menuitem').map((b) => b.getAttribute('aria-label'))).toEqual(['Artifacts', 'Apps', 'Foundry', 'Settings']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('nav-sheet-more')).toBeNull();
  });

  it('lights Company while a company section is open', () => {
    orgOn({ section: 'money' });
    render(<BottomNav />);
    expect(screen.getByRole('button', { name: 'Company' })).toHaveStyle({ color: 'var(--accent)' });
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveStyle({ color: 'var(--accent)' });
  });
});

describe('a company section rail', () => {
  it('is the dashboard then the section’s own pages, nothing else', () => {
    orgOn({ section: 'direction' });
    render(<CompanyRail section="direction" />);
    const rail = screen.getByTestId('company-rail-direction');
    expect(within(rail).getAllByRole('button').map((b) => b.textContent)).toEqual(['Overview', 'Vision', 'Alignment', 'Goals', 'Roadmap', 'Decisions']);
    const text = rail.textContent ?? '';
    for (const gone of ['Pending changes', 'Approvals', 'My tasks', 'Board', 'Incidents', 'Spend', 'Audit']) expect(text).not.toContain(gone);
    expect(screen.getByTestId('company-page-overview')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByTestId('company-page-goals'));
    expect(fake.setOrgPane).toHaveBeenCalledWith('goals');
    fireEvent.click(screen.getByTestId('company-page-overview'));
    expect(fake.go).toHaveBeenCalledWith('direction');
  });

  it('marks the open page and badges open incidents and goals at risk', () => {
    orgOn({ section: 'operations', orgPane: 'incidents' });
    render(<CompanyRail section="operations" />);
    expect(screen.getByTestId('company-page-incidents')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('company-page-incidents')).toHaveTextContent('1');
    cleanup();
    orgOn({ section: 'direction', orgIntent: [{ id: 'g1', atRisk: 1, children: [{ id: 'g2', atRisk: 1, children: [] }] }] });
    render(<CompanyRail section="direction" />);
    expect(screen.getByTestId('company-page-goals')).toHaveTextContent('2');
  });

  it('points to Settings › Company when organization mode is off', () => {
    orgOn({ wsOrg: { mode: 'off', pendingApprovals: 0 } });
    render(<CompanyRail section="people" />);
    expect(document.body.textContent).toContain('Settings › Company');
  });
});

describe('where each page lives', () => {
  it('puts every company page in exactly one section', () => {
    const pages = COMPANY_SECTIONS.flatMap((s) => s.pages.map((p) => p.pane));
    expect(new Set(pages).size).toBe(pages.length);
    expect(COMPANY_SECTIONS.map((s) => s.id)).toEqual(COMPANY_SECTION_IDS);
    // every pane is a section page or opens in the Inbox — none is orphaned
    for (const pane of ORG_PANES) {
      const home = paneHome(pane);
      if (home.section === 'inbox') expect(pages).not.toContain(pane);
      else expect(COMPANY_SECTIONS.filter((s) => s.pages.some((p) => p.pane === pane)).map((s) => s.id)).toEqual([home.section]);
    }
  });

  it('sends what waits on you to the Inbox and old pane ids to their new section', () => {
    expect(paneHome('approvals')).toEqual({ section: 'inbox', filter: 'approvals' });
    expect(paneHome('mytasks')).toEqual({ section: 'inbox', filter: 'mytasks' });
    expect(paneHome('plans')).toEqual({ section: 'inbox', filter: 'plans' });
    const at = (p: Parameters<typeof paneHome>[0]) => paneHome(p).section;
    expect([at('vision'), at('goals'), at('roadmap'), at('decisions')]).toEqual(['direction', 'direction', 'direction', 'direction']);
    expect([at('board'), at('pulse'), at('brief'), at('meetings'), at('incidents')]).toEqual(['operations', 'operations', 'operations', 'operations', 'operations']);
    expect([at('chart'), at('teams')]).toEqual(['people', 'people']);
    expect([at('spend'), at('capital')]).toEqual(['money', 'money']);
    expect([at('audit'), at('replay')]).toEqual(['oversight', 'oversight']);
    expect(sectionOfPane('approvals')).toBeUndefined();
  });
});

describe('the Inbox list', () => {
  it('a stored filter lands on its tab and chip: old deep links, Home and dashboards keep working', () => {
    expect(inboxView('all')).toEqual({ tab: 'needs', chip: 'needs' });
    expect(inboxView('approvals')).toEqual({ tab: 'needs', chip: 'approvals' });
    expect(inboxView('plans')).toEqual({ tab: 'needs', chip: 'plans' });
    expect(inboxView('messages')).toEqual({ tab: 'mentions', chip: 'mentions' });
    expect(inboxView('following')).toEqual({ tab: 'updates', chip: 'following' });
    expect(inboxView('history')).toEqual({ tab: 'history', chip: 'history' });
    // the chips with a full queue are the panes that used to live in the company
    expect(NEEDS_CHIPS.filter((c) => c.pane).map((c) => c.pane)).toEqual(['approvals', 'approvals', 'approvals', 'plans', 'mytasks']);
  });

  it('a section lists its rows; a chip narrows Needs you to its kinds', () => {
    const page = feedPage([
      feedItem({ id: 'a', type: 'decision', section: 'needs' }), feedItem({ id: 'b', type: 'pending_change', section: 'needs' }),
      feedItem({ id: 'c', type: 'task_review', section: 'needs' }), feedItem({ id: 'd', type: 'mention', section: 'mentions' }),
    ]);
    expect(itemsOf(page, 'needs').map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(itemsOf(page, 'needs', 'plans').map((i) => i.id)).toEqual(['b']);
    expect(itemsOf(page, 'needs', 'mytasks').map((i) => i.id)).toEqual(['c']);
    expect(itemsOf(page, 'mentions').map((i) => i.id)).toEqual(['d']);
  });
});
