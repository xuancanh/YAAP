/** The agent's Memory tab (docs/agent-memory.md §12): lessons with their
 *  evidence and counts, what was learned this week, retired ones apart, the
 *  agent's own How I work section with where each change came from, the
 *  guidance proposals waiting on a decision, and a person's pin, edit,
 *  retire and forget. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type AgentGuidanceView, type AgentLesson } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));

const { MemoryTab, learnedThisWeek, refLabel } = await import('../src/components/AgentMemoryTab');

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const lesson = (over: Partial<AgentLesson>): AgentLesson => ({
  id: 'les_aaaaaaaa1', agentId: 'a1', text: 'x', sourceKind: 'loop', sourceSessionId: null, trusted: 1, pinned: 0, useCount: 1,
  audience: 'shared', cause: '', context: '', evidence: '[]', tags: '', recalls: 0, status: 'active', statusNote: '',
  createdAt: daysAgo(30), updatedAt: daysAgo(30), ...over,
});
const rows: AgentLesson[] = [
  lesson({ id: 'les_review01x', text: 'Every price needs its read date and its page.', cause: 'review', useCount: 3, recalls: 2, evidence: '["task:REJ-17","session:s1"]', context: 'REJ-17 was sent back in review (round 1)', createdAt: daysAgo(2), updatedAt: daysAgo(1) }),
  lesson({ id: 'les_oldone01', text: 'An old habit about fax machines.', createdAt: daysAgo(40), updatedAt: daysAgo(40) }),
  lesson({ id: 'les_retired1', text: 'Ask the editor for every read.', status: 'retired', statusNote: 'the editor role was removed' }),
  lesson({ id: 'les_app00001', text: 'Approve what the app asks.', trusted: 0, sourceKind: 'app' }),
];
const guidance: AgentGuidanceView = {
  selfGuidance: '- I open primary sources before I quote a figure.',
  changes: [
    { id: 'g1', agentId: 'a1', kind: 'self', status: 'applied', text: '- I open primary sources before I quote a figure.', lessonIds: '["les_review01x"]', ref: '', by: 'agent', why: 'pricing reviews kept bouncing', createdAt: daysAgo(1), decidedAt: null },
    { id: 'g2', agentId: 'a1', kind: 'charter', status: 'pending', text: 'Learned in the work:\n- Every price needs its read date and its page. (learned 3×)', lessonIds: '["les_review01x"]', ref: 'apr_1', by: 'system', why: 'learned 3× or more', createdAt: daysAgo(1), decidedAt: null },
  ],
  pending: [],
};
guidance.pending = guidance.changes.filter((c) => c.status === 'pending');
const agent = { id: 'a1', name: 'Ada' } as unknown as Agent;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { me: { role: 'owner', hasMembers: false }, nameOf: (id: string) => id, showToast: vi.fn() });
  vi.spyOn(api, 'agentLessons').mockResolvedValue(rows);
  vi.spyOn(api, 'agentGuidance').mockResolvedValue(guidance);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('agent Memory tab', () => {
  it('shows lessons with what made them, counts and evidence; retired and quarantined apart', async () => {
    render(<MemoryTab a={agent} />);
    await screen.findByText('Every price needs its read date and its page.');
    const row = screen.getAllByTestId('lesson-row')[0];
    expect(row.textContent).toMatch(/review sent it back · learned 3× · recalled 2×/);
    expect(row.textContent).toMatch(/REJ-17/);
    expect(row.textContent).not.toMatch(/session/);
    expect(row.textContent).toMatch(/sent back in review \(round 1\)/);
    expect(screen.queryByText('Ask the editor for every read.')).toBeNull();
    expect(screen.getByText(/Awaiting review · 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Retired 1/ }));
    expect(screen.getByText('Ask the editor for every read.')).toBeTruthy();
    expect(screen.getByText(/the editor role was removed/)).toBeTruthy();
  });

  it('filters to what was learned this week', async () => {
    render(<MemoryTab a={agent} />);
    await screen.findByText('Every price needs its read date and its page.');
    fireEvent.click(screen.getByRole('tab', { name: /Learned this week 1/ }));
    expect(screen.getByText('Every price needs its read date and its page.')).toBeTruthy();
    expect(screen.queryByText('An old habit about fax machines.')).toBeNull();
    expect(learnedThisWeek(rows[1])).toBe(false);
    expect(refLabel('meeting:abcdef123456')).toBe('meeting abcdef12');
  });

  it('shows How I work with where it came from, and the pending proposals with their lessons', async () => {
    render(<MemoryTab a={agent} />);
    const how = await screen.findByTestId('how-i-work');
    await waitFor(() => expect(how.textContent).toMatch(/I open primary sources/));
    const change = within(how).getByTestId('guidance-change');
    expect(change.textContent).toMatch(/revised by Ada: pricing reviews kept bouncing ?· from\[review01\]/);
    const proposals = screen.getByTestId('guidance-proposals');
    expect(proposals.textContent).toMatch(/Waiting on a decision · 1/);
    expect(proposals.textContent).toMatch(/Charter change — the CEO decides the card/);
    expect(proposals.textContent).toMatch(/Every price needs its read date/);
  });

  it('a person pins, edits, retires and forgets a lesson, and edits How I work', async () => {
    const patch = vi.spyOn(api, 'patchLesson').mockResolvedValue(rows[0]);
    const del = vi.spyOn(api, 'deleteLesson').mockResolvedValue({ ok: true });
    const put = vi.spyOn(api, 'putAgentGuidance').mockResolvedValue(guidance);
    render(<MemoryTab a={agent} />);
    await screen.findByText('Every price needs its read date and its page.');
    const row = () => screen.getAllByTestId('lesson-row')[0];
    fireEvent.click(within(row()).getByText('Pin'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('a1', 'les_review01x', { pinned: true }));
    await waitFor(() => expect((within(row()).getByText('Edit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(row()).getByText('Edit'));
    const box = within(row()).getByLabelText('Lesson text') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Every price needs its read date, its page and its currency.' } });
    expect(document.activeElement === box || within(row()).getByLabelText('Lesson text') === box).toBe(true);
    fireEvent.click(within(row()).getByText('Save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('a1', 'les_review01x', { text: 'Every price needs its read date, its page and its currency.' }));
    await waitFor(() => expect(within(row()).queryByLabelText('Lesson text')).toBeNull());
    fireEvent.click(within(row()).getByText('Retire'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('a1', 'les_review01x', { status: 'retired' }));
    await waitFor(() => expect((within(row()).getByText('Forget') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(row()).getByText('Forget'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('a1', 'les_review01x'));
    const how = screen.getByTestId('how-i-work');
    fireEvent.click(within(how).getByText('Edit'));
    fireEvent.change(within(how).getByLabelText('How I work'), { target: { value: '- I cite the page I read.' } });
    fireEvent.click(within(how).getByText('Save'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('a1', '- I cite the page I read.'));
  });
});
