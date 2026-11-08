/** Evidence-gated claims on screen (docs/evidence.md §8): the badge words
 *  and sentences, the evidence popover (files open in the side panel), and
 *  the Claims panel's ordering and lede. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimsSummary, OrgClaim } from '../src/lib/api';
import { CLAIM_LABEL, claimMembers, claimSentence, claimsLede, latestByRef, showsBadge } from '../src/lib/claims';
import { ClaimBadge } from '../src/components/OrgClaimsView';
import { FILE_EVENT } from '../src/lib/file-links';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const claim = (o: Partial<OrgClaim> = {}): OrgClaim => ({
  id: 'c1', orgId: 'o1', classKey: 'task_update', refType: 'task_comment', refId: 'm1', agentId: 'a1', context: { taskId: 't1' }, statement: 'Contacted 93 people.',
  value: null, status: 'unverified', enforcement: 'mark', refs: [], counts: [], detail: 'Cite evidence.', verifiedBy: '', verifiedAt: null, createdAt: '2026-11-08T10:00:00Z', ...o,
});
const tally = (o: Partial<ClaimsSummary['totals']> = {}) => ({ verified: 0, unverified: 0, mismatch: 0, fabricated: 0, total: 0, ...o });

describe('claims helpers', () => {
  it('words a claim by what checked it, or why nothing did', () => {
    expect(claimSentence(claim())).toBe('Nothing was cited; nobody has checked it.');
    expect(claimSentence(claim({ status: 'verified', verifiedBy: 'evidence', refs: [{ raw: 'file:/org/a.md', kind: 'file', ok: true, detail: '' }, { raw: 'action:abcd1234', kind: 'action', ok: true, detail: '' }] }))).toBe('Verified by file:/org/a.md and 1 more.');
    expect(claimSentence(claim({ status: 'verified', verifiedBy: 'user' }))).toBe('Confirmed by a person.');
    expect(claimSentence(claim({ status: 'mismatch', counts: [{ measure: 'outward', n: 93, phrase: 'Contacted 93', measured: 5, mismatch: true }] }))).toBe('"Contacted 93" — the record shows 5.');
    expect(claimSentence(claim({ status: 'fabricated', refs: [{ raw: 'file:/org/x.md', kind: 'file', ok: false, detail: 'no file', missing: true }] }))).toMatch(/does not exist: file:\/org\/x\.md/);
    expect(showsBadge(claim({ enforcement: 'log' }))).toBe(false);
    expect(showsBadge(claim({ enforcement: 'log', status: 'verified' }))).toBe(true);
    expect(latestByRef([claim({ id: 'old', createdAt: '1' }), claim({ id: 'new', createdAt: '2' })]).get('m1')?.id).toBe('new');
  });

  it('orders members worst first and says where claims stand', () => {
    const s: ClaimsSummary = { days: 30, totals: tally({ verified: 3, unverified: 2, fabricated: 1, total: 6 }), byAgent: { a: tally({ verified: 3, total: 3 }), b: tally({ fabricated: 1, unverified: 2, total: 3 }) }, recent: [] };
    expect(claimMembers(s).map((m) => m.agentId)).toEqual(['b', 'a']);
    expect(claimsLede(s)).toBe('3 of 6 claims verified, 2 unverified, 1 citing evidence that does not exist in the last 30 days.');
    expect(claimsLede({ ...s, totals: tally() })).toMatch(/No claims/);
  });
});

describe('ClaimBadge', () => {
  it('shows the status and, on click, the evidence; a file opens in the side panel', () => {
    const opened: string[] = [];
    const on = (e: Event) => opened.push((e as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener(FILE_EVENT, on);
    render(<ClaimBadge claim={claim({ status: 'fabricated', refs: [{ raw: 'file:/org/blog/launch.md', kind: 'file', ok: false, detail: 'no file', missing: true }] })} />);
    expect(screen.getByText(CLAIM_LABEL.fabricated)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /fabricated evidence: show the evidence/ }));
    expect(screen.getByTestId('claim-popover').textContent).toMatch(/does not exist/);
    fireEvent.click(screen.getByText('/org/blog/launch.md'));
    expect(opened).toEqual(['org/blog/launch.md']);
    window.removeEventListener(FILE_EVENT, on);
  });

  it('draws nothing for a record without a flagged claim', () => {
    const { container } = render(<ClaimBadge claim={undefined} />);
    expect(container.textContent).toBe('');
  });
});
