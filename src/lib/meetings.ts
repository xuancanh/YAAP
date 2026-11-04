/** The meetings list and calendar (docs/meetings.md): pure helpers for the
 *  month grid, the week agenda and the list's upcoming / past split. Dates
 *  are the viewer's local time; weeks start on Monday. */
import { useEffect, useState } from 'react';
import { api, type CalendarMeeting, type ChannelMessage, type MeetingRoomState, type Minutes } from './api';
import { companyIdOf, readLocation, MEETING_EVENT, type MeetingEventDetail } from './routes';

/** `yyyy-mm-dd` in local time. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfDay(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function addDays(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
/** Monday of the week `d` is in. */
export function startOfWeek(d: Date): Date { return addDays(startOfDay(d), -((d.getDay() + 6) % 7)); }

/** The month grid around `anchor`: whole Monday-first weeks covering the month (4–6 rows of 7). */
export function monthGrid(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const weeks: Date[][] = [];
  for (let start = startOfWeek(first); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

/** The seven days of the week `anchor` is in. */
export function weekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The API range a view needs: the whole grid for a month, the week for the agenda. */
export function rangeFor(view: 'month' | 'week', anchor: Date): { from: Date; to: Date } {
  if (view === 'week') { const from = startOfWeek(anchor); return { from, to: addDays(from, 7) }; }
  const grid = monthGrid(anchor);
  return { from: grid[0][0], to: addDays(grid[grid.length - 1][6], 1) };
}

/** Meetings by local day, each day in time order. */
export function byDay(items: CalendarMeeting[]): Map<string, CalendarMeeting[]> {
  const out = new Map<string, CalendarMeeting[]>();
  for (const m of [...items].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const k = dayKey(new Date(m.at));
    out.set(k, [...(out.get(k) ?? []), m]);
  }
  return out;
}

/** Whether a row is still ahead: an upcoming occurrence, or a meeting not yet held. */
export function isAhead(m: CalendarMeeting): boolean {
  return m.status === 'upcoming' || m.status === 'scheduled' || m.status === 'postponed' || m.status === 'running';
}

/** The list view: upcoming (soonest first, running on top), then past (latest first). */
export function splitList(items: CalendarMeeting[]): { upcoming: CalendarMeeting[]; past: CalendarMeeting[] } {
  const upcoming = items.filter(isAhead).sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const past = items.filter((m) => !isAhead(m)).sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
  return { upcoming, past };
}

/** "Mon 2 Nov, 09:30" in the viewer's locale. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

/** "09:30" in the viewer's locale. */
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A title short enough for a calendar cell: the kind and the unit, without the "Meeting: " prefix. */
export function shortTitle(m: CalendarMeeting): string {
  return m.title.replace(/^Meeting: /, '');
}

// ---- the meeting room (docs/meetings.md "During") ----

export function emptyRoom(): MeetingRoomState {
  return {
    items: [], current: 0, itemStartedAt: null, itemMinutes: 10, round: 0, roundCap: 0, extended: 0, speaking: null, attendance: {}, passes: [], present: [],
    proposals: [], preRead: '', openItems: [], verdicts: {}, answers: {}, controls: { extend: 0, skip: 0, skipped: 0, end: null }, remindedAt: null, preparedAt: null, speakers: [], skipped: null, itemLog: [],
  };
}

/** The room JSON of a meeting row, defensively (missing → empty). */
export function parseRoom(raw: string | null | undefined): MeetingRoomState {
  const base = emptyRoom();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<MeetingRoomState>;
    return v && typeof v === 'object' ? { ...base, ...v, controls: { ...base.controls, ...(v.controls ?? {}) } } : base;
  } catch { return base; }
}

export type SeatState = 'speaking' | 'spoke' | 'passed' | 'waiting' | 'idle' | 'present' | 'away';
export interface Seat { kind: 'agent' | 'human'; id: string; name: string; state: SeatState; facilitator: boolean }

/** The attendee strip: agents in speaking order with this round's state,
 *  then the people (present when they joined). */
export function seats(room: MeetingRoomState, attendees: Array<{ kind: 'agent' | 'human'; id: string }>, facilitatorId: string | null, name: (kind: 'agent' | 'human', id: string) => string): Seat[] {
  const agentIds = room.speakers.length ? room.speakers : attendees.filter((a) => a.kind === 'agent').map((a) => a.id);
  const people = [...new Set([...attendees.filter((a) => a.kind === 'human').map((a) => a.id), ...room.present])];
  return [
    ...agentIds.map((id) => ({ kind: 'agent' as const, id, name: name('agent', id), facilitator: id === facilitatorId, state: (room.speaking === id ? 'speaking' : room.attendance[id] ?? 'waiting') as SeatState })),
    ...people.map((id) => ({ kind: 'human' as const, id, name: name('human', id), facilitator: false, state: (room.present.includes(id) ? 'present' : 'away') as SeatState })),
  ];
}

/** Whole minutes since `iso` (0 when unknown). */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : 0;
}

/** "12.3k" */
export function tokensText(n: number | null | undefined): string {
  const v = n ?? 0;
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : String(v);
}

/** The proposal a thread message announced (its inline Approve / Reject / Answer). */
export type ProposalRef = { kind: 'decision' | 'action' | 'question'; index: number; title: string };
export function proposalFor(messageId: string, minutes: Minutes): ProposalRef | null {
  const d = minutes.decisions.findIndex((x) => x.messageId === messageId);
  if (d >= 0) return { kind: 'decision', index: d, title: minutes.decisions[d].title };
  const a = minutes.actions.findIndex((x) => x.messageId === messageId);
  if (a >= 0) return { kind: 'action', index: a, title: minutes.actions[a].title };
  const q = minutes.questions.findIndex((x) => x.messageId === messageId);
  if (q >= 0) return { kind: 'question', index: q, title: minutes.questions[q].question };
  return null;
}

// ---- the compact room header and the full-screen room ----

export type AgendaState = 'done' | 'current' | 'upcoming' | 'parked' | 'skipped' | 'unreached';
export interface AgendaRow { index: number; text: string; state: AgendaState; minutes: number | null; how: 'settled' | 'skipped' | 'time' | null }

/** Each agenda item with where it stands: done (settled, or its time box
 *  ran out), skipped by a person, parked (the facilitator parked a point
 *  naming it), current, or upcoming; with the minutes it took when known.
 *  Before the start every item is upcoming; after the end nothing is current
 *  and nothing is up next: an item the meeting never reached is unreached. */
export function agendaRows(room: MeetingRoomState, status: string, minutes?: Minutes | null, now = Date.now()): AgendaRow[] {
  const log = new Map((room.itemLog ?? []).map((x) => [x.index, x]));
  const parked = (minutes?.parked ?? []).map((p) => p.text.toLowerCase());
  const running = status === 'running';
  const over = status === 'done' || status === 'cancelled';
  const started = running || over;
  return room.items.map((text, index) => {
    const ended = log.get(index);
    const lower = text.toLowerCase();
    const isParked = parked.some((p) => p.length >= 4 && (p.includes(lower) || lower.includes(p)));
    let state: AgendaState;
    if (!started) state = 'upcoming';
    else if (index < room.current) state = ended?.how === 'skipped' ? 'skipped' : isParked ? 'parked' : 'done';
    else if (index === room.current && running) state = isParked ? 'parked' : 'current';
    else if (over) state = isParked ? 'parked' : ended ? (ended.how === 'skipped' ? 'skipped' : 'done') : 'unreached';
    else state = isParked ? 'parked' : 'upcoming';
    const mins = ended ? ended.minutes : state === 'current' ? (room.itemStartedAt ? Math.max(0, (now - Date.parse(room.itemStartedAt)) / 60_000) : 0) : null;
    return { index, text, state, minutes: mins === null || !Number.isFinite(mins) ? null : Math.round(mins * 10) / 10, how: ended?.how ?? null };
  });
}

const isMinutesMessage = (m: ChannelMessage): boolean => /"kind"\s*:\s*"minutes"/.test(m.attachments ?? '');

/** The thread's messages folded into turns: consecutive messages of one
 *  author are one turn; system lines and the minutes stand alone. */
export interface Turn { key: string; authorKind: ChannelMessage['authorKind']; authorId: string; messages: ChannelMessage[] }
export function foldTurns(messages: ChannelMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && m.authorKind !== 'system' && !isMinutesMessage(m) && !isMinutesMessage(last.messages[0]) && last.authorKind === m.authorKind && last.authorId === m.authorId) last.messages.push(m);
    else out.push({ key: m.id, authorKind: m.authorKind, authorId: m.authorId, messages: [m] });
  }
  return out;
}

/** Everything proposed in the room, for the Proposed board: decisions,
 *  actions, risks and questions for the CEO, with the people's verdicts
 *  and answers. */
export interface Proposed {
  kind: 'decision' | 'action' | 'risk' | 'question'; index: number; title: string; detail: string; by: string;
  verdict: 'approved' | 'rejected' | null; verdictBy: string | null; answer: string | null;
  taskKey: string | null; taskId: string | null; due: string | null; decisionId: string | null;
}
export function proposedBoard(minutes: Minutes, room: MeetingRoomState): Proposed[] {
  const v = (k: string) => room.verdicts[k] ?? null;
  const base = { verdict: null, verdictBy: null, answer: null, taskKey: null, taskId: null, due: null, decisionId: null };
  return [
    ...minutes.decisions.map((d, i): Proposed => ({ ...base, kind: 'decision', index: i, title: d.title, detail: d.decision, by: d.by, verdict: v(`decision:${i}`)?.verdict ?? d.verdict ?? null, verdictBy: v(`decision:${i}`)?.byName ?? d.verdictName ?? null, decisionId: d.decisionId ?? null })),
    ...minutes.actions.map((a, i): Proposed => ({ ...base, kind: 'action', index: i, title: a.title, detail: [a.owner && `Owner ${a.owner}`, a.done_when && `done when ${a.done_when}`].filter(Boolean).join(' · '), by: a.by, verdict: v(`action:${i}`)?.verdict ?? a.verdict ?? null, verdictBy: v(`action:${i}`)?.byName ?? a.verdictName ?? null, taskKey: a.taskKey ?? null, taskId: a.taskId ?? null, due: a.due ?? null })),
    ...minutes.risks.map((r, i): Proposed => ({ ...base, kind: 'risk', index: i, title: r.text, detail: '', by: r.by })),
    ...minutes.questions.map((q, i): Proposed => ({ ...base, kind: 'question', index: i, title: q.question, detail: '', by: q.by, verdictBy: room.answers[`question:${i}`]?.byName ?? q.answeredBy ?? null, answer: room.answers[`question:${i}`]?.answer ?? q.answer ?? null })),
  ];
}

/** Who may do what in the room (the server's rule, docs/meetings.md
 *  "During"): the CEO or the person who started it steers; the CEO, a board
 *  member or the starter rules on proposals; the CEO or a board member
 *  answers. Role not known yet (undefined) → allowed; the server still refuses. */
export function roomStanding(createdBy: string, me: string, role: string | null | undefined, ownerAccountId?: string | null): { steer: boolean; rule: boolean; answer: boolean } {
  if (role === undefined) return { steer: true, rule: true, answer: true };
  const starter = createdBy === `human:${me}` || (createdBy === 'user' && Boolean(ownerAccountId) && me === ownerAccountId);
  return { steer: role === 'ceo' || starter, rule: role === 'ceo' || role === 'board' || starter, answer: role === 'ceo' || role === 'board' };
}

/** "4:05" — minutes as m:ss. */
export function mmss(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The in-thread drawer (agenda, pre-read, open items) is collapsed by
// default and remembered per viewer in this browser.
const DRAWER_KEY = 'yaam-meeting-drawer';
export function readDrawer(viewer: string): boolean {
  try { return localStorage.getItem(`${DRAWER_KEY}:${viewer}`) === '1'; } catch { return false; }
}
export function saveDrawer(viewer: string, open: boolean): void {
  try { localStorage.setItem(`${DRAWER_KEY}:${viewer}`, open ? '1' : '0'); } catch { /* private mode: not remembered */ }
}

// ---- the full-screen room route: /<company>/meetings/<meetingId> ----
// (docs/routes.md; the older `#/ws/<workspaceId>/meeting/<meetingId>` redirects there)

export interface MeetingRoute { workspaceId: string | null; meetingId: string }
/** The older hash form, still in stored messages and notifications. */
export function parseMeetingHash(hash: string): MeetingRoute | null {
  const m = /^#\/(?:ws\/([\w-]+)\/)?meeting\/([\w-]+)\/?$/.exec(hash ?? '');
  return m ? { workspaceId: m[1] ?? null, meetingId: m[2] } : null;
}
export function meetingHash(workspaceId: string, meetingId: string): string {
  return `#/ws/${workspaceId}/meeting/${meetingId}`;
}
/** The meeting the address names, if any. */
function meetingOfLocation(): MeetingRoute | null {
  const r = readLocation(window.location);
  return r?.place.kind === 'meeting' ? { workspaceId: r.company ? companyIdOf(r.company) : null, meetingId: r.place.id } : null;
}
const meetingEvent = (detail: MeetingEventDetail) => window.dispatchEvent(new CustomEvent<MeetingEventDetail>(MEETING_EVENT, { detail }));
/** Open the full-screen room (a history entry: Back closes it). The store
 *  owns the room and writes the address (src/store.tsx). */
export function openMeetingView(workspaceId: string, meetingId: string): void {
  meetingEvent({ workspaceId, meetingId });
}
/** Close it at once (synchronously, so a navigation made in the same click
 *  lands on its own place); the address returns to what is underneath. */
export function closeMeetingView(): void {
  meetingEvent({ workspaceId: '', meetingId: null });
}
/** The meeting on screen, following Expand, Close, and Back and Forward. */
export function useMeetingRoute(): MeetingRoute | null {
  const [route, setRoute] = useState(meetingOfLocation);
  useEffect(() => {
    const keep = (next: MeetingRoute | null) => setRoute((cur) => (cur && next && cur.meetingId === next.meetingId && cur.workspaceId === next.workspaceId ? cur : next));
    const onNav = () => keep(meetingOfLocation());
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<MeetingEventDetail>).detail;
      keep(d?.meetingId ? { workspaceId: d.workspaceId || null, meetingId: d.meetingId } : null);
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener(MEETING_EVENT, onEvent);
    return () => { window.removeEventListener('popstate', onNav); window.removeEventListener(MEETING_EVENT, onEvent); };
  }, []);
  return route;
}

// The viewer's role in the company, once per workspace (GET …/org/humans).
const roleCache = new Map<string, Promise<{ role: string | null; ceo: string | null } | null>>();
/** roomStanding for the viewer; everything allowed until the role is known. */
export function useRoomStanding(wsId: string, createdBy: string, me: string): { steer: boolean; rule: boolean; answer: boolean } {
  const [who, setWho] = useState<{ role: string | null; ceo: string | null } | null | undefined>(undefined);
  useEffect(() => {
    if (!wsId) return;
    let on = true;
    if (!roleCache.has(wsId)) {
      roleCache.set(wsId, Promise.resolve().then(() => api.orgHumans(wsId)).then((h) => (h && h.me && 'role' in h.me ? { role: h.me.actorId === h.ceoAccountId ? 'ceo' : h.me.role, ceo: h.ceoAccountId ?? null } : null)).catch(() => null));
    }
    void roleCache.get(wsId)!.then((v) => { if (on) setWho(v); });
    return () => { on = false; };
  }, [wsId]);
  return roomStanding(createdBy, me, who ? who.role : undefined, who?.ceo);
}
/** Tests: forget the cached roles. */
export function resetRoomStanding(): void { roleCache.clear(); }

/** The thread composer's placeholder and note while a meeting runs: a person
 *  present is heard at the next turn, anyone else at the next round. */
export function meetingComposerHint(m: { status: string; room?: string } | null | undefined, me: string): { placeholder: string; note?: string } {
  if (m?.status !== 'running') return { placeholder: 'Reply in thread' };
  return parseRoom(m.room).present.includes(me)
    ? { placeholder: 'Speak — heard at the next turn; "stop" ends the meeting', note: 'You are in the room: the next speaker hears you. Mentions wake nobody; "stop" ends it.' }
    : { placeholder: 'Reply — read at the next round (Join to be heard at the next turn)', note: 'A meeting is running here: your message is read at the next round — Join to be heard at the next turn. Mentions wake nobody; "stop" ends it.' };
}

// ---- where a meeting's messages live (an adapter) ----

/** The meeting's message stream and composer target. Today a meeting is a
 *  thread in its channel (`threadStream`); a meeting held in its own
 *  sub-channel would be a stream whose `threadRootId` is null and whose
 *  `owns` takes every top-level message of that channel. The room views
 *  only talk to this interface. */
export interface MeetingStream {
  /** Identity: a new key reloads the transcript. */
  key: string;
  channelId: string; slug: string; folder: string;
  /** Where the composer posts: a thread root, or null for the channel's top level. */
  threadRootId: string | null;
  /** The message that opened the meeting (the agenda), drawn folded; null when there is none. */
  openerId: string | null;
  /** "Thread" / "Channel": the button that opens the stream in the chat. */
  placeLabel: string;
  load(): Promise<ChannelMessage[]>;
  /** A message posted in the channel belongs to this meeting. */
  owns(msg: Pick<ChannelMessage, 'id' | 'threadRootId'>): boolean;
  /** A live reply (channel_typing / channel_stream) is spoken in this meeting. */
  ownsLive(ev: { threadRootId: string | null; replyRootId?: string }): boolean;
}

/** A meeting held in a thread of its channel (docs/group-chat.md §8). */
export function threadStream(wsId: string, channel: { id: string; slug: string; folder?: string }, rootId: string): MeetingStream {
  return {
    key: `thread:${channel.id}:${rootId}`, channelId: channel.id, slug: channel.slug, folder: channel.folder ?? '', threadRootId: rootId, openerId: rootId, placeLabel: 'Thread',
    load: () => api.channelMessages(wsId, channel.slug, { thread: rootId, limit: 200 }).then((p) => p.messages),
    owns: (x) => x.id === rootId || x.threadRootId === rootId,
    ownsLive: (ev) => (ev.replyRootId ?? ev.threadRootId) === rootId,
  };
}

/** A meeting held in its own sub-channel (docs/group-chat.md §9): the
 *  channel's top level is the meeting; the agenda root, when posted, opens it. */
export function subChannelStream(wsId: string, channel: { id: string; slug: string; folder?: string }, openerId: string | null): MeetingStream {
  return {
    key: `sub:${channel.id}`, channelId: channel.id, slug: channel.slug, folder: channel.folder ?? '', threadRootId: null, openerId, placeLabel: 'Channel',
    load: () => api.channelMessages(wsId, channel.slug, { limit: 200 }).then((p) => p.messages),
    owns: (x) => !x.threadRootId,
    ownsLive: (ev) => !(ev.replyRootId ?? ev.threadRootId),
  };
}

/** The stream a meeting row names, given the workspace's channels: its
 *  sub-channel when it has a parent channel, else its thread; null until it has one. */
export function meetingStream(wsId: string, m: { channelId: string | null; threadRootId: string | null; parentChannelId?: string | null }, channels: Array<{ id: string; slug: string; folder?: string; channelKind?: string }>): MeetingStream | null {
  const ch = m.channelId ? channels.find((c) => c.id === m.channelId) : undefined;
  if (!ch) return null;
  if (m.parentChannelId || ch.channelKind === 'sub') return subChannelStream(wsId, ch, m.threadRootId);
  if (!m.threadRootId) return null;
  return threadStream(wsId, ch, m.threadRootId);
}
