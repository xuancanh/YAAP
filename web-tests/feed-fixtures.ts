/** Feed rows and pages for the web tests (docs/owners-seat.md "Inbox and notifications"). */
import type { FeedItem, FeedPage } from '../src/lib/api';
import { recount } from '../src/lib/feed';

export const NOW = new Date('2026-11-04T10:00:00');
export const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

export const feedItem = (over: Partial<FeedItem> = {}): FeedItem => ({
  id: 'event:e1', type: 'message', section: 'mentions', title: 'Chief wrote to you', body: '', at: iso(-30), severity: 'normal', read: false, actionable: false,
  deadline: null, expiresSoon: false, actor: { kind: 'agent', id: 'c', name: 'Chief', emoji: '🧭', colors: '[]' }, company: 'Acme', context: {},
  target: { kind: 'chat', sessionId: 'dm1' }, actions: [], count: 1, ids: [over.id ?? 'event:e1'], ...over,
});

export const feedPage = (items: FeedItem[], over: Partial<FeedPage> = {}): FeedPage => recount({
  workspaceId: 'ws1', generatedAt: NOW.toISOString(), company: 'Acme', items, unread: 0,
  counts: { needsYou: items.filter((i) => i.section === 'needs').length, urgent: 0, unread: 0, sections: { needs: { total: 0, unread: 0 }, mentions: { total: 0, unread: 0 }, updates: { total: 0, unread: 0 } } },
  ...over,
});

/** A decision card expiring in 90 min, a message, a read failed run, a channel mention, a grouped update. */
export const samplePage = (): FeedPage => feedPage([
  feedItem({
    id: 'need:approval:a1', ids: ['need:approval:a1'], type: 'decision', section: 'needs', actionable: true, title: 'Hire Ana as Researcher', deadline: iso(90), expiresSoon: true, at: iso(-120),
    target: { kind: 'need', need: { kind: 'approval', ref: { approvalId: 'a1' } } }, actions: ['approve', 'reject'],
    need: { id: 'approval:a1', kind: 'approval', subkind: 'hire', title: 'Hire Ana as Researcher', detail: '', severity: 'normal', createdAt: iso(-120), deadline: iso(90), defaultAction: 'deny', recommendation: '', recommendedAction: '', reversibility: '', confidence: null, requestedBy: 'Chief', ref: { approvalId: 'a1' }, actions: ['approve', 'reject'] },
  }),
  feedItem(),
  feedItem({ id: 'event:e2', ids: ['event:e2'], type: 'run_failed', section: 'updates', title: 'Heartbeat failed', actor: { kind: 'agent', id: 'w', name: 'Writer', emoji: '✍️', colors: '[]' }, at: iso(-60 * 30), severity: 'high', read: true, target: { kind: 'agent', agentId: 'w' } }),
  feedItem({ id: 'event:e3', ids: ['event:e3'], type: 'mention', section: 'mentions', title: 'Ann mentioned you in #general', actor: { kind: 'person', id: null, name: 'Ann' }, at: iso(-60 * 26), context: { channelId: 'ch', channelSlug: 'general' }, target: { kind: 'channel', channelId: 'ch', slug: 'general', messageId: 'm9' } }),
  feedItem({
    id: 'group:task:t1', ids: ['audit:1', 'audit:2', 'event:e4'], count: 3, type: 'run_failed', section: 'updates', title: '3 updates on ENG-12', body: 'Latest: Checks failed on ENG-12', at: iso(-45), severity: 'high',
    context: { taskId: 't1', taskKey: 'ENG-12', taskTitle: 'Launch post', projectKey: 'WEB' }, target: { kind: 'task', taskId: 't1' },
  }),
]);
