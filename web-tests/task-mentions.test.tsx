/** Task @mentions in the SPA (docs/work-tracking.md "Mentions"): the task
 *  drawer's comment box autocompletes members and people with faces, posts
 *  the tag as written, and comments draw the server-resolved tags as chips;
 *  snippets (Inbox, Home) draw `@names` of members and people as chips. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgTaskHash } from '../src/lib/links';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { OrganizationView } = await import('../src/components/OrganizationView');
const { MentionText } = await import('../src/components/MentionBox');

const TASK = {
  id: 'abc12345-0000-4000-8000-000000000001', key: 'ENG-7', orgId: 'o1', projectId: null, parentTaskId: null, title: 'Q3 numbers', brief: '{}', status: 'in_progress',
  assigneeAgentId: 'a-writer', claimedBy: null, claimedAt: null, reviewerAgentId: null, reviewRounds: 0, blockers: '[]', fileScope: '[]', noProgressCount: 0,
  lastRunAt: null, createdBy: 'user', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', unitId: 'u2', unitExplicit: 0,
};
const ORG = { id: 'o1', workspaceId: 'ws1', name: 'Acme', mission: '', status: 'active', chiefOfStaffAgentId: null, members: [], goals: [], projects: [], budgets: [], grants: [], charterDrift: [] };
const MENTIONABLES = [
  { kind: 'agent', id: 'a-writer', name: 'Writer' },
  { kind: 'agent', id: 'a-editor', name: 'Editor in Chief' },
  { kind: 'human', id: 'm-bob', name: 'Bob Member' },
];
const COMMENTS = [
  { id: 'c1', orgId: 'o1', taskId: TASK.id, fromAgentId: 'a-writer', runId: null, text: 'Over to @Editor in Chief and @Bob Member — not @Nobody.', createdAt: '2026-11-02T00:00:00Z', mentions: JSON.stringify([{ kind: 'agent', id: 'a-editor' }, { kind: 'human', id: 'm-bob' }]), fromUserId: '' },
];

const posts: Array<{ url: string; body: unknown }> = [];
function route(url: string, init?: RequestInit): unknown {
  if (init?.method === 'POST') { posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) }); return { id: 'c2' }; }
  if (url === '/api/workspaces/ws1/org/mentionables') return MENTIONABLES;
  if (url.endsWith('/comments')) return COMMENTS;
  if (url.endsWith('/runs') || url.endsWith('/checks')) return [];
  if (url.startsWith('/api/workspaces/ws1/org/tasks/abc12345')) return TASK;
  if (url.startsWith('/api/workspaces/ws1/org/tasks')) return [];
  if (url === '/api/workspaces/ws1/org/detail') return ORG;
  if (url.includes('/org/capacity')) return { members: [] };
  if (url.includes('/follows')) return { following: false, reason: null, followers: [] };
  if (url.includes('/humans')) return { me: { role: 'ceo', actorId: 'single' }, humans: [] };
  return [];
}

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  posts.length = 0;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(route(String(url), init)), { status: 200, headers: { 'content-type': 'application/json' } })));
  Object.assign(fake, {
    workspaceId: 'ws1', companiesEnabled: true, wsOrg: { mode: 'supervised', orgId: 'o1', units: [] }, workspaces: [], fileList: [],
    agents: [{ id: 'a-writer', name: 'Writer', emoji: '✍️', colors: '[]' }, { id: 'a-editor', name: 'Editor in Chief', emoji: '🧐', colors: '[]' }],
    orgPane: 'board', orgUnitId: null, orgHeldActions: 0, stacked: false, me: { actorId: 'single' },
    orgFocus: { kind: 'task', id: 'abc12345' },
    setOrgFocus: vi.fn((v: unknown) => { fake.orgFocus = v; }), setOrgPane: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), showToast: vi.fn(), nameOf: (id: string) => id, openOrgTask: vi.fn(), openAgent: vi.fn(), openFile: vi.fn(),
  });
  window.history.replaceState(null, '', `/${orgTaskHash('ws1', 'abc12345')}`);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('task mentions', () => {
  it('comments draw the server-resolved tags as chips, and nothing for a name that tagged nobody', async () => {
    render(<OrganizationView />);
    await waitFor(() => expect(screen.getAllByTestId('task-comment').length).toBe(1));
    await waitFor(() => expect(document.querySelectorAll('[data-testid="task-comment"] [data-mention]').length).toBe(2));
    const chips = [...document.querySelectorAll('[data-testid="task-comment"] [data-mention]')].map((x) => [x.getAttribute('data-mention'), x.textContent]);
    expect(chips).toEqual([['agent', '@Editor in Chief'], ['human', '@Bob Member']]);
  });

  it('the comment box autocompletes members and people and posts the tag', async () => {
    render(<OrganizationView />);
    const box = await screen.findByRole('textbox', { name: 'Comment' });
    await waitFor(() => expect(document.querySelectorAll('[data-testid="task-comment"] [data-mention]').length).toBe(2)); // mentionables loaded
    fireEvent.change(box, { target: { value: 'Please check @ed', selectionStart: 16 } });
    const menu = await screen.findByTestId('mention-menu');
    expect(menu.textContent).toContain('Editor in Chief');
    expect(menu.textContent).toContain('member');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((box as HTMLInputElement).value).toBe('Please check @editor-in-chief ');
    // a person too
    fireEvent.change(box, { target: { value: 'Please check @editor-in-chief and @bo', selectionStart: 37 } });
    expect((await screen.findByTestId('mention-menu')).textContent).toContain('person');
    fireEvent.keyDown(box, { key: 'Tab' });
    expect((box as HTMLInputElement).value).toBe('Please check @editor-in-chief and @bob-member ');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0].url).toBe(`/api/workspaces/ws1/org/tasks/${TASK.id}/comment`);
    expect(posts[0].body).toEqual({ text: 'Please check @editor-in-chief and @bob-member' });
  });

  it('snippets draw @names of members and people as chips (Inbox, Home)', () => {
    const members = MENTIONABLES.map((m) => ({ ...m, kind: m.kind as 'agent' | 'human' }));
    const { container } = render(<span><MentionText text="Writer: commented: @Bob Member can you sign off? cc nobody@x.io" members={members} /></span>);
    expect([...container.querySelectorAll('[data-mention]')].map((x) => x.textContent)).toEqual(['@Bob Member']);
    const plain = render(<span><MentionText text="no tags here" members={members} /></span>);
    expect(plain.container.querySelectorAll('[data-mention]').length).toBe(0);
  });
});
