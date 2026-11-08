/** Direction › Alignment (docs/alignment.md): the badges, the groups and
 *  the decisions behind the page, and the page itself — "Needs your
 *  alignment" first, the brief with the owner's classification, the thread
 *  and the decision buttons (a note is required where it should be), what
 *  agents did not escalate with the spot-check flag and the pull-in, the
 *  history, the classes; the Direction overview's "Awaiting your
 *  alignment" card and badges; the Inbox's facts for an alignment card. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgAlignment, OrgDetail } from '../src/lib/api';
import { alignmentActions, alignmentBadge, alignmentGroups, classGroups, criteriaLines, notePrompt, threadWho } from '../src/lib/alignment';
import { feedFacts, feedLongText, feedOpen, openLabel } from '../src/lib/feed';
import type { FeedItem } from '../src/lib/api';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => 'none' }));

const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const brief = { what: 'Double weekly readers this quarter', why: 'Retention is flat; readers drive revenue', options: ['Do nothing', 'Paid acquisition'], tradeoffs: 'The redesign waits', measures: 'Readers 1k → 2k by Dec 31', cost: 'Two members, $40/month', unlocks: 'The referral project' };
const al = (id: string, over: Partial<OrgAlignment> = {}): OrgAlignment => ({
  id, itemType: 'objective', itemId: `g-${id}`, itemClass: 'okr', label: 'objective', title: `Item ${id}`, state: 'draft', version: 1, alignedVersion: null, alignedBy: '', alignedVia: '', alignedAt: null, conditions: '',
  ownerAgentId: 'a2', brief: { what: '', why: '', options: [], tradeoffs: '', measures: '', cost: '', unlocks: '' }, thread: [], approvalId: null, bundleOf: null, requestedBy: '', requestedAt: null, reopenReasons: [],
  reviewDueAt: null, reviewDue: false, aligner: 'ceo', awaitingCeo: false, needsCeoReview: false, parentId: null, needsAlignment: null, classification: null, floor: true, pulledInAt: null, updatedAt: day(1), ...over,
});
const ITEMS: OrgAlignment[] = [
  al('1', { title: 'Grow the readership', state: 'in_alignment', awaitingCeo: true, approvalId: 'card1', brief, requestedAt: day(0.1), needsAlignment: true,
    classification: { needs: true, class: 'okr', reasoning: 'A company objective for the quarter.', criteria: { reversibility: 'two_way', blastRadius: 'company' }, assessed: { needs: true, reasons: ['its blast radius is the whole company'], suggestedClass: null }, by: 'agent:a2', at: day(0.2) },
    thread: [{ at: day(0.1), by: 'agent:a2', kind: 'request', text: 'Asked for alignment (v1)' }, { at: day(0.05), by: 'user', kind: 'comment', text: 'Why not paid first?' }] }),
  al('2', { title: 'Weekly readers to 2000', itemType: 'key_result', label: 'key result', state: 'in_alignment', bundleOf: '1', parentId: 'g-1' }),
  al('3', { title: 'New pricing page for partners', itemType: 'project', itemClass: 'projectBet', label: 'project bet', state: 'not_required', floor: false, needsAlignment: false,
    classification: { needs: false, class: 'projectBet', reasoning: 'Only a page; we can change it any time.', criteria: { reversibility: 'two_way' }, assessed: { needs: false, reasons: [], suggestedClass: null }, by: 'agent:a2', at: day(1) } }),
  al('4', { title: 'The newsletter for indie makers', itemType: 'vision', itemClass: 'direction', label: 'direction', state: 'aligned', alignedVia: 'chief', alignedAt: day(2), alignedVersion: 1, needsCeoReview: true }),
  al('5', { title: 'Template refresh', itemType: 'project', label: 'project bet', state: 'draft', floor: false }),
  al('6', { title: 'Q3 objectives', state: 'aligned', alignedVia: 'ceo', alignedAt: day(40), alignedVersion: 2, version: 2, conditions: 'Cap paid at $20' }),
];

const apiMock = {
  orgAlignments: vi.fn(async () => ITEMS),
  orgAlignmentClasses: vi.fn(async () => ({ mode: 'supervised', criteria: [], sources: { 'bezos-2015': { title: 'Amazon 2015 letter', url: 'https://example.com' } }, classes: [
    { id: 'direction', label: 'product direction', covers: 'The vision.', examples: [], criteria: [], rationale: 'The CEO sets direction.', sources: ['bezos-2015'], aligner: 'ceo', floor: true },
    { id: 'projectBet', label: 'project bet', covers: 'A bet.', examples: [], criteria: [], rationale: 'Betting table.', sources: [], aligner: 'ceo', floor: false },
  ] })),
  orgAlignmentSpotCheck: vi.fn(async () => [{ alignmentId: '3', kind: 'under', title: 'New pricing page for partners', label: 'project bet', owner: 'a2', why: 'it mentions "pricing"' }]),
  decideOrgAlignment: vi.fn(async () => ITEMS[0]),
  commentOrgAlignment: vi.fn(async () => ITEMS[0]),
};
vi.mock('../src/lib/api', async (orig) => ({ ...(await orig<typeof import('../src/lib/api')>()), api: apiMock }));

const { AlignmentPane } = await import('../src/components/AlignmentView');
const org = { id: 'o1', workspaceId: 'ws1', name: 'Acme', chiefOfStaffAgentId: 'a1', members: [] } as unknown as OrgDetail;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  for (const f of Object.values(apiMock)) f.mockClear();
  Object.assign(fake, {
    workspaceId: 'ws1', stacked: false, orgFocus: null,
    agents: [{ id: 'a1', name: 'Atlas', emoji: '🧭', colors: '' }, { id: 'a2', name: 'Writer', emoji: '✍️', colors: '' }],
    setOrgPane: vi.fn(), setOrgFocus: vi.fn(), setOrgUnitId: vi.fn(), setMobileDetail: vi.fn(), showToast: vi.fn(), refreshWsOrg: vi.fn(async () => undefined),
  });
});

describe('alignment on screen: the pure parts', () => {
  it('badges say the state from the CEO\'s side', () => {
    expect(alignmentBadge(ITEMS[0]).label).toBe('Needs your alignment');
    expect(alignmentBadge(ITEMS[2]).label).toBe('Not escalated');
    expect(alignmentBadge(ITEMS[3]).label).toBe('Aligned by the chief');
    expect(alignmentBadge(ITEMS[5]).label).toBe('Aligned');
    expect(alignmentBadge({ ...ITEMS[5], reviewDue: true }).label).toBe('Re-alignment due');
    expect(alignmentBadge(al('x', { state: 'realign' })).tone).toBe('warn');
  });
  it('groups what needs you, what was not escalated, what is with the owners and the history; bundles stay with their parent', () => {
    const g = alignmentGroups(ITEMS);
    expect(g.needsYou.map((a) => a.id)).toEqual(['1', '4']);
    expect(g.notEscalated.map((a) => a.id)).toEqual(['3']);
    expect(g.inFlight.map((a) => a.id)).toEqual(['5']);
    expect(g.history.map((a) => a.id)).toEqual(['4', '6']);
  });
  it('offers the decisions that fit the state', () => {
    expect(alignmentActions(ITEMS[0]).map((a) => a.id)).toEqual(['approve', 'approve_with_changes', 'send_back', 'reject', 'not_needed']);
    expect(alignmentActions(ITEMS[2]).map((a) => a.id)).toEqual(['pull_in']);
    expect(alignmentActions(ITEMS[3]).map((a) => a.id)).toEqual(['approve', 'approve_with_changes', 'send_back', 'reject']);
    expect(alignmentActions(ITEMS[0]).find((a) => a.id === 'send_back')!.needsNote).toBe(true);
    expect(criteriaLines({ reversibility: 'one_way', costShare: 0.25, externalCommitment: true })).toEqual(['One-way door', '25% of the envelope', 'External commitment']);
    expect(threadWho({ by: 'user' }, () => undefined)).toBe('You');
    expect(threadWho({ by: 'agent:a2' }, () => 'Writer')).toBe('Writer');
    // A decision that needs words asks for them in its own terms; re-opening an aligned item is a send-back.
    expect(notePrompt('send_back', 'in_alignment')!.confirm).toBe('Send back');
    expect(notePrompt('send_back', 'aligned')!.confirm).toBe('Re-open');
    expect(notePrompt('approve', 'in_alignment')).toBeNull();
  });
  it('groups the classes by who aligns them here', () => {
    const cls = [{ id: 'a', aligner: 'ceo' as const, floor: true }, { id: 'b', aligner: 'ceo' as const, floor: false }, { id: 'c', aligner: 'chief' as const, floor: false }, { id: 'd', aligner: 'auto' as const, floor: false }];
    expect(classGroups(cls, 'supervised').map((g) => [g.group, g.classes.map((c) => c.id)])).toEqual([['always', ['a']], ['owner', ['b']], ['chief', ['c']], ['auto', ['d']]]);
    expect(classGroups(cls, 'autonomous').map((g) => g.group)).toEqual(['always', 'chief', 'auto']);
  });
  it('the Inbox reading pane shows the brief of an alignment card', () => {
    const item = { need: { subkind: 'alignment', facts: { label: 'objective', title: 'Grow the readership', classLabel: 'OKRs and the plan', why: brief.why, options: brief.options, measures: brief.measures, cost: brief.cost, unlocks: brief.unlocks, what: brief.what, classifiedReasoning: 'A company objective.' } } } as unknown as FeedItem;
    const facts = feedFacts(item);
    expect(facts.map((f) => f.label)).toEqual(['Class', 'Why', 'Options', 'Measures', 'Cost', 'Unlocks', 'Owner\'s reasoning']);
    expect(facts.find((f) => f.label === 'Options')!.value).toBe('1. Do nothing\n2. Paid acquisition');
    expect(feedLongText(item)).toEqual({ label: 'What to align on', text: brief.what, lead: true });
  });
  it('an alignment card opens its brief on the Alignment page, not the generic queue', () => {
    const item = { type: 'decision', actions: ['approve', 'reject'], context: {}, target: { kind: 'need', need: { kind: 'approval', ref: { approvalId: 'c1' } } }, need: { kind: 'approval', subkind: 'alignment', ref: { approvalId: 'c1' }, facts: { alignmentId: 'al-1' } } } as unknown as FeedItem;
    expect(feedOpen(item)).toEqual({ to: 'pane', pane: 'alignment', focus: { kind: 'alignment', id: 'al-1' } });
    expect(openLabel(item)).toBe('Open the brief');
  });
});

describe('the Alignment page', () => {
  it('leads with what needs you and shows the brief, the classification and the thread', async () => {
    render(<AlignmentPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('dash-card-needs-alignment')).toHaveTextContent('Grow the readership'));
    const needs = screen.getByTestId('dash-card-needs-alignment');
    expect(within(needs).getAllByTestId('alignment-row')).toHaveLength(2);
    expect(needs).toHaveTextContent('Aligned by the chief');
    const briefCard = screen.getByTestId('alignment-brief');
    expect(screen.getByTestId('brief-what')).toHaveTextContent(brief.what);
    expect(screen.getByTestId('brief-fields')).toHaveTextContent('Options considered');
    expect(screen.getByTestId('brief-fields')).toHaveTextContent('Paid acquisition');
    expect(screen.getByTestId('brief-fields')).toHaveTextContent('The referral project');
    expect(screen.getByTestId('brief-classification')).toHaveTextContent('Why it needs you');
    expect(screen.getByTestId('brief-classification')).toHaveTextContent('Always yours here');
    expect(screen.getByTestId('brief-classification')).toHaveTextContent('A company objective for the quarter.');
    expect(briefCard).toHaveTextContent('Aligned with it');
    expect(briefCard).toHaveTextContent('Key result Weekly readers to 2000');
    // the counts at the top, and the classes grouped by who aligns them
    expect(screen.getByTestId('alignment-counts')).toHaveTextContent('2need you');
    expect(screen.getByTestId('alignment-classes')).toHaveTextContent('Always yours');
    expect(screen.getByTestId('alignment-classes')).toHaveTextContent('Yours when the owner says it needs you');
    expect(screen.getByTestId('alignment-thread')).toHaveTextContent('Why not paid first?');
    expect(screen.getByTestId('alignment-thread')).toHaveTextContent('Writer');
    expect(screen.getByTestId('dash-card-alignment-classes')).toHaveTextContent('Product direction');
    expect(screen.getByTestId('alignment-history')).toHaveTextContent('Q3 objectives');
  });

  it('asks for a note where one is needed, confirms a rejection, then decides; comments reach the owner', async () => {
    render(<AlignmentPane org={org} />);
    await waitFor(() => screen.getByTestId('alignment-actions'));
    const actions = screen.getByTestId('alignment-actions');
    // Send back opens a note with its own confirm; an empty note is refused.
    fireEvent.click(within(actions).getByText('Send back…'));
    fireEvent.click(within(actions).getByRole('button', { name: 'Send back' }));
    expect(within(actions).getByRole('alert')).toHaveTextContent('Say what to change');
    fireEvent.click(within(actions).getByText('Cancel'));
    // Reject asks once more.
    fireEvent.click(within(actions).getByText('Reject'));
    expect(apiMock.decideOrgAlignment).not.toHaveBeenCalled();
    fireEvent.click(within(actions).getByText('Keep it'));
    fireEvent.click(within(actions).getByText('Approve with changes…'));
    fireEvent.change(within(actions).getByLabelText('Your note'), { target: { value: 'Cap paid at $20' } });
    fireEvent.click(within(actions).getByText('Approve with these changes'));
    await waitFor(() => expect(apiMock.decideOrgAlignment).toHaveBeenCalledWith('ws1', '1', 'approve_with_changes', 'Cap paid at $20'));
    fireEvent.change(screen.getByLabelText('Comment to the owner'), { target: { value: 'What does paid cost per reader?' } });
    fireEvent.click(screen.getByText('Comment'));
    await waitFor(() => expect(apiMock.commentOrgAlignment).toHaveBeenCalledWith('ws1', '1', 'What does paid cost per reader?'));
  });

  it('rejects only after the confirm', async () => {
    render(<AlignmentPane org={org} />);
    await waitFor(() => screen.getByTestId('alignment-actions'));
    const actions = screen.getByTestId('alignment-actions');
    fireEvent.click(within(actions).getByText('Reject'));
    fireEvent.click(within(actions).getByText('Confirm: reject it'));
    await waitFor(() => expect(apiMock.decideOrgAlignment).toHaveBeenCalledWith('ws1', '1', 'reject', undefined));
  });

  it('with nothing to align, one empty state explains the flow', async () => {
    apiMock.orgAlignments.mockResolvedValueOnce([]);
    render(<AlignmentPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('alignment-clear')).toHaveTextContent('Nothing to align yet'));
    expect(screen.queryByTestId('dash-card-needs-alignment')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('alignment-classes')).toBeInTheDocument());
  });

  it('shows what agents did not escalate, with the reasoning and the spot-check, and pulls one in', async () => {
    fake.orgFocus = { kind: 'alignment', id: '3' };
    render(<AlignmentPane org={org} />);
    await waitFor(() => expect(screen.getByTestId('dash-card-not-escalated')).toHaveTextContent('Only a page; we can change it any time.'));
    await waitFor(() => expect(screen.getByTestId('spot-check-flag')).toHaveTextContent('it mentions "pricing"'));
    expect(screen.getByTestId('brief-classification')).toHaveTextContent('Why the owner did not escalate it');
    fireEvent.click(within(screen.getByTestId('alignment-actions')).getByText('Pull in for alignment'));
    await waitFor(() => expect(apiMock.decideOrgAlignment).toHaveBeenCalledWith('ws1', '3', 'pull_in', undefined));
  });
});
