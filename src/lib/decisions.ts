/** Decision routing in the SPA (docs/owners-seat.md §7): a card climbs from
 *  the requester through its managers to the CEO; each hop may carry a
 *  recommendation. Pure — the Inbox, Home and the agent page use these. */
import type { DecisionHopView, OrgApproval } from './api';

/** Whether a pending card waits on the viewer now: true unless the server
 *  says a manager still holds it (older servers send no `forYou`). */
export function waitsOnViewer(a: Pick<OrgApproval, 'status' | 'forYou'>): boolean {
  return a.status === 'pending' && a.forYou !== false;
}

/** Pending cards still with a manager below the viewer ("in review by your team"). */
export function inReviewBelow(rows: Array<Pick<OrgApproval, 'status' | 'forYou'>>): number {
  return rows.filter((a) => a.status === 'pending' && a.forYou === false).length;
}

const REC: Record<string, string> = { approve: 'recommends approve', deny: 'recommends deny', modify: 'recommends changes' };

/** One line per manager hop: "Head of Content recommends approve — margins are thin". */
export function hopLine(h: Pick<DecisionHopView, 'action' | 'recommendation' | 'reasoning'> & { byName?: string; by?: string }): string {
  const who = h.byName || h.by || 'Someone';
  if (h.action === 'timed_out') return 'A manager did not answer in time — no recommendation';
  if (h.action === 'sent_back') return `${who} sent it back${h.reasoning ? ` — ${h.reasoning}` : ''}`;
  if (h.action === 'decided') return `${who} decided${h.reasoning ? ` — ${h.reasoning}` : ''}`;
  const rec = h.recommendation ? REC[h.recommendation] ?? `recommends ${h.recommendation}` : 'passed it up without a recommendation';
  return `${who} ${rec}${h.reasoning ? ` — ${h.reasoning}` : ''}`;
}

/** The manager hops worth showing (the raise itself is the card's own text). */
export function managerHops<T extends { action: string }>(hops: T[] | undefined): T[] {
  return (hops ?? []).filter((h) => h.action === 'escalated' || h.action === 'timed_out');
}
