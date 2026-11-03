/** The Market's Companies tab (docs/blueprints.md §3a): the first-party
 *  starter blueprints the server lists first are badged "Official" with
 *  their seats and envelope; a published blueprint is not; search goes to
 *  the server and an empty result says so. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type BlueprintImportPlan, type CompanyRegistryItem } from '../src/lib/api';

const fake: Record<string, unknown> = { market: [], stacked: false, companiesEnabled: true, wsOrg: null, workspaces: [], go: vi.fn(), showToast: vi.fn() };
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none', gradPair: () => 'none' }));

const { MarketView } = await import('../src/components/MarketView');
const { ImportPlanView } = await import('../src/components/OrgBlueprintBits');

const company = (over: Partial<CompanyRegistryItem>): CompanyRegistryItem => ({
  id: 'c', kind: 'company' as CompanyRegistryItem['kind'], slug: 'c', name: 'C', description: '', version: 1, publisherName: 'Dana',
  capabilities: { tools: ['fs_read'], connections: [], loops: [], skills: [], apps: [], company: { roles: 3, depth: 2, monthlyUsd: 40, playbooks: 0, cadences: 1, tunables: 0, cards: [] } },
  scanReport: { ok: true, flags: [] } as unknown as CompanyRegistryItem['scanReport'], installs: 0, ratingUp: 0, ratingDown: 0, publishedAt: '', updatedAt: '',
  source: 'local', remoteUrl: '', outcomes: { first_key_result: 0, thirty_days_in_envelope: 0 }, ...over,
});
const LIST: CompanyRegistryItem[] = [
  company({ id: 'builtin:saas-startup', slug: 'saas-startup', name: 'SaaS startup', description: 'A seed-stage SaaS company.', publisherName: 'yaam', source: 'builtin', official: true, capabilities: { tools: [], connections: [], loops: [], skills: [], apps: [], company: { roles: 9, depth: 3, monthlyUsd: 600, playbooks: 0, cadences: 9, tunables: 3, cards: [] } } }),
  company({ id: 'builtin:research-lab', slug: 'research-lab', name: 'Research lab', publisherName: 'yaam', source: 'builtin', official: true }),
  company({ id: 'local1', slug: 'dana-co', name: 'Dana Co', publisherName: 'Dana' }),
];
const REMOTE = { url: '', ok: false, error: '', fetchedAt: null };
const NAV = { segment: 'business' as const, cat: 'All', fn: '' };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The card that holds a company's name: the nearest ancestor with an install button. */
const cardOf = (name: string): HTMLElement => {
  let el: HTMLElement | null = screen.getByText(name);
  while (el && !within(el).queryByRole('button', { name: 'Review & install' })) el = el.parentElement;
  return el!;
};

describe('the Companies tab', () => {
  it('lists the official starters first with the Official badge, their seats and envelope; a published one has no badge', async () => {
    const list = vi.spyOn(api, 'marketCompanies').mockResolvedValue({ items: LIST, remote: REMOTE });
    render(<MarketView nav={NAV} setNav={vi.fn()} />);
    fireEvent.click(screen.getByText('Companies'));
    await waitFor(() => expect(screen.getByText('SaaS startup')).toBeInTheDocument());
    expect(list).toHaveBeenCalledWith('');
    const names = screen.getAllByRole('button', { name: 'Review & install' }).map((b) => {
      let el: HTMLElement | null = b; while (el && !LIST.some((i) => within(el!).queryByText(i.name))) el = el.parentElement;
      return LIST.find((i) => within(el!).queryByText(i.name))!.name;
    });
    expect(names).toEqual(['SaaS startup', 'Research lab', 'Dana Co']);
    const saas = cardOf('SaaS startup');
    expect(within(saas).getByText('Official')).toBeInTheDocument();
    expect(within(saas).getByText('9 seats · $600/month')).toBeInTheDocument();
    expect(within(saas).getByText('yaam · first-party starter')).toBeInTheDocument();
    expect(within(cardOf('Research lab')).getByText('Official')).toBeInTheDocument();
    const dana = cardOf('Dana Co');
    expect(within(dana).queryByText('Official')).toBeNull();
    expect(within(dana).getByText('Dana · v1')).toBeInTheDocument();
  });

  it('search asks the server and says when nothing matches', async () => {
    const list = vi.spyOn(api, 'marketCompanies').mockImplementation(async (q = '') => ({ items: q ? LIST.filter((i) => i.name.toLowerCase().includes(q.toLowerCase())) : LIST, remote: REMOTE }));
    render(<MarketView nav={NAV} setNav={vi.fn()} />);
    fireEvent.click(screen.getByText('Companies'));
    await waitFor(() => expect(screen.getByText('Dana Co')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Search companies' }), { target: { value: 'lab' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith('lab'));
    await waitFor(() => expect(screen.queryByText('Dana Co')).toBeNull());
    expect(screen.getByText('Research lab')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search companies' }), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByText('No company matches “zzz”.')).toBeInTheDocument());
  });

  it('the install plan lists the cadences it hands the chief, in words, with their unit', () => {
    const plan: BlueprintImportPlan = {
      ok: true, name: 'SaaS startup', mode: 'supervised', chief: { title: 'Chief of staff', roleId: 'chief-of-staff', scopes: ['tool:fs_read'], dropped: [], modelTier: 'strong', model: 'm' },
      hires: [{ title: 'Head of Engineering', roleId: 'engineering-manager', reportsTo: 'Chief of staff', requestedScopes: [], scopes: [], dropped: [], modelTier: 'strong', model: 'm', monthlyUsd: 85 }],
      units: [], budget: { monthlyUsd: 600, allocations: { 'Head of Engineering': 85 }, allocated: 85 }, tunables: [],
      profile: { values: true, culture: true, rules: true }, vision: { title: 'V', horizonDays: 180 }, playbooks: [],
      cadences: { count: 2, applied: false, note: 'listed', list: [{ unitTitle: 'root', kind: 'weekly_review', cron: '0 16 * * 5' }, { unitTitle: 'Head of Engineering', kind: 'planning', cron: '0 10 * * 1' }] },
      recommendedCards: [], recommendedConnections: [], approval: 'blueprint', notes: [],
    } as unknown as BlueprintImportPlan;
    render(<ImportPlanView plan={plan} />);
    expect(screen.getByText(/Cadences · 2/)).toBeInTheDocument();
    expect(screen.getByText(/· company · Fridays at 16:00/)).toBeInTheDocument();
    expect(screen.getByText(/· Head of Engineering · Mondays at 10:00/)).toBeInTheDocument();
    expect(screen.getByText(/\$85\.00\/month/)).toBeInTheDocument();
  });
});
