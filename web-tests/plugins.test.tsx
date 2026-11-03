/** Settings › Plugins (docs/plugins.md, Phase 1): installed plugins with
 *  their suspension reason, the review screen showing each operation's
 *  effective class and the floor that raised it, the install after
 *  approval, the default binding the owner sets, and the inventory of what
 *  an install added with its conformance runs. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type InterfaceView, type PluginCatalogEntry, type PluginDetail, type PluginReview, type PluginSummary } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));

const { PluginsPane, statusText } = await import('../src/components/PluginsPane');

const catalog: PluginCatalogEntry[] = [
  { id: 'scm@yaam', name: 'Source control (interface)', version: '1.0.0', description: 'The scm@1 contract.', roles: ['interface'], tier: 'first_party', installed: true, installedVersion: '1.0.0', updateAvailable: false },
  { id: 'ci@yaam', name: 'Continuous integration (interface)', version: '1.0.0', description: 'The ci@1 contract.', roles: ['interface'], tier: 'first_party', installed: false, installedVersion: null, updateAvailable: false },
];
const installed: PluginSummary[] = [{
  id: 'scm@yaam', name: 'Source control (interface)', version: '1.0.0', description: '', roles: ['interface'], tier: 'first_party',
  status: 'suspended', suspendedReason: 'no scm provider bound', installId: 'i1', digest: 'abc', installedAt: '2026-11-03T10:00:00Z',
  pendingUpdate: null, providers: [], interfaces: ['scm@1.0.0'],
}, {
  id: 'scm-mock@yaam', name: 'Mock forge (provider)', version: '1.0.0', description: '', roles: ['provider'], tier: 'first_party',
  status: 'active', suspendedReason: '', installId: 'i2', digest: 'def', installedAt: '2026-11-03T10:00:00Z',
  pendingUpdate: null, providers: [{ id: 'p1', interface: 'scm', range: '^1', status: 'conformant', resources: ['scm://mock.example/*'], conformanceRunId: 'r1' }], interfaces: [],
}];
const ifaces: InterfaceView[] = [{
  name: 'scm', version: '1.0.0', major: 1, pluginId: 'scm@yaam', semantics: 'Hosted git repositories.',
  operations: [{ op: 'merge', canonical: 'scm.merge', tool: 'scm_merge', effectiveClass: 'external_irreversible', declaredClass: 'external_irreversible', floorReasons: [], change: { kind: 'pull_request', role: 'apply' } }],
  changeKinds: [{ kind: 'scm.pull_request', reversibility: 'costly', requirement: 'two_key' }],
  providers: [{ id: 'p1', pluginId: 'scm-mock@yaam', status: 'conformant', healthy: true, resources: ['scm://mock.example/*'], range: '^1' }],
  bindings: [],
}];
const review: PluginReview = {
  id: 'ci@yaam', name: 'Continuous integration (interface)', version: '1.0.0', description: '', publisher: { id: 'yaam', name: 'yaam', verifiedDomain: 'yaam.chat' },
  tier: 'first_party', roles: ['interface'], requires: { yaamCore: '^1.0' }, digest: '0123456789abcdef0123', warnings: [], noEgress: true,
  interfaces: [{ name: 'ci', version: '1.0.0', semantics: 'Automated runs.', suiteCases: ['list-then-read'], events: ['ci.run.completed'],
    operations: [
      { op: 'read_run', canonical: 'ci.read_run', tool: 'ci_read_run', semantics: 'One run.', declaredClass: 'read', effectiveClass: 'read', floorReasons: [], raisedByFloor: false, twoKeyByFloor: false, reversibility: 'none', outbound: false, movesMoney: false, change: null, untrustedOutput: false },
      { op: 'ship', canonical: 'ci.ship', tool: 'ci_ship', semantics: 'Ship.', declaredClass: 'read', effectiveClass: 'external_irreversible', floorReasons: ['apply of a irreversible change kind is at least external_irreversible and two-key'], raisedByFloor: true, twoKeyByFloor: true, reversibility: 'none', outbound: false, movesMoney: false, change: { kind: 'release', role: 'apply' }, untrustedOutput: false },
    ],
    changeKinds: [{ kind: 'ci.release', reversibility: 'irreversible', declaredRequirement: 'trust', effectiveRequirement: 'two_key', raisedByFloor: true, roles: [{ op: 'ci.ship', role: 'apply' }] }] }],
  provides: [], egress: [], secrets: [], dataSharing: [], identity: [], budgets: {}, requestedPolicies: [], deferred: [], diff: [{ path: 'plugin', widening: true, detail: 'install ci@yaam@1.0.0' }], widening: true, blockers: [],
};
const detail: PluginDetail = {
  ...installed[1],
  effects: [{ id: 'e1', seq: 1, kind: 'provider', ref: 'scm@^1', state: 'live', external: false, createdAt: '', unwoundAt: null }, { id: 'e2', seq: 2, kind: 'binding', ref: 'scm@1 workspace', state: 'live', external: false, createdAt: '', unwoundAt: null }],
  conformance: [{ id: 'r1', providerId: 'p1', result: 'pass', mode: 'mock', startedAt: '2026-11-03T10:00:00Z', cases: [{ id: 'merge-requires-head-sha', ok: true }], candidate: false }],
  grants: [{ agentId: 'a1', level: 'write', extras: false }],
};

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { workspaceId: 'ws1', agents: [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bob' }], showToast: vi.fn() });
  vi.spyOn(api, 'pluginCatalog').mockResolvedValue(catalog);
  vi.spyOn(api, 'plugins').mockResolvedValue(installed);
  vi.spyOn(api, 'interfaces').mockResolvedValue(ifaces);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Settings › Plugins', () => {
  it('lists installs with why one is suspended, and interfaces with their providers', async () => {
    render(<PluginsPane />);
    expect((await screen.findByTestId('plugin-status-scm@yaam')).textContent).toBe('suspended: no scm provider bound');
    expect(screen.getByTestId('plugin-scm-mock@yaam').textContent).toContain('conformance conformant');
    const card = screen.getByTestId('interface-scm');
    expect(within(card).getByText(/Unbound: agents see none/)).toBeTruthy();
    expect(within(card).getByText('scm_merge')).toBeTruthy();
    expect(statusText({ status: 'installed', suspendedReason: 'conformance scm: failed' })).toBe('not ready: conformance scm: failed');
  });

  it('the review screen shows the class yaam treats each operation as and the floor that raised it; approve installs', async () => {
    const reviewSpy = vi.spyOn(api, 'reviewPlugin').mockResolvedValue(review);
    const installSpy = vi.spyOn(api, 'installPlugin').mockResolvedValue({ installed: true, review });
    render(<PluginsPane />);
    fireEvent.click(within(await screen.findByTestId('catalog-ci@yaam')).getByText('Review'));
    const panel = await screen.findByTestId('plugin-review');
    expect(reviewSpy).toHaveBeenCalledWith('ws1', { firstParty: 'ci@yaam' });
    const ship = within(panel).getByTestId('review-op-ci.ship');
    expect(ship.textContent).toContain('read');
    expect(ship.textContent).toContain('external, irreversible · two-key');
    expect(ship.textContent).toContain("raised by yaam's floor");
    expect(panel.textContent).toContain('requirement two-key');
    expect(panel.textContent).toContain('no egress');
    fireEvent.click(within(panel).getByText('Approve and install'));
    await waitFor(() => expect(installSpy).toHaveBeenCalledWith('ws1', { firstParty: 'ci@yaam' }));
  });

  it('a blocked review cannot be installed and says why', async () => {
    vi.spyOn(api, 'reviewPlugin').mockResolvedValue({ ...review, blockers: ['ci: the interface name is claimed by ci@acme'] });
    render(<PluginsPane />);
    fireEvent.click(within(await screen.findByTestId('catalog-ci@yaam')).getByText('Review'));
    const panel = await screen.findByTestId('plugin-review');
    expect(within(panel).getByRole('alert').textContent).toContain('claimed by ci@acme');
    expect((within(panel).getByText('Approve and install') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the owner sets the workspace default binding', async () => {
    const bind = vi.spyOn(api, 'setBinding').mockResolvedValue({});
    render(<PluginsPane />);
    const select = await screen.findByLabelText('Default provider for scm');
    fireEvent.change(select, { target: { value: 'p1' } });
    await waitFor(() => expect(bind).toHaveBeenCalledWith('ws1', 'scm', { major: 1, scopeKind: 'workspace', providerId: 'p1' }));
  });

  it('details show the inventory of what the plugin added, its conformance, and per-agent access', async () => {
    vi.spyOn(api, 'plugin').mockResolvedValue(detail);
    const grant = vi.spyOn(api, 'setPluginGrant').mockResolvedValue({});
    render(<PluginsPane />);
    fireEvent.click(within(await screen.findByTestId('plugin-scm-mock@yaam')).getByText('Details'));
    const d = await screen.findByTestId('plugin-detail-scm-mock@yaam');
    expect(d.textContent).toContain('scm@1 workspace');
    expect(within(d).getByTestId('conformance-run').textContent).toContain('pass');
    expect((within(d).getByLabelText('Access for Ada') as HTMLSelectElement).value).toBe('write');
    fireEvent.change(within(d).getByLabelText('Access for Bob'), { target: { value: 'read' } });
    await waitFor(() => expect(grant).toHaveBeenCalledWith('ws1', 'scm-mock@yaam', 'a2', 'read'));
  });

  it('a pending update that fails conformance cannot be approved', async () => {
    vi.spyOn(api, 'plugins').mockResolvedValue([{ ...installed[1], pendingUpdate: { version: '1.0.1', failures: ['scm/merge-then-revert: invalid_output'], diff: [] } }]);
    render(<PluginsPane />);
    const pending = await screen.findByTestId('pending-scm-mock@yaam');
    expect(pending.textContent).toContain('fails conformance');
    expect((within(pending).getByText('Approve') as HTMLButtonElement).disabled).toBe(true);
  });
});
