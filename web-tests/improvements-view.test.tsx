/** Operations › Improvements on screen (docs/improvements.md): proposals by
 *  status with evidence, diff and verification; the CEO's accept and
 *  reject; the Work sources panel with the self-started share and the caps.
 *  And the pure lib: filters, bars, words. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgDetail, OrgImprovement, WorkSources } from '../src/lib/api';
import { countByFilter, filterOf, sourceBars, verificationWords } from '../src/lib/improvements';
import { sectionDef, paneHome } from '../src/lib/company-nav';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const base: OrgImprovement = {
  id: 'i1', orgId: 'o1', key: 'IM-1', unitId: 'u1', title: 'Add a fact-check step', targetKind: 'process', targetRef: 'content-publishing', targetLabel: 'process "Content publishing" v2',
  evidence: [{ kind: 'task', ref: 'ENG-7', summary: 'ENG-7 shipped a wrong figure' }], hypothesis: 'A fact-check before publishing catches wrong figures.',
  change: {}, diff: ['step check + MUST: every figure has a source'], expected: { metric: 'quality.reworkRate', direction: 'down', by: 0 }, expectedText: 'rework rate ↓',
  category: 'prevent', changeClass: 'normal', classWhy: 'it changes what a run must do', owner: 'agent:a1', proposedBy: 'agent:a2', origin: 'retro', originRef: 'meeting:m1', incidentId: null,
  status: 'proposed', approvalId: 'ap1', reviewPending: 0, appliedRef: '', baseline: null, verifyAt: null, verification: null, revertOf: null, lastError: '',
  history: [{ from: '', to: 'proposed', by: 'agent:a2', why: 'Prevent · normal change', at: new Date().toISOString() }], expiresAt: null, decidedBy: '', decidedAt: null, createdAt: new Date().toISOString(), updatedAt: '',
};
const verified: OrgImprovement = { ...base, id: 'i2', key: 'IM-2', title: 'Shorter standups', status: 'verified', verification: { outcome: 'pass', baseline: 0.4, value: 0.2, detail: 'rework rate ↓: 0.4 → 0.2', at: '' } };
const sources: WorkSources = {
  days: 14, total: 10, byOrigin: { plan: 2, retro: 5, agent: 2, process: 1 }, origins: [], selfOrigins: ['retro', 'meeting', 'agent'], selfShare: 0.7, systemShare: 0.8, retroShare: 0.5,
  perUnit: [{ unitId: 'u1', name: 'Engineering', selfOpen: 6, cap: 6 }],
  caps: { selfWip: 6, selfPerDay: 4, overCap: 'refuse', agentWakesPerHour: 12, maxOpenPerTarget: 1, maxOpenPerUnit: 4, perMeeting: 2 },
  admission: { refused: 3, parked: 0, deferredWakes: 1 },
  proposals: { opened: 2, accepted: 1, applied: 1, verified: 1, reverted: 0, rejected: 0, expired: 0, open: 1, waiting: 1, verifying: 0 },
};
const apiMock = {
  orgHumans: vi.fn(async () => ({ me: { role: 'ceo' } })),
  orgImprovements: vi.fn(async () => ({ improvements: [base, verified], sources })),
  acceptOrgImprovement: vi.fn(async () => ({ ...base, status: 'applied' })),
  rejectOrgImprovement: vi.fn(async () => ({ ...base, status: 'rejected' })),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { ImprovementsPane } = await import('../src/components/OrgImprovementsView');
const org = { workspaceId: 'ws1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { agents: [{ id: 'a1', name: 'Writer', colors: ['#000', '#111'], emoji: 'W' }, { id: 'a2', name: 'Editor', colors: ['#000', '#111'], emoji: 'E' }], wsOrg: { units: [] }, showToast: vi.fn() });
  apiMock.acceptOrgImprovement.mockClear();
});

describe('the lib', () => {
  it('groups proposals: an emergency change under review needs a decision; bars largest first and flag self-started work', () => {
    expect(filterOf({ status: 'proposed', reviewPending: 0 })).toBe('decide');
    expect(filterOf({ status: 'applied', reviewPending: 1 })).toBe('decide');
    expect(filterOf({ status: 'applied', reviewPending: 0 })).toBe('flight');
    expect(filterOf({ status: 'expired', reviewPending: 0 })).toBe('closed');
    expect(countByFilter([base, verified])).toEqual({ decide: 1, flight: 0, done: 1, closed: 0 });
    const bars = sourceBars(sources);
    expect(bars.map((b) => b.origin)).toEqual(['retro', 'plan', 'agent', 'process']);
    expect(bars[0]).toMatchObject({ label: 'Retros', share: 0.5, self: true });
    expect(verificationWords(verified)).toBe('Met — rework rate ↓: 0.4 → 0.2');
    expect(sectionDef('operations').pages.map((p) => p.pane)).toContain('improvements');
    expect(paneHome('improvements')).toEqual({ section: 'operations', pane: 'improvements' });
  });
});

describe('the Improvements pane', () => {
  it('lists what needs a decision with evidence and diff, accepts it, and shows work sources against the caps', async () => {
    render(<ImprovementsPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('improvement-list')).toHaveTextContent('IM-1 · Add a fact-check step'));
    const row = screen.getByTestId('improvement-row');
    expect(row).toHaveTextContent('Prevent · process "Content publishing" v2 · Normal change · owner Writer · raised by Editor (retro)');
    expect(row).toHaveTextContent('Awaiting a decision');
    fireEvent.click(within(row).getByRole('button', { name: /IM-1/ }));
    const detail = screen.getByTestId('improvement-detail');
    expect(detail).toHaveTextContent('ENG-7 shipped a wrong figure');
    expect(screen.getByTestId('improvement-diff')).toHaveTextContent('step check + MUST: every figure has a source');
    fireEvent.click(within(detail).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(apiMock.acceptOrgImprovement).toHaveBeenCalledWith('ws1', 'IM-1'));
    // work sources
    const ws = screen.getByTestId('work-sources');
    expect(ws).toHaveTextContent('Self-started 70% · in Operating/Unsorted projects 80% · from retros 50%');
    expect(ws).toHaveTextContent('3 refused');
    expect(screen.getByTestId('unit-caps')).toHaveTextContent('Engineering 6/6');
    expect(screen.getAllByTestId('source-bar')[0]).toHaveTextContent('Retros · self-started');
    // the verified tab
    fireEvent.click(screen.getByRole('tab', { name: /Verified \(1\)/ }));
    await waitFor(() => expect(screen.getByTestId('improvement-list')).toHaveTextContent('IM-2 · Shorter standups'));
  });
});
