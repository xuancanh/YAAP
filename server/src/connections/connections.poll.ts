/**
 * Connection pollers for event triggers (docs/triggers.md): the read calls
 * the mail and calendar triggers make every few minutes, over the same
 * authenticated GoogleHttp seam the tools use. They return plain summaries
 * — never message bodies — and the loop prompt frames whatever they return
 * as data, not instructions.
 */
import type { ConnectionRow, GoogleHttp } from './connections.tools';

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  /** ISO timestamp when known. */
  date: string;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  /** ISO start; all-day events carry the date at midnight UTC. */
  start: string;
  end: string;
  location: string;
  /** Provider's last-modified stamp — the "changed" signal. */
  updated: string;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GCAL_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Ids listed per poll; detail fetches are bounded by what is unseen. */
const LIST_LIMIT = 20;
const DETAIL_LIMIT = 10;

export interface MailPollResult {
  /** Every id the query currently matches (newest first) — the dedupe set. */
  ids: string[];
  /** Summaries for ids not in `knownIds`, at most DETAIL_LIMIT. */
  messages: MailSummary[];
}

/** Gmail: `messages.list?q=` then metadata-only `messages.get` for unseen
 *  ids. Requires gmail.readonly on the connection (the "Gmail reading" tier). */
export async function pollGmail(conn: ConnectionRow, http: GoogleHttp, query: string, knownIds: Set<string>): Promise<MailPollResult> {
  const list = await http.googleGet(conn, `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(LIST_LIMIT) })}`) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);
  const messages: MailSummary[] = [];
  for (const id of ids.filter((i) => !knownIds.has(i)).slice(0, DETAIL_LIMIT)) {
    const msg = await http.googleGet(conn, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`) as {
      id: string; snippet?: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const header = (name: string) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
    const ms = Number(msg.internalDate);
    messages.push({
      id: msg.id ?? id,
      from: header('from').slice(0, 200),
      subject: header('subject').slice(0, 300),
      snippet: (msg.snippet ?? '').slice(0, 300),
      date: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : header('date').slice(0, 60),
    });
  }
  return { ids, messages };
}

/** Outlook via Graph: `$search` when a query is given (KQL), newest first
 *  otherwise. Mail.ReadWrite (the mail tier) already covers reading. */
export async function pollGraphMail(conn: ConnectionRow, http: GoogleHttp, query: string, knownIds: Set<string>): Promise<MailPollResult> {
  const select = '$select=id,from,subject,bodyPreview,receivedDateTime';
  const url = query
    ? `${GRAPH}/me/messages?$search=${encodeURIComponent(`"${query.replace(/"/g, '')}"`)}&$top=${LIST_LIMIT}&${select}`
    : `${GRAPH}/me/messages?$orderby=receivedDateTime desc&$top=${LIST_LIMIT}&${select}`;
  const res = await http.googleGet(conn, url) as { value?: Array<Record<string, unknown>> };
  const rows = res.value ?? [];
  const ids = rows.map((m) => String(m.id));
  const messages = rows.filter((m) => !knownIds.has(String(m.id))).slice(0, DETAIL_LIMIT).map((m) => {
    const from = (m.from as { emailAddress?: { name?: string; address?: string } })?.emailAddress;
    return {
      id: String(m.id),
      from: [from?.name, from?.address ? `<${from.address}>` : ''].filter(Boolean).join(' ').slice(0, 200),
      subject: String(m.subject ?? '').slice(0, 300),
      snippet: String(m.bodyPreview ?? '').slice(0, 300),
      date: String(m.receivedDateTime ?? ''),
    };
  });
  return { ids, messages };
}

/** Google Calendar: every instance in [now, now + withinHours]. */
export async function pollGcal(conn: ConnectionRow, http: GoogleHttp, now: Date, withinHours: number): Promise<CalendarEventSummary[]> {
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + withinHours * 3_600_000).toISOString();
  const res = await http.googleGet(conn, `${GCAL_EVENTS_URL}?${new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50',
  })}`) as { items?: Array<Record<string, unknown>> };
  return (res.items ?? []).map((e) => {
    const start = (e.start as Record<string, string>) ?? {};
    const end = (e.end as Record<string, string>) ?? {};
    return {
      id: String(e.id ?? ''),
      title: String(e.summary ?? '(no title)').slice(0, 200),
      start: start.dateTime ?? (start.date ? `${start.date}T00:00:00.000Z` : ''),
      end: end.dateTime ?? (end.date ? `${end.date}T00:00:00.000Z` : ''),
      location: String(e.location ?? '').slice(0, 200),
      updated: String(e.updated ?? ''),
    };
  }).filter((e) => e.id);
}

/** Outlook calendar via Graph calendarView (UTC without a Prefer header). */
export async function pollGraphCalendar(conn: ConnectionRow, http: GoogleHttp, now: Date, withinHours: number): Promise<CalendarEventSummary[]> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + withinHours * 3_600_000).toISOString();
  const res = await http.googleGet(conn, `${GRAPH}/me/calendarView?startDateTime=${from}&endDateTime=${to}&$orderby=start/dateTime&$top=50&$select=id,subject,start,end,location,isAllDay,lastModifiedDateTime`) as { value?: Array<Record<string, unknown>> };
  const iso = (v: Record<string, string> | undefined) => {
    const dt = v?.dateTime ?? '';
    if (!dt) return '';
    // Graph omits the offset; without a Prefer header the value is UTC.
    return /Z$|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt.replace(/(\.\d{3})\d+$/, '$1')}Z`;
  };
  return (res.value ?? []).map((e) => ({
    id: String(e.id ?? ''),
    title: String(e.subject ?? '(no title)').slice(0, 200),
    start: iso(e.start as Record<string, string>),
    end: iso(e.end as Record<string, string>),
    location: String((e.location as { displayName?: string })?.displayName ?? '').slice(0, 200),
    updated: String(e.lastModifiedDateTime ?? ''),
  })).filter((e) => e.id);
}
