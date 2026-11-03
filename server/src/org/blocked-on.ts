/**
 * One structured blocker per task (docs/work-tracking.md "Blocked is one
 * field"). Before it, "blocked" was written five ways: structured blocker
 * lines (`escalated: …`, `escalated to X: …`, a task id), an empty list with
 * the reason in a comment, a CEO escalation card, an `Escalation:` child task
 * and a kanban note. `blockedOn` replaces them:
 *
 *   { kind, ref, reason, since, by }
 *
 *  - `task`     — waits on another task (ref = its id); the task waits
 *                 (`dependsOn` + `waiting`) and moves again when it is done;
 *  - `person`   — a human of the workspace (ref = account id): it lands in
 *                 that person's queue (Inbox › My tasks);
 *  - `agent`    — another member (ref = agent id): an inbox event for it;
 *  - `manager`  — the owner's direct manager (ref = resolved agent id, or ''
 *                 when the manager is the CEO): the decision-routing helper
 *                 decides who that is; the field stays generic;
 *  - `ceo`      — the CEO: a decision card (Needs you) is created;
 *  - `external` — the world outside the company (a vendor, an API, data);
 *  - `decision` — a pending decision card (ref = approval id); deciding it
 *                 unblocks the task.
 *
 * `since` is set when the blocker is set and changes only when the blocker
 * itself changes (another kind or ref) — never on a comment. Pure: no Nest,
 * no database; the migration's backfill uses it too.
 */

export const BLOCKED_KINDS = ['task', 'person', 'agent', 'manager', 'ceo', 'external', 'decision'] as const;
export type BlockedKind = typeof BLOCKED_KINDS[number];

export interface BlockedOn {
  kind: BlockedKind;
  /** What it waits on: a task id, an account id, an agent id, an approval id; '' when the kind says it all. */
  ref: string;
  /** The ask, in words: what would unblock it. Required. */
  reason: string;
  /** When this blocker was set (ISO). */
  since: string;
  /** Who set it (an actor string: user, chief, agent:<id>, system, migration). */
  by?: string;
}

export function isBlockedKind(v: unknown): v is BlockedKind {
  return typeof v === 'string' && (BLOCKED_KINDS as readonly string[]).includes(v);
}

/** The stored JSON as an object, or null for '' / garbage. */
export function parseBlockedOn(raw: string | null | undefined): BlockedOn | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BlockedOn>;
    if (!v || !isBlockedKind(v.kind)) return null;
    return { kind: v.kind, ref: String(v.ref ?? ''), reason: String(v.reason ?? ''), since: String(v.since ?? ''), ...(v.by ? { by: String(v.by) } : {}) };
  } catch { return null; }
}

export function serializeBlockedOn(b: BlockedOn | null): string {
  return b ? JSON.stringify({ kind: b.kind, ref: b.ref, reason: b.reason.slice(0, 600), since: b.since, ...(b.by ? { by: b.by } : {}) }) : '';
}

/** Whether two blockers are the same blocker (kind and ref): `since` survives. */
export function sameBlocker(a: BlockedOn | null, b: BlockedOn | null): boolean {
  return Boolean(a && b && a.kind === b.kind && a.ref === b.ref);
}

/** One line for the board, the heartbeat and the model. */
export function describeBlockedOn(b: BlockedOn | null, nameOf: (kind: BlockedKind, ref: string) => string = (_k, r) => r): string {
  if (!b) return '';
  const who = b.ref ? nameOf(b.kind, b.ref) : '';
  const head = {
    task: `waits on task ${who || '?'}`,
    person: `waits on ${who || 'a person'}`,
    agent: `waits on ${who || 'a member'}`,
    manager: `waits on the manager${who ? ` (${who})` : ''}`,
    ceo: 'waits on the CEO',
    external: 'waits on something outside the company',
    decision: `waits on a decision${who ? ` (${who})` : ''}`,
  }[b.kind];
  return `${head}${b.reason ? `: ${b.reason}` : ''}`;
}

/** Free text that asks the CEO / user / owner for a decision ("User decision on …", "principal's yes/no"). */
const CEO_TEXT = /\b(user|ceo|owner|principal|founder)('s)?\b[^.]{0,60}\b(decision|decide|approv\w*|yes\/no|sign[- ]?off|answer|go-ahead|input)\b|\b(decision|approval|sign[- ]?off|yes\/no)\b[^.]{0,40}\b(from|by|of) (the )?(user|ceo|owner|principal|founder)\b/i;
const TASK_KEY_LINE = /^[A-Za-z][A-Za-z0-9]{1,5}-\d{1,7}$/;
const ID_LINE = /^[0-9a-f-]{8,}$/i;

/**
 * Best-effort reading of the legacy forms into one blocker (the migration
 * and old rows read on the fly). `lines` are the blocker strings, newest
 * last; `comment` the latest timeline text when the list is empty;
 * `pendingCard` the id of a pending CEO escalation card for the task.
 */
export function legacyBlockedOn(input: {
  lines: string[];
  comment?: string | null;
  pendingCard?: string | null;
  since: string;
  /** Resolve a name to a member id (for `escalated to <name>: …`). */
  agentByName?: (name: string) => string | null;
  /** The owner's direct manager, to tell `manager` from `agent`. */
  managerId?: string | null;
  /** Resolve a task key or id prefix to a task id. */
  taskByRef?: (ref: string) => string | null;
}): BlockedOn {
  const since = input.since;
  const by = 'migration';
  for (const raw of input.lines.slice().reverse()) {
    const line = raw.trim();
    if (!line) continue;
    const to = /^escalated to (.+?): ([\s\S]*)$/.exec(line);
    if (to) {
      const id = input.agentByName?.(to[1]) ?? null;
      const kind: BlockedKind = id && input.managerId && id === input.managerId ? 'manager' : 'agent';
      return { kind, ref: id ?? '', reason: to[2].trim().slice(0, 600) || `escalated to ${to[1]}`, since, by };
    }
    const ceo = /^escalated: ([\s\S]*)$/.exec(line);
    if (ceo) return { kind: 'ceo', ref: input.pendingCard ?? '', reason: ceo[1].trim().slice(0, 600) || 'escalated to the CEO', since, by };
    if (TASK_KEY_LINE.test(line) || ID_LINE.test(line)) {
      const id = input.taskByRef?.(line) ?? null;
      if (id) return { kind: 'task', ref: id, reason: `waits on ${line}`, since, by };
    }
  }
  const last = input.lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  const text = last || (input.comment ?? '').trim();
  if (input.pendingCard) return { kind: 'ceo', ref: input.pendingCard, reason: (text || 'escalated to the CEO').slice(0, 600), since, by };
  if (text && CEO_TEXT.test(text)) return { kind: 'ceo', ref: '', reason: text.slice(0, 600), since, by };
  if (/^budget stop\b/i.test(text)) return { kind: 'decision', ref: '', reason: text.slice(0, 600), since, by };
  return { kind: 'external', ref: '', reason: (text || 'blocked (no reason was recorded)').slice(0, 600), since, by };
}

/** The legacy one-line form written beside blockedOn, so readers of `blockers` keep working. */
export function blockerLine(b: BlockedOn, nameOf?: (kind: BlockedKind, ref: string) => string): string {
  if (b.kind === 'ceo') return `escalated: ${b.reason}`.slice(0, 300);
  if ((b.kind === 'agent' || b.kind === 'manager') && b.ref) return `escalated to ${nameOf ? nameOf(b.kind, b.ref) : b.ref}: ${b.reason}`.slice(0, 300);
  return b.reason.slice(0, 300);
}

/** A signature of the blocker *and* the state of what it waits on, so the
 *  heartbeat can tell "the blocker changed" from "still the same". */
export function blockerSignature(b: BlockedOn | null, state = ''): string {
  return b ? `${b.kind}:${b.ref}:${b.reason.slice(0, 80)}:${state}` : '';
}
