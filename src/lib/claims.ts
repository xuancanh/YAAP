/** Evidence-gated claims on screen (docs/evidence.md §8): the badge words,
 *  tones and sentences the badges, the evidence popover and the Claims
 *  panel show. Pure — the components and the tests use these. */
import type { ClaimStatus, ClaimsSummary, OrgClaim } from './api';
import type { Tone } from './direction';

export const CLAIM_LABEL: Record<ClaimStatus, string> = { verified: 'verified', unverified: 'unverified', mismatch: 'contradicted', fabricated: 'fabricated evidence' };
export const CLAIM_TONE: Record<ClaimStatus, Tone> = { verified: 'ok', unverified: 'warn', mismatch: 'bad', fabricated: 'bad' };
export const CLAIM_CLASS_LABEL: Record<OrgClaim['classKey'], string> = {
  kr_checkin: 'Key-result value', project_update: 'Project update', task_update: 'Task update', decision: 'Fact in a decision', step_output: 'Step output', lesson: 'Lesson',
};

/** The latest claim per record, by refId. */
export function latestByRef(claims: OrgClaim[]): Map<string, OrgClaim> {
  const out = new Map<string, OrgClaim>();
  for (const c of [...claims].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) out.set(c.refId, c);
  return out;
}

/** Whether a badge is worth showing: a logged-only unverified claim stays off the record's face. */
export function showsBadge(c: OrgClaim | undefined): c is OrgClaim {
  return Boolean(c) && !(c!.enforcement === 'log' && c!.status !== 'verified');
}

/** "Verified by file:/org/a.md and 1 more", "Verified by the record (5 sends)", "Confirmed by a person", or why it is not. */
export function claimSentence(c: OrgClaim): string {
  if (c.status === 'verified') {
    if (c.verifiedBy && c.verifiedBy !== 'evidence') return 'Confirmed by a person.';
    const ok = c.refs.filter((r) => r.ok);
    if (ok.length) return `Verified by ${ok[0].raw}${ok.length > 1 ? ` and ${ok.length - 1} more` : ''}.`;
    const k = c.counts[0];
    return k ? `Verified against the record: "${k.phrase}" (${k.measured}).` : 'Verified.';
  }
  if (c.status === 'fabricated') return `Cites evidence that does not exist: ${c.refs.filter((r) => r.missing).map((r) => r.raw).slice(0, 3).join(', ')}.`;
  if (c.status === 'mismatch') return c.counts.filter((k) => k.mismatch).map((k) => `"${k.phrase}" — the record shows ${k.measured}.`).join(' ') || 'Contradicted by the record.';
  return c.refs.length ? 'Its references did not check out.' : 'Nothing was cited; nobody has checked it.';
}

/** The Claims panel's members, worst first: fabrications, then mismatches, then unverified. */
export function claimMembers(s: ClaimsSummary | null | undefined): Array<{ agentId: string } & ClaimsSummary['totals']> {
  if (!s) return [];
  return Object.entries(s.byAgent).map(([agentId, t]) => ({ agentId, ...t }))
    .sort((a, b) => b.fabricated - a.fabricated || b.mismatch - a.mismatch || b.unverified - a.unverified || b.total - a.total);
}

/** One sentence for the panel. */
export function claimsLede(s: ClaimsSummary | null | undefined): string | null {
  if (!s) return null;
  const t = s.totals;
  if (!t.total) return `No claims in shared state in the last ${s.days} days.`;
  const parts = [`${t.verified} of ${t.total} claim${t.total === 1 ? '' : 's'} verified`];
  if (t.unverified) parts.push(`${t.unverified} unverified`);
  if (t.mismatch) parts.push(`${t.mismatch} contradicted by the record`);
  if (t.fabricated) parts.push(`${t.fabricated} citing evidence that does not exist`);
  return `${parts.join(', ')} in the last ${s.days} days.`;
}
