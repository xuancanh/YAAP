/**
 * Group-chat helpers (docs/group-chat.md): pure functions the ChannelView
 * and the rail share — mention autocomplete parsing, mention chips, thread
 * grouping, deep links, and which chat sessions are channel sessions (hidden
 * from the DM list). Mirrors server/src/groupchat/mentions.ts for handles and
 * mention resolution: keep the two in step.
 */
import type { ChannelMessage } from './api';

const FOLD: Record<string, string> = { 'đ': 'd', 'ł': 'l', 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'þ': 'th', 'ð': 'd', 'ı': 'i' };

/** A member's @handle: lowercase, accents folded, non-alphanumerics collapsed to `-`. */
export function handleOf(name: string): string {
  return name.toLowerCase().replace(/[đłøæœßþðı]/g, (ch) => FOLD[ch] ?? ch).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The `@query` being typed at the caret, if any: where it starts and the
 *  partial name (without the `@`, any script). Null when the caret is not in one. */
export function mentionQuery(text: string, caret: number = text.length): { start: number; filter: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])@([\p{L}\p{N}\p{M}_.-]*)$/u.exec(before);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, filter: m[2].toLowerCase() };
}

export interface MentionCandidate { kind: 'agent' | 'human'; id: string; name: string }

/** Candidates whose handle (or a word of it) starts with the filter, best
 *  first; a filter with no Latin spelling (`小`) matches the name as written. */
export function mentionSuggestions(filter: string, members: MentionCandidate[], limit = 8): MentionCandidate[] {
  const f = handleOf(filter);
  const raw = filter.trim().toLowerCase();
  const rank = (m: MentionCandidate): number => {
    if (!raw) return 1;
    const name = m.name.toLowerCase();
    if (!f) return name.startsWith(raw) ? 0 : name.includes(raw) ? 2 : 9;
    const h = handleOf(m.name);
    if (h.startsWith(f)) return 0;
    if (h.split('-').some((w) => w.startsWith(f))) return 1;
    if (h.includes(f)) return 2;
    return 9;
  };
  return members.map((m) => ({ m, r: rank(m) })).filter((x) => x.r < 9).sort((a, b) => a.r - b.r || a.m.name.localeCompare(b.m.name)).slice(0, limit).map((x) => x.m);
}

/** Replace the `@query` at `start` with the member's handle (its name as
 *  written when it has no Latin spelling) plus a space; returns the new text
 *  and where the caret should land. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${handleOf(name) || name.trim()} `;
  const next = text.slice(0, start) + insert + text.slice(caret);
  return { text: next, caret: start + insert.length };
}

// ---- mention resolution (mirror of server/src/groupchat/mentions.ts) ----

const WORD_CH = /[\p{L}\p{N}\p{M}]/u;
const TOKEN_AT = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_.-]*/u;
const LEAD_MARKS = /^[*_~`]{1,3}/;

export interface MentionSpan { start: number; end: number; members: MentionCandidate[] }

function maskFences(text: string): string {
  return text.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, (block) => block.replace(/[^\n]/g, ' '));
}

/** Every `@mention` in the text, in order, with the members it resolves to:
 *  the longest display name after `@` first, then the handle forms. */
export function mentionSpans(text: string, members: MentionCandidate[]): MentionSpan[] {
  const masked = maskFences(text);
  const named = members.map((m) => ({
    m,
    names: [m.name].map((x) => x.trim().normalize('NFC')).filter(Boolean).map((raw) => ({ len: raw.length, low: raw.toLowerCase() })),
    full: handleOf(m.name),
    first: handleOf(m.name).split('-')[0] ?? '',
  }));
  const out: MentionSpan[] = [];
  for (let at = masked.indexOf('@'); at >= 0; at = masked.indexOf('@', at + 1)) {
    const before = at > 0 ? masked[at - 1] : '';
    if (before && (before === '@' || WORD_CH.test(before))) continue;
    let from = at + 1;
    const marks = LEAD_MARKS.exec(masked.slice(from));
    if (marks) from += marks[0].length;
    let best = 0; let hit: MentionCandidate[] = [];
    for (const h of named) {
      for (const n of h.names) {
        if (n.len < best || masked.slice(from, from + n.len).toLowerCase() !== n.low) continue;
        const next = masked[from + n.len];
        if (next && WORD_CH.test(next) && WORD_CH.test(n.low[n.low.length - 1] ?? '')) continue;
        if (n.len > best) { best = n.len; hit = []; }
        if (!hit.includes(h.m)) hit.push(h.m);
      }
    }
    if (hit.length > 0) { out.push({ start: at, end: from + best, members: hit }); continue; }
    const tok = TOKEN_AT.exec(masked.slice(from));
    if (!tok) continue;
    const raw = tok[0].replace(/[.,;:!?-]+$/, '');
    const token = handleOf(raw);
    let found: typeof named = [];
    if (token) {
      const flat = token.replace(/-/g, '');
      found = named.filter((h) => h.full === token || h.full.replace(/-/g, '') === flat);
      if (found.length === 0) {
        const byFirst = named.filter((h) => h.first === token);
        if (byFirst.length === 1) found = byFirst;
      }
    }
    out.push({ start: at, end: from + raw.length, members: found.map((h) => h.m) });
  }
  return out;
}

/** The mention chips of a stored message: spans of the text that name a
 *  member the server resolved for it (its `mentions` JSON) — so a chip
 *  appears exactly where a tag woke an agent or notified a person. */
export function messageMentionSpans(text: string, mentionsJson: string, members: MentionCandidate[]): Array<{ start: number; end: number; member: MentionCandidate }> {
  let resolved: Array<{ kind?: string; id?: string }> = [];
  try { const v = JSON.parse(mentionsJson || '[]') as unknown; if (Array.isArray(v)) resolved = v as typeof resolved; } catch { /* no chips */ }
  const ids = new Set(resolved.filter((m) => m && (m.kind === 'agent' || m.kind === 'human')).map((m) => `${m.kind}:${m.id}`));
  if (ids.size === 0 || !text.includes('@')) return [];
  const out: Array<{ start: number; end: number; member: MentionCandidate }> = [];
  for (const s of mentionSpans(text, members)) {
    const member = s.members.find((m) => ids.has(`${m.kind}:${m.id}`));
    if (member) out.push({ start: s.start, end: s.end, member });
  }
  return out;
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

/** `#decision:<id>` references in a message (docs/group-chat.md §8): the
 *  raw ids as written, deduplicated — the minutes write them with an 8-char
 *  prefix, which `GET …/chat/decisions/:id` resolves. */
export function decisionRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|[^\w#])#decision:([\w-]{4,})/g)) { const id = m[2].replace(/[.,;:!?]+$/, ''); if (id && !out.includes(id)) out.push(id); }
  return out;
}

/** The decisions a stored message references, from its `mentions` JSON. */
export function decisionMentions(mentionsJson: string): string[] {
  try {
    const v = JSON.parse(mentionsJson || '[]') as Array<{ kind?: string; id?: string }>;
    return Array.isArray(v) ? v.filter((m) => m && m.kind === 'decision' && typeof m.id === 'string').map((m) => m.id as string) : [];
  } catch { return []; }
}

export const MEETING_COMMAND_KINDS = ['planning', 'standup', 'weekly_review', 'retro', 'board'] as const;

/** The composer's `/meeting` hint (docs/group-chat.md §8): while the text is
 *  the command being typed, what it will do — the kind, the unit and the
 *  agenda so far — or null when the text is anything else. Mirrors
 *  `parseMeetingCommand` on the server. */
export function meetingCommandHint(text: string): { kind: string; unitSlug: string | null; agenda: string; complete: boolean } | null {
  const m = /^\/m(?:e(?:e(?:t(?:i(?:n(?:g)?)?)?)?)?)?(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!m) return null;
  const complete = /^\/meeting(\s|$)/i.test(text.trimStart());
  const tokens = (m[1] ?? '').trim().split(/\s+/).filter(Boolean);
  let kind = 'adhoc';
  if (tokens.length && (MEETING_COMMAND_KINDS as readonly string[]).includes(tokens[0].toLowerCase().replace('-', '_'))) kind = tokens.shift()!.toLowerCase().replace('-', '_');
  let unitSlug: string | null = null;
  if (tokens.length && /^#[a-z0-9][a-z0-9-]*$/i.test(tokens[0])) unitSlug = tokens.shift()!.slice(1).toLowerCase();
  return { kind, unitSlug, agenda: tokens.join(' '), complete };
}

/** Where a live agent reply belongs (docs/group-chat.md §2): it lands in the
 *  thread `replyRootId` — the triggering message's thread, or the message
 *  itself when that was top level. The thread panel shows every live reply
 *  landing in it; the main list shows the ones triggered at top level. */
export function liveInThread(l: { threadRootId: string | null; replyRootId?: string }, thread: string | null): boolean {
  return Boolean(thread) && (l.replyRootId ?? l.threadRootId) === thread;
}

// ---- sub-channels (docs/group-chat.md §9) ----

/** A top-level channel with its open sub-channels (discussions, meetings). */
export interface RailChannel<C> { channel: C; subs: C[] }

type SubLike = { id: string; parentChannelId?: string | null; channelKind?: string; createdAt: string };

/** The rail's tree: top-level channels in their order, each with its open
 *  sub-channels nested (oldest first); a sub-channel whose parent is not in
 *  the list (hidden, archived) stands on its own. */
export function railChannels<C extends SubLike>(list: C[]): Array<RailChannel<C>> {
  const ids = new Set(list.map((c) => c.id));
  const isSub = (c: C) => c.channelKind === 'sub' && Boolean(c.parentChannelId) && ids.has(c.parentChannelId!);
  return list.filter((c) => !isSub(c)).map((channel) => ({
    channel,
    subs: list.filter((c) => isSub(c) && c.parentChannelId === channel.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
  }));
}

/** The sub-channel a parent's link card stands for (its `subchannel/<id>` attachment), or null. */
export function linkCardSubId(attachmentsJson: string | null | undefined): string | null {
  try {
    const v = JSON.parse(attachmentsJson || '[]') as Array<{ kind?: string; path?: string }>;
    const a = Array.isArray(v) ? v.find((x) => x && x.kind === 'subchannel' && typeof x.path === 'string') : undefined;
    return a ? a.path!.replace(/^subchannel\//, '') || null : null;
  } catch { return null; }
}

/** What a link card's text says (the server writes it, docs/group-chat.md
 *  §9), for a closed sub-channel the list no longer carries: the title, the
 *  member count, the status word, the outcome and the slug. */
export function parseLinkCardText(text: string): { title: string; status: 'live' | 'closed' | 'ended'; outcome: string; slug: string | null; members: number | null } {
  const slug = /#([a-z0-9][a-z0-9-]*)\s*$/.exec(text)?.[1] ?? null;
  const body = text.replace(/^[^:]*:\s*/, '').replace(/\s*·\s*#[a-z0-9-]+\s*$/, '');
  // The title may hold " · " itself ("Planning · Company"): the member count anchors the split.
  const m = /^(.*?) · (\d+) members? · (.*)$/.exec(body);
  const title = m ? m[1] : body;
  const members = m ? Number(m[2]) : NaN;
  const rest = m ? m[3] : '';
  const status = /^ended/.test(rest) ? 'ended' : /^closed/.test(rest) ? 'closed' : 'live';
  const outcome = status === 'live' ? '' : rest.replace(/^(ended|closed)\s*(—\s*)?/, '');
  return { title, status, outcome, slug, members: Number.isFinite(members) ? members : null };
}

export function subIcon(purpose: string | null | undefined): string {
  return purpose === 'meeting' ? '📅' : purpose === 'project' ? '📌' : '🗣';
}

/** "3m ago", "2h ago", "yesterday" — a card's last activity. */
export function agoText(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return s < 172_800 ? 'yesterday' : `${Math.floor(s / 86_400)}d ago`;
}
