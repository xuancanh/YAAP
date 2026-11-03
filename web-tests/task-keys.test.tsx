/** Task keys in the SPA (docs/tasks-keys.md): the helpers, `ENG-12` chips in
 *  text (only for known prefixes), the deep link by key, and the key on the
 *  board card and the drawer (with copy). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Markdown, type RefResolver } from '../src/lib/md';
import { orgTaskHash, parseOrgHash } from '../src/lib/links';
import { isTaskKey, keyPrefix, matchesTaskRef, normalizeTaskKey, taskRef, unitKeyPrefixes } from '../src/lib/task-keys';
import type { OrgUnitNode } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { OrganizationView } = await import('../src/components/OrganizationView');

describe('task key helpers', () => {
  it('normalise, match and name tasks', () => {
    expect(isTaskKey('eng-12')).toBe(true);
    expect(isTaskKey('b4b81f6f')).toBe(false);
    expect(normalizeTaskKey(' eng-012 ')).toBe('ENG-12');
    expect(keyPrefix('SALES2-4')).toBe('SALES2');
    const t = { id: 'b4b81f6f-0000-4000-8000-000000000001', key: 'ENG-12' };
    expect(matchesTaskRef(t, 'eng-12')).toBe(true);
    expect(matchesTaskRef(t, 'ENG-1')).toBe(false);
    expect(matchesTaskRef(t, 'b4b81f6f')).toBe(true);
    expect(taskRef(t)).toBe('ENG-12');
    expect(taskRef({ id: '91ef6d61-aaaa' })).toBe('91ef6d61');
    const units = [{ taskKey: 'CO', children: [{ taskKey: 'ENG', children: [] }] }] as unknown as OrgUnitNode[];
    expect([...unitKeyPrefixes(units)]).toEqual(['CO', 'ENG']);
  });

  it('the deep link carries a key', () => {
    expect(orgTaskHash('ws1', 'ENG-12')).toBe('#/ws/ws1/org/board?task=ENG-12');
    expect(parseOrgHash('#/ws/ws1/org/board?task=ENG-12')?.taskId).toBe('ENG-12');
  });
});

describe('task key chips', () => {
  const known = new Set(['ENG']);
  const opened: string[] = [];
  const refs: RefResolver = (kind, id) => {
    if (kind !== 'task') return null;
    const key = normalizeTaskKey(id);
    return key && known.has(keyPrefix(key)) ? { label: key, onClick: () => opened.push(key) } : null;
  };

  it('a bare key with a known prefix is a chip; unknown ones, code spans and URLs stay as they are', () => {
    const { container } = render(<Markdown text={'Done ENG-12, see #task:eng-3. GPT-4 and UTF-8 are not tasks; `ENG-5` is code; https://x.io/ENG-6'} refs={refs} />);
    const chips = [...container.querySelectorAll('button[data-ref="task"]')].map((b) => b.textContent);
    expect(chips).toEqual(['☐ ENG-12', '☐ ENG-3']);
    expect(container.textContent).toContain('GPT-4 and UTF-8');
    expect(container.querySelector('code')?.textContent).toBe('ENG-5');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.io/ENG-6');
    fireEvent.click(screen.getByRole('button', { name: '☐ ENG-12' }));
    expect(opened).toEqual(['ENG-12']);
  });

  it('without a resolver a key is plain text', () => {
    const { container } = render(<Markdown text="ENG-12 shipped" />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('ENG-12 shipped');
  });
});

const TASK = {
  id: 'abc12345-0000-4000-8000-000000000001', key: 'ENG-12', orgId: 'o1', projectId: null, parentTaskId: null, title: 'Ship the API', brief: '{}', status: 'todo',
  assigneeAgentId: null, claimedBy: null, claimedAt: null, reviewerAgentId: null, reviewRounds: 0, blockers: '[]', fileScope: '[]', noProgressCount: 0,
  lastRunAt: null, createdBy: 'user', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', unitId: null, unitExplicit: 0,
};
const ORG = { id: 'o1', workspaceId: 'ws1', name: 'Acme', mission: '', status: 'active', chiefOfStaffAgentId: null, members: [], goals: [], projects: [], budgets: [], grants: [], charterDrift: [] };

function route(url: string): unknown {
  if (url.startsWith('/api/workspaces/ws1/org/tasks')) return [TASK];
  if (url === '/api/workspaces/ws1/org/detail') return ORG;
  if (url.includes('/org/capacity')) return { members: [] };
  if (url.includes('/follows')) return { following: false, reason: null, followers: [] };
  if (url.includes('/humans')) return { me: { role: 'ceo', actorId: 'single' }, humans: [] };
  return [];
}

describe('the board by key', () => {
  const writeText = vi.fn(async () => undefined);
  beforeEach(() => {
    for (const k of Object.keys(fake)) delete fake[k];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(route(String(url))), { status: 200, headers: { 'content-type': 'application/json' } })));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.assign(fake, {
      workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, workspaces: [], agents: [], fileList: [],
      orgPane: 'board', orgUnitId: null, orgHeldActions: 0, stacked: false,
      orgFocus: { kind: 'task', id: 'eng-12' },
      setOrgFocus: vi.fn((v: unknown) => { fake.orgFocus = v; }), setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(),
      refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(), nameOf: (id: string) => id, openOrgTask: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(),
    });
    window.history.replaceState(null, '', `/${orgTaskHash('ws1', 'eng-12')}`);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

  it('?task=eng-12 opens the drawer; the card and the header show the key, which copies', async () => {
    render(<OrganizationView section="operations" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ship the API' })).toBeInTheDocument());
    expect(window.location.hash).toBe('#/ws/ws1/org/board?task=ENG-12');
    fireEvent.click(screen.getByRole('button', { name: 'Copy task key ENG-12' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ENG-12'));
    expect(screen.getAllByText('ENG-12').length).toBeGreaterThan(0);
  });
});
