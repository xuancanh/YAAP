/**
 * The Work log's live view of a run (docs/work-log.md "Intervening"): the
 * events of a turn this tab did not start, from GET /api/chats/:id/live,
 * folded into the same live rows the chat view draws (thinking, answers,
 * tool calls with their approvals). Pure, so the web tests drive it.
 */
import type { LiveItem, LiveTool } from '../store';
import type { SessionWatchEvent } from './api';

export function applyWatchEvent(items: LiveItem[], ev: SessionWatchEvent): LiveItem[] {
  switch (ev.type) {
    case 'thinking':
    case 'answer': {
      const last = items[items.length - 1];
      if (last?.kind === ev.type && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + ev.text }];
      const settled = items.map((i) => (i.kind === 'thinking' || i.kind === 'answer' ? { ...i, streaming: false } : i));
      return [...settled, { kind: ev.type, text: ev.text, streaming: true }];
    }
    case 'tool_call':
      return [...items.map((i) => (i.kind === 'thinking' || i.kind === 'answer' ? { ...i, streaming: false } : i)),
        { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }];
    case 'approval_required': {
      const found = items.some((i) => i.kind === 'tool' && i.id === ev.callId);
      if (found) return items.map((i) => (i.kind === 'tool' && i.id === ev.callId ? { ...i, status: 'pending' as const, review: ev.review ?? i.review, routedTo: ev.routedTo } : i));
      return [...items, { kind: 'tool', id: ev.callId, name: ev.tool, input: ev.input, status: 'pending', review: ev.review, routedTo: ev.routedTo }];
    }
    case 'tool_result':
      return items.map((i) => (i.kind === 'tool' && i.id === ev.id
        ? { ...i, status: ev.isError ? (ev.output.includes('Denied') ? 'denied' : 'error') : 'done', result: ev.output, review: ev.review ?? i.review, actionClass: ev.actionClass, actionId: ev.actionId, held: ev.held } as LiveTool
        : i));
    case 'tool_progress':
      return items.map((i) => (i.kind === 'tool' && i.id === ev.id ? { ...i, progress: [...(i.progress ?? []).slice(-49), ev.text] } : i));
    default:
      return items;
  }
}

/** Steps so far: thinking blocks and tool calls. */
export function liveSteps(items: LiveItem[]): number {
  return items.filter((i) => i.kind === 'thinking' || i.kind === 'tool').length;
}
