/** The two-layer Market (docs/agent-catalog.md "Segments and functions"):
 *  the Personal | Business switch in the rail and the header, function pages
 *  with the head first, search across both segments with a segment badge,
 *  deep links, the remembered choice, and the business hire choice — into
 *  the company (a hire card via the catalog role) or standalone. */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type MarketItem, type OrgMember } from '../src/lib/api';
import {
  bizFunctions, cadenceLine, defaultReportsTo, defaultSegment, functionPage, loadSegment, marketCats, navFromUrl, navQuery, reportsToName,
  saveSegment, searchMarket, SEGMENT_KEY, useMarketNav,
} from '../src/lib/market';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none', gradPair: () => 'none' }));

const { MarketView, HireModal } = await import('../src/components/MarketView');
const { MarketRail } = await import('../src/components/Rails');

const item = (over: Partial<MarketItem>): MarketItem => ({
  id: 'x', name: 'X', emoji: '🙂', role: 'X', colors: ['#111', '#222'], author: 'yaam', verified: true, stars: '5.0', installs: 'curated pack',
  cat: 'Business', price: 'free', tagline: '', caps: ['fs'], capsFull: [], loops: [], hired: false, skills: [{ name: 's1', description: '' }], ...over,
});

const MARKET: MarketItem[] = [
  item({ id: 'pack-chief-of-staff', name: 'Chief of Staff', role: 'Chief of staff', segment: 'business', function: 'leadership', level: 'leadership', orgHire: null, loops: [{ name: 'Operating-system sweep', cron: '30 7 * * 1-5' }] }),
  item({ id: 'pack-auditor', name: 'Auditor', role: 'Auditor', segment: 'business', function: 'leadership', level: 'leadership', orgHire: 'pack-auditor' }),
  item({ id: 'pack-biz-finance-manager', name: 'Head of Finance', role: 'Head of Finance', tagline: 'Finance · Runs month-end close.', segment: 'business', function: 'finance', level: 'head', reportsTo: 'pack-chief-of-staff', orgHire: 'role:finance-manager', kpis: ['days to close', 'forecast accuracy', 'DSO', 'runway'], cadence: 'weekly review (Mon), close (WD1-5), report (Fri)', loops: [{ name: 'Monday finance review', cron: '0 9 * * 1' }] }),
  item({ id: 'pack-biz-finance-fpa', name: 'FP&A Analyst', role: 'FP&A Analyst (Finance)', tagline: 'Finance · Forecasts and variance.', segment: 'business', function: 'finance', level: 'specialist', reportsTo: 'pack-biz-finance-manager', orgHire: 'role:finance-fpa', kpis: ['forecast accuracy'], cadence: 'monthly reforecast' }),
  item({ id: 'pack-biz-finance-accountant', name: 'Staff Accountant', role: 'Staff Accountant (Finance)', segment: 'business', function: 'finance', level: 'specialist', reportsTo: 'pack-biz-finance-manager', orgHire: 'role:finance-accountant' }),
  item({ id: 'pro-finance', name: 'Bookkeeper', role: 'Finance & Accounting', cat: 'Legal & Finance', author: 'Anthropic · knowledge-work-plugins', segment: 'business', function: 'finance', level: 'specialist', orgHire: 'pro-finance' }),
  item({ id: 'pack-biz-sales-manager', name: 'Head of Sales', role: 'Head of Sales', segment: 'business', function: 'sales', level: 'head', reportsTo: 'pack-chief-of-staff', orgHire: 'role:sales-manager' }),
  item({ id: 'pack-trip-planner', name: 'Trip Planner', role: 'Travel', cat: 'Events & Travel', tagline: 'Your trips, planned.', segment: 'personal' }),
  item({ id: 'pack-educator', name: 'Educator', role: 'Teaching', cat: 'Education', tagline: 'Teaching prep that respects your evening — finance class included.', segment: 'personal' }),
  // a registry-style item with no segment counts as personal
  item({ id: 'legacy', name: 'Legacy Helper', role: 'Helper', cat: 'Workplace' }),
];

const member = (agentId: string, title: string, reportsToAgentId: string | null = null): OrgMember => ({
  id: `m-${agentId}`, orgId: 'o1', agentId, title, reportsToAgentId, depth: reportsToAgentId ? 2 : 1, sponsor: '', scopes: '[]', status: 'active', charterHash: '', joinedAt: '',
});

function setFake(opts: { orgOn: boolean; stacked?: boolean }) {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    market: MARKET, stacked: opts.stacked ?? false, companiesEnabled: true, go: vi.fn(), setHireId: vi.fn(), hireId: null, confirmHire: vi.fn(async () => {}),
    showToast: vi.fn(), refreshWsOrg: vi.fn(async () => {}), refreshMcp: vi.fn(async () => {}), mcp: [],
    agents: [{ id: 'chief', name: 'Chief' }, { id: 'hof', name: 'Head of Finance' }],
    wsOrg: opts.orgOn
      ? { workspaceId: 'ws1', mode: 'supervised', chiefOfStaffAgentId: 'chief', orgId: 'o1', pendingApprovals: 0, units: [], org: { members: [member('chief', 'Chief of staff'), member('hof', 'Head of Finance', 'chief')] } }
      : { workspaceId: 'ws1', mode: 'off', chiefOfStaffAgentId: null, orgId: null, pendingApprovals: 0, units: [], org: null },
  });
}

/** The rail and the view on one navigation state, as App.tsx wires them. */
function Market({ orgOn }: { orgOn: boolean }) {
  const { nav, setNav } = useMarketNav(orgOn);
  return <><MarketRail nav={nav} setNav={setNav} /><MarketView nav={nav} setNav={setNav} /></>;
}

const setUrl = (search: string) => window.history.replaceState(null, '', `/${search}`);

/** A working localStorage per test (the runtime's own may be absent). */
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  setUrl('');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('market helpers', () => {
  it('groups business packs by function with counts and the head; personal categories exclude business', () => {
    const fns = bizFunctions(MARKET);
    expect(fns.map((f) => [f.id, f.count])).toEqual([['leadership', 2], ['sales', 1], ['finance', 4]]);
    expect(fns.find((f) => f.id === 'finance')!.head!.id).toBe('pack-biz-finance-manager');
    expect(marketCats(MARKET)).toEqual(['All', 'Workplace', 'Education', 'Events & Travel']);
  });

  it('builds a function page: the head, its team, then the rest of the function', () => {
    const page = functionPage(MARKET, 'finance');
    expect(page.head!.name).toBe('Head of Finance');
    expect(page.team.map((m) => m.name)).toEqual(['FP&A Analyst', 'Staff Accountant']);
    expect(page.others.map((m) => m.name)).toEqual(['Bookkeeper']);
    expect(functionPage(MARKET, 'leadership').head).toBeNull();
    expect(reportsToName(page.team[0], MARKET)).toBe('Head of Finance');
    expect(reportsToName(MARKET[0], MARKET)).toBe('the CEO');
    expect(cadenceLine(MARKET[0])).toBe('Operating-system sweep');
    expect(cadenceLine(page.head!)).toMatch(/weekly review/);
  });

  it('searches both segments: name, role, tagline and function', () => {
    expect(searchMarket(MARKET, 'finance').map((m) => m.id)).toEqual(['pack-biz-finance-manager', 'pack-biz-finance-fpa', 'pack-biz-finance-accountant', 'pro-finance', 'pack-educator']);
    expect(searchMarket(MARKET, 'trip').map((m) => m.id)).toEqual(['pack-trip-planner']);
  });

  it('reads deep links and writes them back', () => {
    expect(navFromUrl('?section=market&segment=business&fn=finance')).toEqual({ segment: 'business', fn: 'finance' });
    expect(navFromUrl('?section=market&fn=sales')).toEqual({ fn: 'sales', segment: 'business' });
    expect(navFromUrl('?section=market&cat=Education')).toEqual({ cat: 'Education', segment: 'personal' });
    expect(navFromUrl('?section=settings&segment=business')).toBeNull();
    expect(navQuery({ segment: 'business', cat: 'All', fn: 'finance' })).toBe('?section=market&segment=business&fn=finance');
  });

  it('defaults to Business for a company, Personal otherwise; a stored choice or deep link wins; blocked storage is harmless', () => {
    expect(defaultSegment(undefined, null, true)).toBe('business');
    expect(defaultSegment(undefined, null, false)).toBe('personal');
    expect(defaultSegment(undefined, 'personal', true)).toBe('personal');
    expect(defaultSegment('business', 'personal', false)).toBe('business');
    saveSegment('business');
    expect(localStorage.getItem(SEGMENT_KEY)).toBe('business');
    expect(loadSegment()).toBe('business');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(loadSegment()).toBeNull();
    expect(() => saveSegment('personal')).not.toThrow();
  });

  it('a specialist hired into the company reports to its function head when the company has one, else the chief', () => {
    const members = [member('chief', 'Chief of staff'), member('hof', 'Head of Finance', 'chief')];
    expect(defaultReportsTo(MARKET[3], MARKET, members, 'chief')).toBe('hof');
    expect(defaultReportsTo(MARKET[2], MARKET, members, 'chief')).toBe('chief');
    expect(defaultReportsTo(MARKET[3], MARKET, [member('chief', 'Chief of staff')], 'chief')).toBe('chief');
  });
});

describe('useMarketNav', () => {
  it('follows the company until the viewer chooses, then remembers the choice', () => {
    const { result, rerender } = renderHook(({ on }) => useMarketNav(on), { initialProps: { on: false } });
    expect(result.current.nav.segment).toBe('personal');
    rerender({ on: true }); // the company status arrives after the first render
    expect(result.current.nav.segment).toBe('business');
    act(() => result.current.setNav({ segment: 'personal' }));
    expect(localStorage.getItem(SEGMENT_KEY)).toBe('personal');
    rerender({ on: false }); rerender({ on: true });
    expect(result.current.nav.segment).toBe('personal');
  });

  it('starts from the stored choice, and a deep link beats it', () => {
    localStorage.setItem(SEGMENT_KEY, 'personal');
    expect(renderHook(() => useMarketNav(true)).result.current.nav.segment).toBe('personal');
    setUrl('?section=market&segment=business&fn=finance');
    const { result } = renderHook(() => useMarketNav(false));
    expect(result.current.nav).toEqual({ segment: 'business', cat: 'All', fn: 'finance' });
  });
});

describe('Market view', () => {
  it('switches segments from the rail and the header; personal shows its categories, business its functions with counts', () => {
    setFake({ orgOn: false });
    render(<Market orgOn={false} />);
    const [railTabs, headerTabs] = screen.getAllByRole('tablist', { name: 'Market segment' });
    expect(within(railTabs).getByRole('tab', { name: /Personal/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(railTabs).getByRole('tab', { name: /Personal/ })).toHaveTextContent('3');
    expect(within(railTabs).getByRole('tab', { name: /Business/ })).toHaveTextContent('7');
    expect(screen.getByTestId('market-card-pack-trip-planner')).toBeInTheDocument();
    expect(screen.queryByTestId('market-card-pack-biz-finance-manager')).toBeNull();
    fireEvent.click(within(headerTabs).getByRole('tab', { name: /Business/ }));
    expect(within(railTabs).getByRole('tab', { name: /Business/ })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem(SEGMENT_KEY)).toBe('business');
    // the rail lists the functions with their counts
    expect(screen.getAllByRole('button', { name: /Finance\s*4/ }).length).toBeGreaterThan(0);
    // the overview: a tile per function; org off explains the standalone hire
    expect(screen.getByRole('button', { name: 'Finance: 4 agents' })).toBeInTheDocument();
    expect(screen.getByText(/does not run a company yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('market-card-pack-trip-planner')).toBeNull();
  });

  it('a function page shows the head prominently first, then its team with reports-to and KPIs', () => {
    setFake({ orgOn: true });
    render(<Market orgOn />);
    fireEvent.click(screen.getByRole('button', { name: 'Finance: 4 agents' }));
    const page = screen.getByRole('region', { name: 'Finance function' });
    expect(within(page).getByText('Hire the Head of Finance — it can hire its own team')).toBeInTheDocument();
    const cards = within(page).getAllByTestId(/^market-card-/).map((c) => c.getAttribute('data-testid'));
    expect(cards).toEqual(['market-card-pack-biz-finance-manager', 'market-card-pack-biz-finance-fpa', 'market-card-pack-biz-finance-accountant', 'market-card-pro-finance']);
    const fpa = screen.getByTestId('market-card-pack-biz-finance-fpa');
    expect(fpa).toHaveTextContent('reports to Head of Finance');
    expect(fpa).toHaveTextContent('forecast accuracy');
    expect(fpa).toHaveTextContent('monthly reforecast');
    expect(screen.getByTestId('market-card-pack-biz-finance-manager')).toHaveTextContent('1 loop');
    expect(within(page).getByText(/The team · reports to Head of Finance/)).toBeInTheDocument();
    expect(within(page).getByText('Also in Finance')).toBeInTheDocument();
  });

  it('opens a deep-linked function page', () => {
    setUrl('?section=market&segment=business&fn=finance');
    setFake({ orgOn: false });
    render(<Market orgOn={false} />);
    expect(screen.getByRole('region', { name: 'Finance function' })).toBeInTheDocument();
  });

  it('search spans both segments and badges each result', () => {
    setFake({ orgOn: true });
    render(<Market orgOn />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the market' }), { target: { value: 'finance' } });
    expect(screen.getByText(/5 results · 1 personal · 4 business/)).toBeInTheDocument();
    expect(within(screen.getByTestId('market-card-pack-educator')).getByText('Personal')).toBeInTheDocument();
    expect(within(screen.getByTestId('market-card-pack-biz-finance-fpa')).getByText('Business')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search the market' }), { target: { value: 'zzz' } });
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('on a phone the cards stack in one column', () => {
    setFake({ orgOn: true, stacked: true });
    const { container } = render(<Market orgOn />);
    fireEvent.click(screen.getByRole('button', { name: 'Finance: 4 agents' }));
    expect(container.querySelectorAll('[data-cols="1"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-cols="2"]').length).toBe(0);
  });
});

describe('the business hire choice', () => {
  beforeEach(() => { vi.spyOn(api, 'marketPackSkills').mockResolvedValue([]); });

  it('with a company: "Hire into the company" proposes a hire card by catalog role, under the function head', async () => {
    setFake({ orgOn: true });
    fake.hireId = 'pack-biz-finance-fpa';
    const propose = vi.spyOn(api, 'proposeOrgApproval').mockResolvedValue({} as never);
    render(<HireModal />);
    expect(screen.getByRole('radio', { name: /Hire into the company/ })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Reports to' })).toHaveValue('hof');
    fireEvent.click(screen.getByRole('button', { name: 'Propose the hire' }));
    await waitFor(() => expect(propose).toHaveBeenCalled());
    expect(propose).toHaveBeenCalledWith('ws1', expect.objectContaining({ kind: 'hire', payload: { templateOrPack: 'role:finance-fpa', name: 'FP&A Analyst', reportsToAgentId: 'hof' } }));
    expect(fake.confirmHire).not.toHaveBeenCalled();
    expect(fake.setHireId).toHaveBeenCalledWith(null);
  });

  it('with a company: "Add as a standalone agent" uses the ordinary hire', async () => {
    setFake({ orgOn: true });
    fake.hireId = 'pack-biz-finance-manager';
    const propose = vi.spyOn(api, 'proposeOrgApproval').mockResolvedValue({} as never);
    render(<HireModal />);
    fireEvent.click(screen.getByRole('radio', { name: /Add as a standalone agent/ }));
    // the loops warning returns for a standalone hire
    expect(screen.getByText(/Scheduled loops enable immediately/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve & hire' }));
    await waitFor(() => expect(fake.confirmHire).toHaveBeenCalled());
    expect(propose).not.toHaveBeenCalled();
  });

  it('without a company: standalone only, with a hint to start one', () => {
    setFake({ orgOn: false });
    fake.hireId = 'pack-biz-finance-manager';
    render(<HireModal />);
    expect(screen.queryByRole('radio', { name: /Hire into the company/ })).toBeNull();
    expect(screen.getByRole('radio', { name: /Add as a standalone agent/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Start a company' }));
    expect(fake.go).toHaveBeenCalledWith('workspace');
  });

  it('a personal pack has no hire choice', () => {
    setFake({ orgOn: true });
    fake.hireId = 'pack-trip-planner';
    render(<HireModal />);
    expect(screen.queryByRole('radiogroup', { name: 'How to hire' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve & hire' })).toBeInTheDocument();
  });
});
