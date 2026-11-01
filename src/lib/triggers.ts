/** Client-side mirror of server/src/chats/loop-def.ts: the loop shape and
 *  the labels the schedule tab shows for each way a loop can run
 *  (docs/triggers.md). Pure functions, unit-tested in web-tests/. */

export type LoopTrigger =
  | { kind: 'mail'; service: 'gmail' | 'msmail'; query: string; connectionId?: string; pollMinutes?: number }
  | { kind: 'calendar'; service: 'gcal' | 'mscal'; withinHours: number; on: 'created' | 'changed' | 'starting'; leadMinutes?: number; connectionId?: string; pollMinutes?: number }
  | { kind: 'task' }
  | { kind: 'webhook'; secretHash?: string };

export interface Loop {
  name: string;
  cron?: string;
  prompt?: string;
  enabled?: boolean;
  model?: string;
  budgetTokens?: number;
  trigger?: LoopTrigger;
}

/** The "Runs when" chooser: a schedule or one of the trigger kinds. */
export type RunsWhen = 'schedule' | 'mail' | 'calendar' | 'task' | 'webhook';

export const RUNS_WHEN: Array<{ id: RunsWhen; label: string; hint: string }> = [
  { id: 'schedule', label: 'On a schedule', hint: '5-field cron, server-local time' },
  { id: 'mail', label: 'New mail matching', hint: 'polled every few minutes on a granted connection' },
  { id: 'calendar', label: 'Calendar change', hint: 'an event created, changed, or about to start' },
  { id: 'task', label: 'Task assigned', hint: 'someone (or another agent) puts work on this board' },
  { id: 'webhook', label: 'Webhook', hint: 'a POST to a secret URL fires it at once' },
];

export function runsWhenOf(loop: Pick<Loop, 'trigger'>): RunsWhen {
  return loop.trigger?.kind ?? 'schedule';
}

/** One line summarizing how a loop runs, for the loop list. */
export function triggerLabel(loop: Loop): string {
  const t = loop.trigger;
  const parts: string[] = [];
  if (t?.kind === 'mail') parts.push(`${t.service === 'gmail' ? 'Gmail' : 'Outlook'} mail matching "${t.query || '*'}" · every ${t.pollMinutes ?? 5}m`);
  else if (t?.kind === 'calendar') {
    const svc = t.service === 'gcal' ? 'Google Calendar' : 'Outlook Calendar';
    parts.push(t.on === 'starting'
      ? `${svc} event starting within ${t.leadMinutes ?? 15}m`
      : `${svc} event ${t.on} in the next ${t.withinHours}h`);
  } else if (t?.kind === 'task') parts.push('a task is assigned');
  else if (t?.kind === 'webhook') parts.push('webhook POST');
  if (loop.cron) parts.push(loop.cron);
  return parts.join(' · ') || 'never (no schedule or trigger)';
}

/** The glyph key (src/lib/icons P) for each way a loop runs. */
export function triggerGlyph(loop: Pick<Loop, 'trigger'>): 'clock' | 'at' | 'rows' | 'board' | 'bolt' {
  switch (loop.trigger?.kind) {
    case 'mail': return 'at';
    case 'calendar': return 'rows';
    case 'task': return 'board';
    case 'webhook': return 'bolt';
    default: return 'clock';
  }
}

/** "fired 3 min ago" / "never fired" for the loop list. */
export function lastFiredLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'never fired';
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'fired just now';
  if (m < 60) return `fired ${m} min ago`;
  if (m < 48 * 60) return `fired ${Math.round(m / 60)} h ago`;
  return `fired ${Math.round(m / (24 * 60))} d ago`;
}
