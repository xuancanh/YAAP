/**
 * Group-chat helpers (docs/group-chat.md): pure functions the ChannelView
 * and the rail share — mention autocomplete parsing, thread grouping, deep
 * links, and which chat sessions are channel sessions (hidden from the DM
 * list). Mirrors server/src/groupchat/mentions.ts for handles.
 */
import type { ChannelMessage } from './api';

/** A member's @handle: lowercase, non-alphanumerics collapsed to `-`. */
export function handleOf(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The `@query` being typed at the caret, if any: where it starts and the
 *  partial handle (without the `@`). Null when the caret is not in one. */
export function mentionQuery(text: string, caret: number = text.length): { start: number; filter: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([\w.-]*)$/.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, filter: m[2].toLowerCase() };
}

export interface MentionCandidate { kind: 'agent' | 'human'; id: string; name: string }

/** Candidates whose handle (or a word of it) starts with the filter, best first. */
export function mentionSuggestions(filter: string, members: MentionCandidate[], limit = 8): MentionCandidate[] {
  const f = handleOf(filter);
  const rank = (m: MentionCandidate): number => {
    const h = handleOf(m.name);
    if (!f) return 1;
    if (h.startsWith(f)) return 0;
    if (h.split('-').some((w) => w.startsWith(f))) return 1;
    if (h.includes(f)) return 2;
    return 9;
  };
  return members.map((m) => ({ m, r: rank(m) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name)).slice(0, limit).map((x) => x.m);
}

/** Replace the `@query` at `start` with the member's handle plus a space;
 *  returns the new text and where the caret should land. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${handleOf(name)} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

export interface ThreadGroup<M extends Pick<ChannelMessage, 'id' | 'threadRootId' | 'createdAt'> = ChannelMessage> {
  root: M;
  replies: M[];
  /** Server-side count for pages that did not load the replies. */
  replyCount: number;
  lastReplyAt: string | null;
}

/** Group a flat list into top-level messages with their replies, in time
 *  order. Replies whose root is not in the list are dropped (they belong to
 *  an earlier page); `counts` fills in totals the page did not carry. */
export function groupThreads<M extends Pick<ChannelMessage, 'id' | 'threadRootId' | 'createdAt'>>(
  messages: M[],
  counts: Record<string, { count: number; lastAt: string }> = {},
): ThreadGroup<M>[] {
  const byTime = (a: M, b: M) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id));
  const roots = messages.filter((m) => !m.threadRootId).sort(byTime);
  const groups = new Map<string, ThreadGroup<M>>();
  for (const r of roots) groups.set(r.id, { root: r, replies: [], replyCount: counts[r.id]?.count ?? 0, lastReplyAt: counts[r.id]?.lastAt ?? null });
  for (const m of messages) {
    if (!m.threadRootId) continue;
    const g = groups.get(m.threadRootId);
    if (!g) continue;
    g.replies.push(m);
  }
  for (const g of groups.values()) {
    g.replies.sort(byTime);
    g.replyCount = Math.max(g.replyCount, g.replies.length);
    const last = g.replies.at(-1)?.createdAt ?? null;
    if (last && (!g.lastReplyAt || last > g.lastReplyAt)) g.lastReplyAt = last;
  }
  return [...groups.values()];
}

/** `#/ws/<id>/channel/<slug>[/<messageId>]` (docs/group-chat.md §4). */
export function parseChannelHash(hash: string): { workspaceId: string; slug: string; messageId: string | null } | null {
  const m = /^#\/ws\/([\w-]+)\/channel\/([a-z0-9][a-z0-9-]*)(?:\/([\w-]+))?\/?$/.exec(hash);
  return m ? { workspaceId: m[1], slug: m[2], messageId: m[3] ?? null } : null;
}

export function channelHash(workspaceId: string, slug: string, messageId?: string | null): string {
  return `#/ws/${workspaceId}/channel/${slug}${messageId ? `/${messageId}` : ''}`;
}

/** Channel sessions (`#<slug> · <agent>`, tagged `channel`) are the agents'
 *  hidden working sessions behind a channel, never direct messages. */
export function isChannelSession(s: { name: string; tags?: string }): boolean {
  if (s.name.startsWith('#') && s.name.includes(' · ')) return true;
  try { return Array.isArray(JSON.parse(s.tags ?? '[]')) && (JSON.parse(s.tags ?? '[]') as string[]).includes('channel'); } catch { return false; }
}

/** Initials for a human chip: "Bob Jones" → "BJ", "alice" → "A". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 1) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** `#goal:<id>` references in a message (docs/group-chat.md §3, §7): the
 *  raw ids as written, deduplicated. The server stores the resolved goal in
 *  the message's `mentions` as `{ kind: 'goal', id }`; this is for the chip
 *  text while typing and for messages the server could not resolve. */
export function goalRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w#])#goal:([\w-]{4,})/g)) { const id = m[2].replace(/[.,;:!?]+$/, ''); if (id && !out.includes(id)) out.push(id); }
  return out;
}

/** The goals a stored message references, from its `mentions` JSON. */
export function goalMentions(mentionsJson: string): string[] {
  try {
    const v = JSON.parse(mentionsJson || '[]') as Array<{ kind?: string; id?: string }>;
    return Array.isArray(v) ? v.filter((m) => m && m.kind === 'goal' && typeof m.id === 'string').map((m) => m.id as string) : [];
  } catch { return []; }
}
