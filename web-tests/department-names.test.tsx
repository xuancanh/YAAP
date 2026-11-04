/** Department names in the SPA (docs/group-chat.md §7 "Department names"):
 *  the channel header reads "Department · <name>", the CEO renames it in
 *  place (the channel moves to its new slug), an employee sees no rename,
 *  and an old slug redirects to the channel's current one. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, ChannelDetail } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { ChannelView } = await import('../src/components/ChannelView');
const { DepartmentName, resetDepartmentRoles } = await import('../src/components/DepartmentName');

const calls: Array<{ url: string; method: string; body: unknown }> = [];
let role: string | null = 'ceo';
let detailSlug = 'engineering';

const eng: Channel = {
  id: 'c-eng', workspaceId: 'ws1', slug: 'engineering', name: 'Engineering', topic: 'Department channel of Engineering: Ada and its reports.', kind: 'public', createdBy: 'system', folder: 'channels/ada',
  dailyTokenBudget: 0, archivedAt: null, createdAt: '2026-11-01T00:00:00.000Z', unread: 0, memberCount: 3, pastSubs: 0, channelKind: 'channel', parentChannelId: null, status: 'open', purpose: '',
};
const detail = (): ChannelDetail => ({
  ...eng, slug: detailSlug, members: [], spentToday: 0, orgMode: false, parent: null, subs: [], pastSubs: 0,
  unit: { id: 'u-eng', name: 'Engineering', slug: detailSlug, orgId: 'o1', leadAgentId: 'ada' },
});

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  calls.length = 0; role = 'ceo'; detailSlug = 'engineering';
  resetDepartmentRoles();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(url), method, body });
    const u = String(url);
    const out = u.endsWith('/org/humans') ? { ceoAccountId: 'me', me: { actorId: 'me', role }, humans: [] }
      : u.includes('/org/units/u-eng') && method === 'PATCH' ? { id: 'u-eng', name: (body as { name: string }).name, slug: 'platform', taskKey: 'ENG' }
      : u.includes('/messages') ? { messages: [], replies: {}, hasMore: false }
      : /\/chat\/channels\/[a-z-]+$/.test(u) ? detail()
      : {};
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  Object.assign(fake, {
    workspaceId: 'ws1', stacked: false, me: { actorId: 'me' }, agents: [], channels: [eng], currentChannel: 'engineering', channelFocus: null, setChannelFocus: vi.fn(),
    onWorkspaceEvent: () => () => undefined, wsOrg: { units: [{ id: 'u-root', name: 'Acme', slug: 'company', parentUnitId: null }] }, companiesEnabled: false,
    homeView: 'channel', setMobileChatOpen: vi.fn(), openOrgTask: vi.fn(), openAgent: vi.fn(), setOrgUnitId: vi.fn(), setOrgPane: vi.fn(), go: vi.fn(), setMobileDetail: vi.fn(), setOrgFocus: vi.fn(),
    showToast: vi.fn(), openChannel: vi.fn(), openFile: vi.fn(), refreshChannels: vi.fn(async () => undefined), refreshWsOrg: vi.fn(async () => undefined), nameOf: (id: string) => id,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the channel header', () => {
  it('reads "Department · <name>" (not "Unit channel"), and the CEO renames in place: PATCH the unit, then follow the channel to its new slug', async () => {
    render(<ChannelView />);
    await waitFor(() => expect(screen.getByTestId('department-label').textContent).toMatch(/^Department ·Engineering/));
    expect(screen.queryByText(/Unit channel/)).toBeNull();
    const pen = await screen.findByRole('button', { name: 'Rename the Engineering department' });
    fireEvent.click(pen);
    const field = screen.getByLabelText('Department name');
    fireEvent.change(field, { target: { value: 'Platform' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(fake.openChannel).toHaveBeenCalledWith('platform', null, { replace: true }));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/workspaces/ws1/org/units/u-eng');
    expect(patch.body).toEqual({ name: 'Platform' });
    expect(fake.showToast).toHaveBeenCalledWith('Department renamed to Platform (#platform)');
    expect(fake.refreshWsOrg).toHaveBeenCalled();
  });

  it('an employee sees the name without a rename control', async () => {
    role = 'employee';
    render(<ChannelView />);
    await waitFor(() => expect(screen.getByTestId('department-label').textContent).toMatch(/Engineering/));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/org/humans'))).toBe(true));
    expect(screen.queryByRole('button', { name: /Rename the/ })).toBeNull();
  });

  it('an old slug (a renamed department) redirects to the channel\'s current address', async () => {
    fake.currentChannel = 'ada';
    fake.channels = [];
    render(<ChannelView />);
    await waitFor(() => expect(fake.openChannel).toHaveBeenCalledWith('engineering', null, { replace: true }));
  });
});

describe('DepartmentName', () => {
  it('Escape cancels without a request; an unchanged name saves nothing', async () => {
    render(<DepartmentName wsId="ws1" unitId="u-eng" name="Engineering" editable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename the Engineering department' }));
    fireEvent.keyDown(screen.getByLabelText('Department name'), { key: 'Escape' });
    expect(screen.queryByLabelText('Department name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rename the Engineering department' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByLabelText('Department name')).toBeNull());
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });
});
