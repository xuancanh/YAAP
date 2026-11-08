/** CEO alignment on screen (docs/alignment.md): the state badges, the
 *  groups the Alignment page shows and the decisions each item offers.
 *  Pure — the page, the Direction overview, the Inbox and the tests use it. */
import type { OrgAlignment, OrgAlignmentDecision, OrgAlignmentState, OrgAlignmentThreadEntry } from './api';
import type { Tone } from './direction';

export const ALIGNMENT_STATE_LABEL: Record<OrgAlignmentState, string> = {
  draft: 'Draft', in_alignment: 'Awaiting alignment', aligned: 'Aligned', realign: 'Needs re-alignment', rejected: 'Rejected', not_required: 'Not escalated',
};

/** The badge of an item: its state said from the CEO's side. */
export function alignmentBadge(a: Pick<OrgAlignment, 'state' | 'aligner' | 'needsCeoReview' | 'reviewDue' | 'alignedVia'>): { label: string; tone: Tone | 'accent'; title: string } {
  if (a.state === 'in_alignment') return a.aligner === 'ceo'
    ? { label: 'Needs your alignment', tone: 'accent', title: 'The owner asked you to align on it; tasks under it wait.' }
    : { label: 'With the chief', tone: 'info', title: 'The chief of staff aligns this class for the company.' };
  if (a.state === 'aligned') {
    if (a.reviewDue) return { label: 'Re-alignment due', tone: 'warn', title: 'Past its re-alignment cadence.' };
    if (a.needsCeoReview) return { label: a.alignedVia === 'auto' ? 'Auto-aligned' : 'Aligned by the chief', tone: 'info', title: 'Aligned without you; review or override it.' };
    return { label: 'Aligned', tone: 'ok', title: 'Aligned; work may be built on it.' };
  }
  if (a.state === 'realign') return { label: 'Needs re-alignment', tone: 'warn', title: 'It changed materially since it was aligned.' };
  if (a.state === 'rejected') return { label: 'Rejected', tone: 'bad', title: 'Not to be built on.' };
  if (a.state === 'not_required') return { label: 'Not escalated', tone: 'muted', title: 'The owner decided it does not need you; you can pull it in.' };
  return { label: 'Draft', tone: 'muted', title: 'The owner is preparing it; tasks under it wait.' };
}

export interface AlignmentGroups {
  /** Waiting on you now: asked of you, or aligned without you and not reviewed. */
  needsYou: OrgAlignment[];
  /** The owner decided they do not need you. */
  notEscalated: OrgAlignment[];
  /** With the owners: drafts, send-backs, re-alignments, the chief's. */
  inFlight: OrgAlignment[];
  /** Aligned, newest first. */
  history: OrgAlignment[];
}

export function alignmentGroups(items: OrgAlignment[]): AlignmentGroups {
  const top = items.filter((a) => !a.bundleOf);
  const byTime = (a: OrgAlignment, b: OrgAlignment) => ((a.alignedAt ?? a.updatedAt) < (b.alignedAt ?? b.updatedAt) ? 1 : -1);
  return {
    needsYou: top.filter((a) => a.awaitingCeo || (a.state === 'aligned' && (a.needsCeoReview || a.reviewDue))),
    notEscalated: top.filter((a) => a.state === 'not_required'),
    inFlight: top.filter((a) => (a.state === 'draft' || a.state === 'realign' || a.state === 'rejected' || (a.state === 'in_alignment' && !a.awaitingCeo))),
    history: items.filter((a) => a.state === 'aligned' && a.alignedAt).sort(byTime),
  };
}

/** The decisions an item offers the CEO, in button order. */
export function alignmentActions(a: Pick<OrgAlignment, 'state' | 'awaitingCeo' | 'needsCeoReview'>): Array<{ id: OrgAlignmentDecision; label: string; needsNote: boolean; primary?: boolean }> {
  if (a.state === 'not_required') return [{ id: 'pull_in', label: 'Pull in for alignment', needsNote: false, primary: true }];
  if (a.state === 'aligned') return a.needsCeoReview
    ? [{ id: 'approve', label: 'Looks right', needsNote: false, primary: true }, { id: 'approve_with_changes', label: 'Add conditions', needsNote: true }, { id: 'send_back', label: 'Re-open', needsNote: true }, { id: 'reject', label: 'Reject', needsNote: false }]
    : [{ id: 'send_back', label: 'Re-open', needsNote: true }];
  if (a.state === 'in_alignment' || a.state === 'draft' || a.state === 'realign') return [
    { id: 'approve', label: 'Approve', needsNote: false, primary: true }, { id: 'approve_with_changes', label: 'Approve with changes', needsNote: true },
    { id: 'send_back', label: 'Send back', needsNote: true }, { id: 'reject', label: 'Reject', needsNote: false }, { id: 'not_needed', label: 'Didn\'t need me', needsNote: false },
  ];
  return [{ id: 'pull_in', label: 'Reconsider', needsNote: false }];
}

/** Who wrote a thread entry, in words. */
export function threadWho(e: Pick<OrgAlignmentThreadEntry, 'by'>, nameOf: (agentId: string) => string | undefined): string {
  if (e.by === 'user' || e.by === 'ceo' || e.by.startsWith('human:')) return 'You';
  if (e.by === 'system' || e.by === 'auto') return 'YAAP';
  if (e.by === 'chief') return 'Chief of staff';
  if (e.by.startsWith('agent:')) return nameOf(e.by.slice('agent:'.length)) ?? 'An agent';
  return e.by;
}

export const VIA_LABEL: Record<string, string> = { ceo: 'you', human: 'you (you wrote it)', chief: 'the chief of staff', auto: 'auto-aligned', legacy: 'before the gate', delegate: 'a delegate' };

/** The criteria answers as short lines ("One-way door", "Cross-unit"…). */
export function criteriaLines(c: Record<string, unknown> | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.reversibility) out.push(c.reversibility === 'one_way' ? 'One-way door' : 'Two-way door');
  if (c.blastRadius) out.push(`Blast radius: ${String(c.blastRadius).replace('_', ' ')}`);
  if (typeof c.costShare === 'number') out.push(`${Math.round(c.costShare * 100)}% of the envelope`);
  if (c.externalCommitment !== undefined) out.push(c.externalCommitment ? 'External commitment' : 'Internal only');
  if (c.novelty) out.push(`Novelty: ${String(c.novelty)}`);
  if (c.conflicts !== undefined) out.push(c.conflicts ? 'Conflicts with a rule' : 'No conflicts');
  return out;
}
