/**
 * The meeting room (docs/meetings.md "During", "Before", "After"): the live
 * state of one meeting, kept as JSON on `org_meetings.room` (migration
 * 0050) so the SPA's room header, the people's controls and the runtime read
 * one record. Pure helpers only — no I/O:
 *
 *  - the agenda as items (the person's bullet lines, else the kind's
 *    standard items), with "Open items from the last meeting" first and the
 *    attendees' accepted proposals last; one is current, time-boxed by
 *    `meeting.itemMinutes`;
 *  - attendance per round (waiting / speaking / spoke / passed), the people
 *    present (Join), the passes;
 *  - who speaks in a round after the first when `meeting.selectiveRounds` is
 *    on: the facilitator always, others only with an open thread;
 *  - the previous meeting's action items classified done / late / blocked /
 *    open from the board tasks they became ("open items first");
 *  - whether a scheduled ritual's agenda is empty (auto-skip).
 */
import type { MeetingKind, Minutes } from './org-meetings.service';

/** `idle`: not called this round (no open thread, selective rounds). */
export type AttendanceState = 'waiting' | 'speaking' | 'spoke' | 'passed' | 'idle';

/** A previous meeting's action item, as the next ritual opens with it. */
export interface OpenItem { title: string; owner: string; taskId: string | null; taskKey?: string | null; state: 'done' | 'late' | 'blocked' | 'open' | 'dropped'; status: string; due: string | null }

export interface AgendaProposal { text: string; why: string; byKind: 'agent' | 'human'; by: string; at: string }

export interface Verdict { verdict: 'approved' | 'rejected'; by: string; byName: string; at: string; note?: string }
export interface Answer { answer: string; by: string; byName: string; at: string; messageId?: string }

export interface MeetingRoom {
  /** Agenda items; `current` indexes the one being discussed (= items.length when all are done). */
  items: string[];
  current: number;
  itemStartedAt: string | null;
  itemMinutes: number;
  round: number;
  roundCap: number;
  /** Rounds added with Extend. */
  extended: number;
  /** The agent whose turn it is, or null between turns. */
  speaking: string | null;
  /** This round's attendance per agent attendee. */
  attendance: Record<string, AttendanceState>;
  /** Every pass, in order. */
  passes: Array<{ agentId: string; round: number; reason: string }>;
  /** People present (Join). */
  present: string[];
  /** Agenda items proposed before the start. */
  proposals: AgendaProposal[];
  /** The facilitator's pre-read (composed without a model). */
  preRead: string;
  /** The previous meeting's action items. */
  openItems: OpenItem[];
  /** People's verdicts on proposed decisions and actions: key `decision:<i>` / `action:<i>`. */
  verdicts: Record<string, Verdict>;
  /** People's answers to the attendees' questions for the CEO: key `question:<i>`. */
  answers: Record<string, Answer>;
  /** People's controls, applied at the next turn boundary. */
  controls: { extend: number; skip: number; skipped: number; end: { by: string; at: string } | null };
  /** When the "starts in N min" reminder went out. */
  remindedAt: string | null;
  /** When the meeting was prepared (pre-read compiled, proposals open). */
  preparedAt: string | null;
  /** Speaking order of the agent attendees (the facilitator last). */
  speakers: string[];
  /** Why the meeting skipped itself, when it did. */
  skipped: string | null;
  /** The agenda and pre-read file beside the minutes (`orgPath.agenda`), once written. */
  agendaPath: string | null;
}

export function emptyRoom(): MeetingRoom {
  return {
    items: [], current: 0, itemStartedAt: null, itemMinutes: 10, round: 0, roundCap: 0, extended: 0, speaking: null, attendance: {}, passes: [], present: [],
    proposals: [], preRead: '', openItems: [], verdicts: {}, answers: {}, controls: { extend: 0, skip: 0, skipped: 0, end: null }, remindedAt: null, preparedAt: null, speakers: [], skipped: null, agendaPath: null,
  };
}

/** Parse the room JSON defensively (missing → defaults). */
export function parseRoom(raw: string | null | undefined): MeetingRoom {
  const base = emptyRoom();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<MeetingRoom>;
    if (!v || typeof v !== 'object') return base;
    return {
      ...base, ...v,
      items: Array.isArray(v.items) ? v.items.map(String) : [],
      attendance: v.attendance && typeof v.attendance === 'object' ? v.attendance : {},
      passes: Array.isArray(v.passes) ? v.passes : [],
      present: Array.isArray(v.present) ? v.present.map(String) : [],
      proposals: Array.isArray(v.proposals) ? v.proposals : [],
      openItems: Array.isArray(v.openItems) ? v.openItems : [],
      verdicts: v.verdicts && typeof v.verdicts === 'object' ? v.verdicts : {},
      answers: v.answers && typeof v.answers === 'object' ? v.answers : {},
      controls: { ...base.controls, ...(v.controls ?? {}) },
      speakers: Array.isArray(v.speakers) ? v.speakers.map(String) : [],
    };
  } catch { return base; }
}

const STANDARD_ITEMS: Record<MeetingKind, string[]> = {
  standup: ['Done, next, blocked — what the board cannot know'],
  weekly_review: ['Scorecard: goals on pace or at risk', 'What shipped, what slipped and why', 'Replans and owners'],
  planning: ['What the goals need next', 'Tasks and owners', 'Risks and questions for the CEO'],
  retro: ['What worked', 'What did not', 'Lessons and changes to propose'],
  board: ['The strategy memo in brief', 'Spend versus plan', 'Decisions for the CEO and board'],
  adhoc: [],
};

export const MAX_AGENDA_ITEMS = 8;
export const OPEN_ITEMS_TITLE = 'Open items from the last meeting';

/** Bullet or numbered lines of an agenda the person wrote ("- x", "* x", "1. x", "1) x"). */
export function bulletItems(agenda: string): string[] {
  const out: string[] = [];
  for (const line of (agenda ?? '').split('\n')) {
    const m = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.+?)\s*$/.exec(line);
    if (m && m[1].length >= 2) out.push(m[1].slice(0, 160));
  }
  return out;
}

/**
 * The agenda as items: the open items of the last meeting first (when there
 * are any), then the person's bullet lines (else, for a ritual, its standard
 * items; for an ad-hoc meeting the agenda's first line), then the accepted
 * proposals. At most MAX_AGENDA_ITEMS.
 */
export function agendaItems(kind: MeetingKind, userAgenda: string, openItems: number, proposals: AgendaProposal[]): string[] {
  const own = bulletItems(userAgenda);
  const first = (userAgenda ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const body = own.length ? own : STANDARD_ITEMS[kind]?.length ? STANDARD_ITEMS[kind] : [first ? first.slice(0, 160) : 'The agenda as called'];
  const items = [...(openItems > 0 ? [OPEN_ITEMS_TITLE] : []), ...body, ...proposals.map((p) => p.text.slice(0, 160))];
  return [...new Set(items)].slice(0, MAX_AGENDA_ITEMS);
}

/** Classify a previous action's task: done, blocked, dropped, late (past
 *  its due date, or not moved since the meeting that agreed it), or open. */
export function classifyOpenItem(task: { status: string; updatedAt: string; dueAt?: string | null } | null, agreedAt: string, now = new Date()): OpenItem['state'] {
  if (!task) return 'open';
  if (task.status === 'done') return 'done';
  if (task.status === 'cancelled') return 'dropped';
  if (task.status === 'blocked') return 'blocked';
  if (task.dueAt && task.dueAt < now.toISOString()) return 'late';
  return task.updatedAt <= agreedAt ? 'late' : 'open';
}

/** The open items as the agenda's first section. */
export function openItemsText(items: OpenItem[], kindTitle: string): string {
  if (items.length === 0) return '';
  const label: Record<OpenItem['state'], string> = { done: 'done', late: 'late', blocked: 'blocked', open: 'still open', dropped: 'dropped' };
  const order: OpenItem['state'][] = ['blocked', 'late', 'open', 'done', 'dropped'];
  const sorted = [...items].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return [`**${OPEN_ITEMS_TITLE}** (${kindTitle}; reviewed first):`, ...sorted.map((i) => `- ${i.title} — ${i.owner || 'unowned'}: ${label[i.state]}${i.due ? ` (due ${i.due.slice(0, 10)})` : ''}${i.taskId ? ` ${i.taskKey || `[${i.taskId.slice(0, 8)}]`}` : ''}`)].join('\n');
}

/** What a pre-read found, for the auto-skip rule. */
export interface PreReadCounts { deltas: number; blocked: number; checkIns: number; atRisk: number }

/** A scheduled ritual's agenda is empty when nothing changed, nothing is
 *  open, nothing blocked and nobody proposed anything. */
export function agendaIsEmpty(counts: PreReadCounts, openItems: OpenItem[], proposals: AgendaProposal[]): boolean {
  const open = openItems.filter((i) => i.state !== 'done' && i.state !== 'dropped').length;
  return counts.deltas === 0 && counts.blocked === 0 && counts.checkIns === 0 && counts.atRisk === 0 && open === 0 && proposals.length === 0;
}

const wordRe = (name: string) => new RegExp(`(^|[^\\p{L}\\p{N}_])@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'iu');

/**
 * Whether an attendee has an open thread since its last turn (selective
 * rounds): named in a message by someone else, given an action by someone
 * else, or one of its questions for the CEO was answered.
 */
export function hasOpenThread(input: {
  agentId: string; name: string; since: string;
  thread: Array<{ authorKind: string; authorId: string; text: string; createdAt: string }>;
  minutes: Minutes; answers: Record<string, Answer>; actionsSince: number;
}): boolean {
  const { agentId, name, since } = input;
  const re = name.trim() ? wordRe(name.trim()) : null;
  if (re && input.thread.some((x) => x.createdAt > since && !(x.authorKind === 'agent' && x.authorId === agentId) && x.authorKind !== 'system' && re.test(x.text))) return true;
  const owner = name.trim().toLowerCase();
  if (input.minutes.actions.slice(input.actionsSince).some((a) => a.by !== agentId && a.owner.trim().toLowerCase() === owner)) return true;
  return input.minutes.questions.some((q, i) => q.by === agentId && (input.answers[`question:${i}`]?.at ?? '') > since);
}

/** Elapsed minutes in the current item, at `now`. */
export function itemElapsedMinutes(room: MeetingRoom, now: Date): number {
  if (!room.itemStartedAt) return 0;
  return Math.max(0, (now.getTime() - Date.parse(room.itemStartedAt)) / 60_000);
}

/** "12.3k" tokens. */
export function tokensText(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

/** The agenda document (docs/meetings.md "Before"): items, the open items,
 *  the pre-read and the attendees' proposals, as markdown. Pure. */
export function agendaMarkdown(input: { title: string; kindTitle: string; when: string; items: string[]; agenda: string; openItems: OpenItem[]; preRead: string; proposals: Array<{ text: string; why: string; by: string }> }): string {
  const lines = [`# Agenda — ${input.title}`, '', `${input.kindTitle} · ${input.when}`, ''];
  if (input.items.length) lines.push('## Items', '', ...input.items.map((x, i) => `${i + 1}. ${x}`), '');
  if (input.openItems.length) lines.push(openItemsText(input.openItems, 'the last meeting'), '');
  if (input.agenda.trim()) lines.push('## Agenda', '', input.agenda.trim(), '');
  if (input.preRead.trim()) lines.push('## Pre-read', '', input.preRead.trim(), '');
  lines.push('## Proposed by attendees', '', ...(input.proposals.length ? input.proposals.map((p) => `- ${p.text}${p.why ? ` — ${p.why}` : ''} (${p.by})`) : ['_None yet — propose until the meeting starts._']), '');
  return lines.join('\n');
}
