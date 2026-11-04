/** The section rails' frame (src/components/Rails.tsx): the rail title sits
 *  under the top bar with its own top space, and the Artifacts rail follows
 *  the workspace on screen (a switch never leaves the old workspace's tree). */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));
const { ArtifactsRail, SecondaryHeader } = await import('../src/components/Rails');

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
  Object.assign(fake, {
    workspaceId: 'ws2', fileTarget: { kind: 'workspace', id: 'ws1' }, currentFile: 'old.md', fileList: [], setFileTarget: vi.fn(), setCurrentFile: vi.fn(),
    refreshFiles: vi.fn(async () => undefined), openFile: vi.fn(), showToast: vi.fn(), onWorkspaceEvent: () => () => undefined, agents: [], workspaces: [{ id: 'ws1' }, { id: 'ws2' }],
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the rail frame', () => {
  it('the rail title has its own top space under the top bar (it is not flush against it)', () => {
    render(<SecondaryHeader title="Channels & chats" />);
    const title = screen.getByTestId('rail-title');
    expect(title.textContent).toBe('Channels & chats');
    expect(parseFloat(title.style.paddingTop)).toBeGreaterThanOrEqual(12);
  });

  it('Artifacts shows the workspace on screen: after a switch the old workspace\'s tree is replaced', () => {
    render(<ArtifactsRail />);
    expect(fake.setFileTarget).toHaveBeenCalledWith({ kind: 'workspace', id: 'ws2' });
    expect(fake.setCurrentFile).toHaveBeenCalledWith(null);
  });

  it('…and leaves the tree alone when it already is this workspace\'s', () => {
    fake.fileTarget = { kind: 'workspace', id: 'ws2' };
    render(<ArtifactsRail />);
    expect(fake.setFileTarget).not.toHaveBeenCalled();
  });
});
