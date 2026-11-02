/** The follow API client (docs/follows.md): the routes the Follow toggle
 *  calls, and the schema its response is checked against. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { followViewSchema } from '../src/lib/schemas';

afterEach(() => { vi.unstubAllGlobals(); });

const view = { following: true, reason: 'manual', followers: [{ followerKind: 'agent', followerId: 'a1', reason: 'assignee', createdAt: '2026-11-02T00:00:00Z' }] };

function stubFetch() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(view), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}

describe('follows API', () => {
  it('reads, follows, unfollows and marks seen on the workspace routes', async () => {
    const calls = stubFetch();
    expect(await api.follows('w1', 'thread', 'm/1')).toEqual(view);
    await api.follow('w1', 'org_task', 't1');
    await api.unfollow('w1', 'org_task', 't1');
    await api.markFollowSeen('w1', 'agent_task', 'k1');
    expect(calls).toEqual([
      { url: '/api/workspaces/w1/follows?targetKind=thread&targetId=m%2F1', method: 'GET', body: undefined },
      { url: '/api/workspaces/w1/follows', method: 'POST', body: { targetKind: 'org_task', targetId: 't1' } },
      { url: '/api/workspaces/w1/follows/unfollow', method: 'POST', body: { targetKind: 'org_task', targetId: 't1' } },
      { url: '/api/workspaces/w1/follows/seen', method: 'POST', body: { targetKind: 'agent_task', targetId: 'k1' } },
    ]);
  });

  it('the schema accepts the server view and rejects a follower of an unknown kind', () => {
    expect(followViewSchema.safeParse(view).success).toBe(true);
    expect(followViewSchema.safeParse({ ...view, followers: [{ ...view.followers[0], followerKind: 'robot' }] }).success).toBe(false);
  });
});
