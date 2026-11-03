/** Settings › Workspace › Organization: the Danger zone (archive, with
 *  "Export COMPANY.json first"), the archived company's banner and
 *  read-only view, Restore, and the delete dialog — what is removed, the
 *  choices, the name typed back (docs/owners-seat.md "Archive or delete
 *  the company"). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ArchivedOrg, type ArchivedOrgDetail, type Workspace } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));

const { OrgDangerZone, deleteBody, tableWords } = await import('../src/components/OrgDangerZone');

const ws = { id: 'ws1', name: 'Acme' } as Workspace;
const archived: ArchivedOrg = { id: 'o1', name: 'Acme Corp', mission: 'Make things', archivedAt: '2026-11-04T10:00:00Z', archivedBy: 'user', restoreStatus: 'paused', restoreMode: 'supervised', members: 3, deleting: false };
const detail: ArchivedOrgDetail = {
  org: { id: 'o1', name: 'Acme Corp', mission: 'Make things', values: '', culture: '', rules: '', chiefOfStaffAgentId: 'a1', monthlyBudgetUsd: 10, createdAt: '', archivedAt: archived.archivedAt, archivedBy: 'user', restoreStatus: 'paused', restoreMode: 'supervised', deleting: false },
  members: [{ agentId: 'a1', title: 'Chief of staff', status: 'active', reportsToAgentId: null, depth: 1, name: 'Ada', emoji: '🧭', exists: true }],
  goals: [{ id: 'g1', title: 'Ship v1', kind: 'objective', status: 'active' }],
  projects: [{ id: 'p1', title: 'Launch', status: 'active' }],
  units: [], decisions: [{ id: 'd1', title: 'Go weekly', decision: 'Weekly retro', decidedBy: 'user', createdAt: '' }], audit: [],
  counts: { org_tasks: 4, org_goals: 1 }, orgFiles: 2, liveCompany: null, canRestore: true,
};

function setApp(st: Record<string, unknown>, role: 'owner' | 'member' = 'owner') {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    wsOrg: st, me: { role }, showToast: vi.fn(),
    refreshWsOrg: vi.fn(async () => undefined), refreshWorkspaces: vi.fn(async () => undefined), refreshAgents: vi.fn(async () => undefined),
  });
}

beforeEach(() => { vi.spyOn(api, 'archivedOrg').mockResolvedValue(detail); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the Danger zone of a live company', () => {
  it('archives through a dialog that explains nothing is deleted and offers the export first', async () => {
    setApp({ orgId: 'o2', org: { id: 'o2', name: 'Live Co' }, archived: [] });
    const archive = vi.spyOn(api, 'archiveOrg').mockResolvedValue({ archived, status: {} as never });
    const exp = vi.spyOn(api, 'orgBlueprint').mockResolvedValue({ name: 'Live Co' } as never);
    URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn();
    render(<OrgDangerZone ws={ws} />);
    expect(screen.getByLabelText('Danger zone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive company…' }));
    const dlg = screen.getByRole('dialog', { name: 'Archive Live Co' });
    expect(dlg.textContent).toMatch(/Nothing is deleted/);
    expect(dlg.textContent).toMatch(/plain agents/);
    fireEvent.click(screen.getByRole('button', { name: 'Export COMPANY.json first' }));
    await waitFor(() => expect(exp).toHaveBeenCalledWith('ws1'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive company' }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith('ws1'));
    expect(fake.refreshWsOrg).toHaveBeenCalled();
  });

  it('is the owner\'s: a member sees no Danger zone', () => {
    setApp({ orgId: 'o2', org: { id: 'o2', name: 'Live Co' }, archived: [] }, 'member');
    render(<OrgDangerZone ws={ws} />);
    expect(screen.queryByLabelText('Danger zone')).toBeNull();
  });
});

describe('an archived company', () => {
  it('shows the banner and the read-only view, and restores', async () => {
    setApp({ orgId: null, org: null, archived: [archived] });
    const restore = vi.spyOn(api, 'restoreOrg').mockResolvedValue({ restored: { orgId: 'o1', status: 'paused', mode: 'supervised' }, status: {} as never });
    render(<OrgDangerZone ws={ws} />);
    expect(screen.getByRole('status').textContent).toMatch(/Archived company.*Acme Corp.*Read-only.*restores supervised, paused/);
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    const view = await screen.findByLabelText('Archived company (read-only)');
    expect(view.textContent).toMatch(/Ada/); expect(view.textContent).toMatch(/Ship v1/); expect(view.textContent).toMatch(/Go weekly/); expect(view.textContent).toMatch(/4 tasks/);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('ws1', 'o1'));
  });

  it('cannot be restored while another company is live', () => {
    setApp({ orgId: 'o2', org: { id: 'o2', name: 'Live Co' }, archived: [archived] });
    render(<OrgDangerZone ws={ws} />);
    expect((screen.getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes only with the name typed back, sending the chosen options', async () => {
    setApp({ orgId: null, org: null, archived: [archived] });
    const del = vi.spyOn(api, 'deleteOrg').mockResolvedValue({ ok: true, orgId: 'o1', name: 'Acme Corp', rows: {}, agents: { choice: 'delete', deleted: ['Ada'], kept: [] }, files: { choice: 'keep', moved: 2, to: '/archive/org-acme-corp-2026-11-04/' }, channels: { choice: 'delete', archived: 0, reopened: 0, deleted: 1 } });
    render(<OrgDangerZone ws={ws} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Delete Acme Corp permanently' });
    expect(dlg.textContent).toMatch(/cannot be undone/);
    expect(dlg.textContent).toMatch(/Kept:.*personal chats/);
    await waitFor(() => expect(screen.getByLabelText('What is removed').textContent).toMatch(/4 tasks/));
    expect(dlg.textContent).toMatch(/\/archive\/org-…-2026-11-04\//);
    const go = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme' } });
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Delete them.*agent\(s\)/));
    fireEvent.click(screen.getByLabelText(/Delete them.*#company stays/));
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Acme Corp' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(del).toHaveBeenCalledWith('ws1', { orgId: 'o1', confirmName: 'Acme Corp', agents: 'delete', files: 'keep', channels: 'delete' }));
    expect((fake.showToast as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatch(/Acme Corp is deleted — 1 agent\(s\) deleted, files moved to \/archive\/org-acme-corp-2026-11-04\//);
  });
});

describe('helpers', () => {
  it('builds the delete body and words the tables', () => {
    expect(deleteBody('o1', 'X', { agents: 'keep', files: 'delete', channels: 'archive' })).toEqual({ orgId: 'o1', confirmName: 'X', agents: 'keep', files: 'delete', channels: 'archive' });
    expect(tableWords('org_project_updates')).toBe('project updates');
    expect(tableWords('task_transitions')).toBe('task transitions');
  });
});
