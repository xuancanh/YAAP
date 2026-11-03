/** Foundry (docs/foundry.md §8): the four shelves (Blueprints re-housing
 *  the Companies department, Kits as previews, Agents, Plugins), the
 *  Plugins shelf with its filters and tier badges, the plugin detail page,
 *  the install review flow with the community opt-in, the recall notice,
 *  and deep links (`?section=market` keeps working). */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type FoundryPlugin, type FoundryPluginDetail, type KitPreview, type PluginReview, type PluginSummary } from '../src/lib/api';
import { navFromUrl, navQuery, useMarketNav } from '../src/lib/market';
import { classMix, folderFiles, recallSentence } from '../src/lib/foundry';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none', gradPair: () => 'none' }));

const { MarketView } = await import('../src/components/MarketView');
const { MarketRail } = await import('../src/components/Rails');
const { PluginsPane } = await import('../src/components/PluginsPane');

const plugin = (over: Partial<FoundryPlugin>): FoundryPlugin => ({
  id: 'x@yaam', name: 'X', description: '', tier: 'first_party', source: 'first_party', publisher: { id: 'yaam', name: 'yaam' }, roles: ['interface'],
  version: '1.0.0', digest: 'a'.repeat(64), coreRange: '^1.0', compatible: true, defines: [], provides: [], requires: [], noEgress: true,
  conformance: [], installs: 0, versionCount: 1, recalled: false, installable: true, publishedAt: '2026-11-01T00:00:00Z', installed: null, updateAvailable: false, ...over,
});
const SHELF = {
  items: [
    plugin({ id: 'ci@yaam', name: 'Continuous integration (interface)', defines: ['ci'] }),
    plugin({ id: 'scm-mock@yaam', name: 'Mock forge (provider)', roles: ['provider'], provides: ['scm', 'ci'], requires: ['scm', 'ci'], conformance: [{ interface: 'scm', interfaceVersion: '1.0.0', result: 'pass' }] }),
    plugin({ id: 'tick@community', name: 'Tick', tier: 'community', source: 'registry', publisher: { id: 'acme', name: 'Acme' }, defines: ['tick'] }),
  ],
  facets: { interfaces: [{ name: 'ci', defined: true, providers: 1, consumers: 0 }, { name: 'scm', defined: true, providers: 1, consumers: 0 }], tiers: { first_party: 2, verified: 0, community: 1, local: 0 }, roles: { interface: 2, provider: 1, consumer: 0 } },
  coreApi: '1.0.0',
};
const op = (o: string, cls: string, extra: Record<string, unknown> = {}) => ({ op: o, canonical: `tick.${o}`, tool: `tick_${o}`, semantics: `does ${o}`, declaredClass: cls, effectiveClass: cls, floorReasons: [], twoKey: false, outbound: false, movesMoney: false, reversibility: 'none', required: true, ...extra });
const DETAIL: FoundryPluginDetail = {
  ...SHELF.items[2], license: 'MIT', homepage: '',
  capabilities: {
    roles: ['interface'], defines: [{ name: 'tick', version: '1.0.0', semantics: 'Runs against a repository.', operations: [op('list_runs', 'read'), op('cancel', 'external_irreversible', { declaredClass: 'external_reversible', floorReasons: ['irreversible kind'] })], changeKinds: [], events: [] }],
    provides: [], requires: [], egress: [{ host: 'api.tick.example', category: 'vendor' }], dataSharing: [{ category: 'code', to: 'Tick', when: 'operation', purpose: 'runs' }],
    secrets: [{ slot: 'TICK_TOKEN', description: 'token', kind: 'api_key', inject: 'proxy' }], identity: [], connections: [], requestedPolicies: [], budgets: {},
    consumer: { skills: 0, rolePacks: 0, playbooks: 0, verifies: 0 }, extras: [], noEgress: false,
  },
  installSource: { registry: { id: 'tick@community', version: '1.0.1' } },
  versions: [
    { version: '1.0.1', digest: 'b'.repeat(64), manifestHash: 'c', commitSha: 'd'.repeat(40), coreRange: '^1.0', compatible: true, conformance: [], publishedAt: '2026-11-03T00:00:00Z', publishedBy: 'me', changelog: 'Reworded.', recalled: false, recalledAt: null, recallReason: '', installed: false },
    { version: '1.0.0', digest: 'e'.repeat(64), manifestHash: 'f', commitSha: '', coreRange: '^1.0', compatible: true, conformance: [], publishedAt: '2026-11-01T00:00:00Z', publishedBy: 'me', changelog: '', recalled: true, recalledAt: '2026-11-02T00:00:00Z', recallReason: 'bad classification', installed: false },
  ],
  related: [],
};
const REVIEW = {
  id: 'tick@community', name: 'Tick', version: '1.0.1', description: '', publisher: { id: 'acme', name: 'Acme' }, tier: 'community', roles: ['interface'], requires: { yaamCore: '^1.0' },
  digest: 'b'.repeat(64), warnings: [], noEgress: false, interfaces: [], provides: [], egress: [], secrets: [], dataSharing: [], identity: [], budgets: {}, requestedPolicies: [],
  deferred: [], diff: [], widening: true, blockers: [], communityOptIn: true,
} as unknown as PluginReview;
const KITS: KitPreview[] = [
  { id: 'ship-software', name: 'Ship Software', blurb: 'An engineering team.', functions: ['engineering'], companyTypes: ['saas'], interfaces: [{ name: 'scm' }, { name: 'issues', optional: true }], providers: ['GitHub'], seats: ['Engineering manager'], cadences: ['standup'], metrics: ['lead time'], policies: '', status: 'coming_soon', installable: false },
  { id: 'support-desk', name: 'Support Desk', blurb: 'A queue.', functions: ['customer'], companyTypes: ['saas'], interfaces: [{ name: 'support' }], providers: ['Intercom'], seats: ['CS manager'], cadences: ['queue review'], metrics: ['CSAT'], policies: '', status: 'coming_soon', installable: false },
];

const onOpenSettings = vi.fn();
function Foundry() {
  const { nav, setNav } = useMarketNav(false);
  return <><MarketRail nav={nav} setNav={setNav} /><MarketView nav={nav} setNav={setNav} onOpenSettings={onOpenSettings} /></>;
}
const setUrl = (search: string) => window.history.replaceState(null, '', `/${search}`);

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear() });
  setUrl('');
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    market: [], stacked: false, companiesEnabled: true, workspaceId: 'ws1', go: vi.fn(), setHireId: vi.fn(), showToast: vi.fn(), refreshMcp: vi.fn(async () => {}), mcp: [], agents: [],
    wsOrg: { workspaceId: 'ws1', mode: 'off', chiefOfStaffAgentId: null, orgId: null, pendingApprovals: 0, units: [], org: null },
  });
  vi.spyOn(api, 'foundryPlugins').mockResolvedValue(SHELF);
  vi.spyOn(api, 'foundryKits').mockResolvedValue(KITS);
  vi.spyOn(api, 'marketCompanies').mockResolvedValue({ items: [{ id: 'c1', kind: 'company', slug: 'acme', name: 'Acme Studio', description: 'An agency.', version: 1, publisherName: 'me', capabilities: { tools: [], connections: [], loops: [], skills: [], apps: [] }, scanReport: { ok: true, flags: [], urls: [] }, installs: 2, ratingUp: 0, ratingDown: 0, publishedAt: '', updatedAt: '', source: 'local', remoteUrl: '', outcomes: { first_key_result: 1, thirty_days_in_envelope: 0 } }], remote: { url: '', ok: false, error: '', fetchedAt: null } } as never);
  vi.spyOn(api, 'registry').mockResolvedValue({ items: [
    { id: 'r1', kind: 'agent', slug: 'helper', name: 'Community Helper', description: '', version: 1, publisherName: 'pat', capabilities: { tools: [], connections: [], loops: [], skills: [], apps: [] }, scanReport: { ok: true, flags: [], urls: [] }, installs: 0, ratingUp: 0, ratingDown: 0, publishedAt: '', updatedAt: '', source: 'local', remoteUrl: '' },
    { id: 'r2', kind: 'plugin', slug: 'tick-community', name: 'Tick listing', description: '', version: 1, publisherName: 'Acme', capabilities: { tools: [], connections: [], loops: [], skills: [], apps: [] }, scanReport: { ok: true, flags: [], urls: [] }, installs: 0, ratingUp: 0, ratingDown: 0, publishedAt: '', updatedAt: '', source: 'local', remoteUrl: '' },
  ], remote: { url: '', ok: false, error: '', fetchedAt: null } } as never);
  vi.spyOn(api, 'marketConnectors').mockResolvedValue([{ id: 'gcal', name: 'Google Calendar', vendor: 'Google', emoji: '📅', kind: 'native', nativeTier: 'read', tier: 'verified', desc: 'Calendar.', tools: ['calendar_list'] }] as never);
  vi.spyOn(api, 'connections').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); onOpenSettings.mockReset(); });

describe('shelves', () => {
  it('Foundry has four shelves; Agents is where a market link lands, and Blueprints holds the published companies', async () => {
    render(<Foundry />);
    expect(screen.getByRole('heading', { name: 'Foundry' })).toBeInTheDocument();
    const tabs = within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['BlueprintsCompany types', 'KitssoonUse cases', 'AgentsThe people', 'PluginsParts and connectors']);
    expect(within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getByRole('tab', { name: /Agents/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getByRole('tab', { name: /Blueprints/ }));
    expect(await screen.findByText('Acme Studio')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search companies' })).toBeInTheDocument();
  });

  it('Kits are previews: the coming-soon notice, the designed catalog, nothing installable', async () => {
    render(<Foundry />);
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getByRole('tab', { name: /Kits/ }));
    expect(screen.getByTestId('kits-coming')).toHaveTextContent('Kits are coming — bundles of interfaces, providers and roles for a use case');
    const ship = await screen.findByTestId('kit-ship-software');
    expect(ship).toHaveTextContent('Coming soon');
    expect(within(ship).getByRole('button', { name: 'Not installable yet' })).toBeDisabled();
    // The rail's functions filter the previews.
    fireEvent.click(screen.getByRole('button', { name: /Customer Success/ }));
    expect(screen.queryByTestId('kit-ship-software')).toBeNull();
    expect(screen.getByTestId('kit-support-desk')).toBeInTheDocument();
  });

  it('community agents appear on the Agents shelf; registry plugin listings never show among them', async () => {
    render(<Foundry />);
    fireEvent.click(screen.getByRole('button', { name: 'Community' }));
    expect(await screen.findByText('Community Helper')).toBeInTheDocument();
    expect(screen.queryByText('Tick listing')).toBeNull();
    expect(api.registry).toHaveBeenCalledWith('agent', '');
  });
});

describe('the Plugins shelf', () => {
  it('lists interfaces and providers with tier badges, and filters by role, interface and tier', async () => {
    setUrl('?section=foundry&shelf=plugins');
    render(<Foundry />);
    const list = await screen.findByRole('list', { name: 'Plugins' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(screen.getByTestId('plugin-row-tick@community')).getByTestId('tier-community')).toHaveTextContent('Community');
    expect(within(screen.getByTestId('plugin-row-scm-mock@yaam')).getByText('conformance passed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Providers/ }));
    await waitFor(() => expect(api.foundryPlugins).toHaveBeenLastCalledWith('ws1', expect.objectContaining({ role: 'provider' })));
    fireEvent.change(screen.getByRole('combobox', { name: 'Interface' }), { target: { value: 'ci' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tier' }), { target: { value: 'community' } });
    await waitFor(() => expect(api.foundryPlugins).toHaveBeenLastCalledWith('ws1', { q: '', role: 'provider', iface: 'ci', tier: 'community' }));
  });

  it('Connectors stay a filter on the Plugins shelf with the existing connect cards', async () => {
    setUrl('?section=market&shelf=connectors');
    render(<Foundry />);
    expect(await screen.findByText('Google Calendar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connectors' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the detail page shows what it defines with effective classes, what it reaches, versions with recalls, and installs behind the review with the community opt-in', async () => {
    vi.spyOn(api, 'foundryPlugin').mockResolvedValue(DETAIL);
    const review = vi.spyOn(api, 'reviewPlugin').mockResolvedValue(REVIEW);
    const install = vi.spyOn(api, 'installPlugin').mockResolvedValue({ installed: true, review: REVIEW });
    render(<Foundry />);
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getByRole('tab', { name: /Plugins/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tick (tick@community)' }));
    const page = await screen.findByTestId('plugin-detail-page');
    const cancel = within(page).getByTestId('op-tick.cancel');
    expect(cancel).toHaveTextContent('external, irreversible');
    expect(cancel).toHaveTextContent('declared external, reversible');
    expect(cancel).toHaveTextContent('irreversible kind');
    expect(within(page).getByTestId('reach')).toHaveTextContent('api.tick.example');
    expect(within(page).getByTestId('reach')).toHaveTextContent('TICK_TOKEN');
    expect(within(page).getByTestId('reach')).toHaveTextContent('code to Tick, per operation');
    expect(within(page).getByTestId('version-1.0.0')).toHaveTextContent('Recalled: bad classification');
    expect(within(page).getByTestId('version-1.0.1')).toHaveTextContent('latest');
    fireEvent.click(within(page).getByRole('button', { name: 'Install' }));
    await screen.findByTestId('plugin-review');
    expect(review).toHaveBeenCalledWith('ws1', { registry: { id: 'tick@community', version: '1.0.1' } });
    const approve = screen.getByRole('button', { name: 'Approve and install' });
    expect(approve).toBeDisabled(); // the community opt-in comes first
    fireEvent.click(within(screen.getByTestId('community-opt-in')).getByRole('checkbox'));
    expect(approve).not.toBeDisabled();
    fireEvent.click(approve);
    await waitFor(() => expect(install).toHaveBeenCalledWith('ws1', { registry: { id: 'tick@community', version: '1.0.1' } }, { acceptCommunity: true }));
  });

  it('an installed plugin links to Settings › Plugins; a frozen one shows the recall notice', async () => {
    vi.spyOn(api, 'foundryPlugin').mockResolvedValue({ ...DETAIL, installed: { status: 'frozen', version: '1.0.0', notice: 'version 1.0.0 was recalled: bad classification', recalled: true } });
    setUrl('?section=foundry&shelf=plugins&plugin=tick@community');
    render(<Foundry />);
    const notice = await screen.findByTestId('recall-notice');
    expect(notice).toHaveTextContent('This plugin is frozen');
    expect(notice).toHaveTextContent('Version 1.0.0 was recalled: bad classification.');
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Settings › Plugins' }));
    expect(onOpenSettings).toHaveBeenCalledWith('plugins');
  });
});

describe('Settings › Plugins', () => {
  it('a frozen install carries the recall notice and the versions it can move to, with their permission diff', async () => {
    const frozen: PluginSummary = {
      id: 'tick@community', name: 'Tick', version: '1.0.1', description: '', roles: ['interface'], tier: 'community', status: 'frozen', suspendedReason: 'version 1.0.1 was recalled: bad classification',
      installId: 'i1', digest: 'b', installedAt: '', pendingUpdate: null, providers: [], interfaces: ['tick@1.0.1'], recall: { version: '1.0.1', notice: 'version 1.0.1 was recalled: bad classification', at: '' },
    };
    vi.spyOn(api, 'pluginCatalog').mockResolvedValue([]);
    vi.spyOn(api, 'plugins').mockResolvedValue([frozen]);
    vi.spyOn(api, 'interfaces').mockResolvedValue([]);
    vi.spyOn(api, 'pluginUpdates').mockResolvedValue({ pluginId: 'tick@community', installed: { version: '1.0.1', status: 'frozen', recalled: true, notice: '' }, pending: null,
      updates: [{ version: '1.0.0', digest: 'e', commitSha: '', coreRange: '^1.0', compatible: true, changelog: '', conformance: [], publishedAt: '', newer: false, diff: [], widening: false, source: { registry: { id: 'tick@community', version: '1.0.0' } } }] });
    const update = vi.spyOn(api, 'updatePlugin').mockResolvedValue({ applied: true });
    render(<PluginsPane />);
    expect(await screen.findByTestId('recall-tick@community')).toHaveTextContent('Frozen. version 1.0.1 was recalled: bad classification');
    expect(screen.getByTestId('plugin-status-tick@community')).toHaveTextContent('frozen');
    fireEvent.click(await screen.findByRole('button', { name: 'Move to 1.0.0' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', 'tick@community', { registry: { id: 'tick@community', version: '1.0.0' } }));
  });
});

describe('deep links and helpers', () => {
  it('reads Foundry links and every market link of before', () => {
    expect(navFromUrl('?section=market')).toBeNull();
    expect(navFromUrl('?section=market&segment=business&fn=finance')).toEqual({ segment: 'business', fn: 'finance' });
    expect(navFromUrl('?section=market&shelf=companies')).toEqual({ shelf: 'blueprints' });
    expect(navFromUrl('?section=market&shelf=community')).toEqual({ shelf: 'agents', agentTier: 'community' });
    expect(navFromUrl('?section=foundry&shelf=plugins&iface=scm&tier=community')).toEqual({ shelf: 'plugins', iface: 'scm', tier: 'community' });
    expect(navFromUrl('?section=foundry&plugin=scm@yaam')).toEqual({ shelf: 'plugins', plugin: 'scm@yaam' });
    expect(navFromUrl('?section=foundry&shelf=kits')).toEqual({ shelf: 'kits' });
    expect(navQuery({ segment: 'personal', cat: 'All', fn: '', shelf: 'plugins', iface: 'ci', plugin: 'ci@yaam' })).toBe('?section=foundry&shelf=plugins&iface=ci&plugin=ci%40yaam');
  });

  it('a ?section=market link still opens the agents shelf', () => {
    setUrl('?section=market&segment=business&fn=finance');
    render(<Foundry />);
    expect(within(screen.getByRole('tablist', { name: 'Foundry shelves' })).getByRole('tab', { name: /Agents/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('class mix orders read to money; recall sentences read as sentences; a folder upload drops its top folder and hidden files', async () => {
    expect(classMix([{ effectiveClass: 'money' }, { effectiveClass: 'read' }, { effectiveClass: 'read' }])).toEqual([{ cls: 'read', count: 2 }, { cls: 'money', count: 1 }]);
    expect(recallSentence('version 1.0.0 was recalled: leaks')).toBe('Version 1.0.0 was recalled: leaks.');
    const f = (p: string, t: string) => ({ name: p.split('/').pop()!, webkitRelativePath: p, text: async () => t });
    expect(await folderFiles([f('tick/plugin.json', '{}'), f('tick/conformance/s.json', '[]'), f('tick/.git/config', 'x')])).toEqual({ 'plugin.json': '{}', 'conformance/s.json': '[]' });
  });
});
