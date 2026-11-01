/** The shared-workspace request header (docs/shared-agents.md §2): carried on
 *  workspace routes while a workspace shared with us is on screen, never on
 *  routes about our own account. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, setActiveSharedWorkspace } from '../src/lib/api';

afterEach(() => { setActiveSharedWorkspace(null); vi.unstubAllGlobals(); });

describe('authHeaders with a shared workspace active', () => {
  it('adds X-Yaam-Workspace to workspace routes and leaves own-account routes alone', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(authHeaders('/api/chats?workspaceId=w1')).toEqual({});
    setActiveSharedWorkspace('w1');
    expect(authHeaders('/api/chats?workspaceId=w1')).toEqual({ 'X-Yaam-Workspace': 'w1' });
    expect(authHeaders('/api/agents/a1/events')).toEqual({ 'X-Yaam-Workspace': 'w1' });
    expect(authHeaders('/api/workspaces/w1/members')).toEqual({ 'X-Yaam-Workspace': 'w1' });
    // these answer for *our* account whichever workspace is open
    expect(authHeaders('/api/workspaces')).toEqual({});
    expect(authHeaders('/api/workspaces/shared')).toEqual({});
    expect(authHeaders('/api/auth/me')).toEqual({});
    expect(authHeaders('/api/account')).toEqual({});
    expect(authHeaders('/api/push/subscribe')).toEqual({});
  });

  it('keeps the bearer token alongside the header', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'tok' });
    setActiveSharedWorkspace('w2');
    expect(authHeaders('/api/chats')).toEqual({ Authorization: 'Bearer tok', 'X-Yaam-Workspace': 'w2' });
  });
});
