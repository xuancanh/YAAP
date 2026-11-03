/** The task deep link (docs/home.md "Links"): `#/ws/<id>/org/board?task=<id>`
 *  parses to the board and the task; opening it shows the task's drawer even
 *  when the task is not on the loaded board (fetched by id), keeps the link
 *  in the address while the drawer is open (reload), and the address moving
 *  off it (back) closes the drawer. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgTaskHash, parseOrgHash, taskOfHash } from '../src/lib/links';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { OrganizationView } = await import('../src/components/OrganizationView');

const TASK = {
  id: 'abc12345-0000-4000-8000-000000000001', orgId: 'o1', projectId: null, parentTaskId: null, title: 'Close the books', brief: '{}', status: 'done',
  assigneeAgentId: null, claimedBy: null, claimedAt: null, reviewerAgentId: null, reviewRounds: 0, blockers: '[]', fileScope: '[]', noProgressCount: 0,
  lastRunAt: null, createdBy: 'user', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', unitId: 'u2', unitExplicit: 0,
};
const ORG = { id: 'o1', workspaceId: 'ws1', name: 'Acme', mission: '', status: 'active', chiefOfStaffAgentId: null, members: [], goals: [], projects: [], budgets: [], grants: [], charterDrift: [] };

const calls: string[] = [];
function route(url: string): unknown {
  calls.push(url);
  if (url.startsWith(`/api/workspaces/ws1/org/tasks/${encodeURIComponent('abc12345')}`)) return TASK;
  if (url.startsWith('/api/workspaces/ws1/org/tasks')) return []; // the loaded board does not have it
  if (url === '/api/workspaces/ws1/org/detail') return ORG;
  if (url.includes('/org/capacity')) return { members: [] };
  if (url.includes('/follows')) return { following: false, reason: null, followers: [] };
  if (url.includes('/humans')) return { me: { role: 'ceo', actorId: 'single' }, humans: [] };
  return [];
}

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(route(String(url))), { status: 200, headers: { 'content-type': 'application/json' } })));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, workspaces: [], agents: [], fileList: [],
    orgPane: 'board', orgUnitId: null, orgHeldActions: 0, stacked: false,
    orgFocus: { kind: 'task', id: 'abc12345' },
    setOrgFocus: vi.fn((v: unknown) => { fake.orgFocus = v; }), setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(), nameOf: (id: string) => id, openOrgTask: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(),
  });
  window.history.replaceState(null, '', `/${orgTaskHash('ws1', 'abc12345')}`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('the task link', () => {
  it('parses and builds', () => {
    expect(orgTaskHash('ws1', 't-1')).toBe('#/ws/ws1/org/board?task=t-1');
    expect(parseOrgHash('#/ws/ws1/org/board?task=t-1')).toEqual({ workspaceId: 'ws1', pane: 'board', taskId: 't-1' });
    expect(parseOrgHash('#/ws/ws1/org/pulse')).toEqual({ workspaceId: 'ws1', pane: 'pulse', taskId: null });
    expect(parseOrgHash('#/ws/ws1/org/board?task=<script>')?.taskId).toBeNull();
    expect(parseOrgHash('#/ws/ws1/channel/general')).toBeNull();
    expect(taskOfHash('#/chat/abc')).toBeNull();
  });

  it('opens the drawer for a task that is not on the loaded board, and back closes it', async () => {
    render(<OrganizationView section="operations" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Close the books' })).toBeInTheDocument());
    expect(calls.some((u) => u.endsWith('/org/tasks/abc12345'))).toBe(true);
    expect(fake.setOrgFocus).toHaveBeenCalledWith(null);
    expect(window.location.hash).toBe('#/ws/ws1/org/board?task=abc12345'); // reload reopens it
    // back: the address moves off the task, the drawer closes
    act(() => { window.history.replaceState(null, '', '/'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Close the books' })).toBeNull());
  });

  it('closing the drawer takes the task off the address', async () => {
    render(<OrganizationView section="operations" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Close the books' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Close the books' })).toBeNull();
    expect(window.location.hash).toBe('');
  });
});
