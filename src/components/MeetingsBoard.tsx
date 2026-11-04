/** Meetings as a list and a calendar (docs/meetings.md "The calendar"), for
 *  the Company section's Meetings pane (the company or one unit) and a
 *  channel's Meetings tab. One source: GET …/meetings — the meetings held
 *  (with their minutes) and the cadences' upcoming occurrences, each named by
 *  its unit. List: upcoming, then past. Calendar: a month grid, or the week's
 *  agenda at phone width. A meeting that was held (or is called) opens its
 *  room; Minutes opens its minutes in Artifacts; a cadence's upcoming
 *  occurrence, or a meeting with no room, opens its details. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type CalendarMeeting, type CalendarResponse } from '../lib/api';
import { cadenceText } from '../lib/home';
import { fmtUsd } from '../lib/pricing';
import { MEETING_KIND_TITLES } from '../lib/org';
import { addDays, byDay, clock, dayKey, monthGrid, openMeetingView, rangeFor, shortTitle, splitList, startOfDay, tokensText, weekDays, whenText } from '../lib/meetings';
import { MeetingStartDialog } from './MeetingStartDialog';
import { card, btn, pill, faint, linkBtn, label } from './org-ui';

type View = 'list' | 'calendar';
const VIEW_KEY = 'meetings.view';
const STATUS_COLOR: Record<string, string> = { upcoming: 'var(--accent)', running: 'var(--green)', scheduled: 'var(--amber)', postponed: 'var(--amber)', done: 'var(--text-faint)', cancelled: 'var(--red)', skipped: 'var(--text-faint)' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 24 * 60 * 60_000;

function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list'; } catch { return 'list'; }
}
function saveView(v: View): void {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
}

const statusLabel = (m: CalendarMeeting) => (m.status === 'upcoming' ? 'upcoming' : m.status);
/** Whether a row has a room to open: a meeting that ran in a thread or a sub-channel, or one called and not started yet. */
export const hasRoom = (m: CalendarMeeting): boolean => Boolean(m.meetingId && (m.threadRootId || m.subChannelSlug || m.status === 'running' || m.status === 'scheduled' || m.status === 'postponed'));

export function MeetingsBoard({ wsId, unitId, channel, showUnit = true, startIn }: {
  wsId: string; unitId?: string | null; channel?: string | null; showUnit?: boolean;
  /** A channel's Meetings tab: "Start meeting" here starts one in this channel. */
  startIn?: { id: string; slug: string } | null;
}) {
  const app = useApp();
  const phone = Boolean(app.stacked);
  const [view, setViewState] = useState<View>(readView);
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [data, setData] = useState<CalendarResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<CalendarMeeting | null>(null);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [starting, setStarting] = useState(false);
  const setView = (v: View) => { setViewState(v); saveView(v); setSelected(null); setDayOpen(null); };
  const calMode: 'month' | 'week' = phone ? 'week' : 'month';
  // The list covers the last 60 and the next 30 days (fixed when mounted).
  const [listRange] = useState(() => { const now = Date.now(); return { from: new Date(now - 60 * DAY_MS), to: new Date(now + 30 * DAY_MS) }; });
  const range = useMemo(() => (view === 'calendar' ? rangeFor(calMode, anchor) : listRange), [view, calMode, anchor, listRange]);
  const load = useCallback(async () => {
    try {
      setData(await api.meetings(wsId, { unitId, channel, from: range.from.toISOString(), to: range.to.toISOString() }));
      setFailed(null);
    } catch (e) { setFailed(e instanceof Error ? e.message : 'could not load the meetings'); }
  }, [wsId, unitId, channel, range]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 60_000); return () => clearInterval(t); }, [load]);

  // A meeting opens its room (title, calendar chip); its minutes only from Minutes.
  const open = (m: CalendarMeeting) => {
    if (hasRoom(m)) { openMeetingView(wsId, m.meetingId!); return; }
    if (m.minutesPath) { app.openFile({ kind: 'workspace', id: wsId }, m.minutesPath); return; }
    setSelected(m);
  };
  const openMinutes = (m: CalendarMeeting) => { if (m.minutesPath) app.openFile({ kind: 'workspace', id: wsId }, m.minutesPath); };
  // A meeting held in a sub-channel lives there, not in the channel it was called in.
  const openThread = (m: CalendarMeeting) => { const slug = m.subChannelSlug ?? m.channelSlug; if (slug) app.openChannel(slug, m.threadRootId); };
  // Join: present in the room (heard at the next turn), then the full-screen room.
  const join = (m: CalendarMeeting) => {
    if (!m.meetingId) { openThread(m); return; }
    void api.joinMeeting(wsId, m.meetingId).catch((e: unknown) => app.showToast(e instanceof Error ? e.message.slice(0, 140) : 'could not join'));
    openMeetingView(wsId, m.meetingId);
  };
  // View: the full-screen room (its summary once it ended).
  const viewRoom = (m: CalendarMeeting) => { if (m.meetingId) openMeetingView(wsId, m.meetingId); else openThread(m); };
  const items = data?.meetings ?? [];

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, flex: 1, minWidth: 120 }}>Meetings</div>
      {startIn && data?.hasOrg && <button style={btn(true)} onClick={() => setStarting(!starting)}>Start meeting</button>}
      <div role="group" aria-label="View" style={{ display: 'flex', gap: 2, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 2 }}>
        {(['list', 'calendar'] as View[]).map((v) => (
          <button key={v} aria-pressed={view === v} onClick={() => setView(v)} style={{ background: view === v ? 'var(--accent)' : 'none', color: view === v ? '#fff' : 'var(--text-dim)', border: 'none', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>{v}</button>
        ))}
      </div>
    </div>
  );

  if (data && !data.hasOrg) {
    return <div style={card}>{header}<div style={faint}>Meetings run in organization mode: enable it in Settings › Company, then <code>/meeting</code> in a channel starts one.</div></div>;
  }

  return (
    <div style={{ ...card, minWidth: 0 }}>
      {header}
      {starting && startIn && <MeetingStartDialog wsId={wsId} units={[]} channel={startIn} onDone={(m) => { setStarting(false); if (m) { void load(); setTimeout(() => { void api.orgMeeting(wsId, m.id).then(async (x) => {
        // Held in its own sub-channel: open that, not the channel it was called in.
        if (x.parentChannelId && x.channelId) { const sub = (await api.channels(wsId)).find((c) => c.id === x.channelId); await app.refreshChannels(); if (sub) app.openChannel(sub.slug); return; }
        if (x.threadRootId) app.openChannel(startIn.slug, x.threadRootId);
      }).catch(() => {}); }, 1500); } }} />}
      {failed && <div style={{ ...faint, color: 'var(--red)' }}>{failed}</div>}
      {!data && !failed && <div style={faint}>Loading…</div>}
      {data && view === 'list' && <ListView items={items} open={open} openMinutes={openMinutes} join={join} view={viewRoom} showUnit={showUnit} showAll={showAll} setShowAll={setShowAll} />}
      {data && view === 'calendar' && (
        <CalendarView mode={calMode} anchor={anchor} setAnchor={(d) => { setAnchor(d); setDayOpen(null); }} items={items} open={open} dayOpen={dayOpen} setDayOpen={setDayOpen} showUnit={showUnit} />
      )}
      {selected && <Details m={selected} onClose={() => setSelected(null)} openThread={openThread} openMinutes={(p) => app.openFile({ kind: 'workspace', id: wsId }, p)} />}
    </div>
  );
}

function Row({ m, open, openMinutes, join, view, showUnit }: { m: CalendarMeeting; open: (m: CalendarMeeting) => void; openMinutes: (m: CalendarMeeting) => void; join: (m: CalendarMeeting) => void; view: (m: CalendarMeeting) => void; showUnit: boolean }) {
  const tokens = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  return (
    <div data-testid="meeting-row" style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', alignItems: 'flex-start', minWidth: 0 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[m.status] ?? 'var(--border)', flex: 'none', marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <button onClick={() => open(m)} title={hasRoom(m) ? 'Open the meeting' : undefined} style={{ ...linkBtn, fontSize: 13, color: 'var(--text)', textAlign: 'left', overflowWrap: 'anywhere' }}>{m.title}</button>
          <span style={pill(m.status === 'upcoming' ? 'var(--accent-dim)' : undefined, 'var(--text)')}>{statusLabel(m)}</span>
          {showUnit && m.unitName && !m.title.includes(m.unitName) && <span style={pill()}>{m.unitName}</span>}
        </div>
        <div style={{ ...faint, marginTop: 2, overflowWrap: 'anywhere' }}>
          {whenText(m.at)}
          {m.cron ? <> · {cadenceText(m.cron, m.at)}</> : null}
          {m.facilitator ? <> · {m.facilitator.name}</> : null}
          {m.status === 'done' ? <> · {m.decisions} decision(s) · {m.actions} action(s)</> : null}
          {(m.status === 'done' || m.status === 'running') && (tokens > 0 || m.usd > 0) ? <span data-testid="meeting-cost"> · {tokensText(tokens)} tokens · {fmtUsd(m.usd)}</span> : null}
        </div>
        {m.summary && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.summary}</div>}
      </div>
      <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
        {m.minutesPath && <button style={btn()} onClick={() => openMinutes(m)} title={`Open /${m.minutesPath}`}>Minutes</button>}
        {m.status === 'running' && m.channelSlug && <button style={btn(true)} onClick={() => join(m)} title="Join the full-screen room: you are heard at the next turn">Join</button>}
        {m.status !== 'running' && hasRoom(m) && <button style={btn()} onClick={() => view(m)} title="Open the full-screen room">View</button>}
        {!m.minutesPath && !hasRoom(m) && <button style={btn()} onClick={() => open(m)}>Details</button>}
      </div>
    </div>
  );
}

function ListView({ items, open, openMinutes, join, view, showUnit, showAll, setShowAll }: { items: CalendarMeeting[]; open: (m: CalendarMeeting) => void; openMinutes: (m: CalendarMeeting) => void; join: (m: CalendarMeeting) => void; view: (m: CalendarMeeting) => void; showUnit: boolean; showAll: boolean; setShowAll: (v: boolean) => void }) {
  const { upcoming, past } = splitList(items);
  const shownUpcoming = showAll ? upcoming : upcoming.slice(0, 8);
  return (
    <div>
      <div style={{ ...label, marginTop: 4 }}>Upcoming ({upcoming.length})</div>
      {upcoming.length === 0 && <div style={{ ...faint, padding: '6px 0' }}>Nothing scheduled in the next 30 days.</div>}
      {shownUpcoming.map((m) => <Row key={m.id} m={m} open={open} openMinutes={openMinutes} join={join} view={view} showUnit={showUnit} />)}
      {upcoming.length > shownUpcoming.length && <button style={{ ...linkBtn, marginTop: 6 }} onClick={() => setShowAll(true)}>Show {upcoming.length - shownUpcoming.length} more</button>}
      <div style={{ ...label, marginTop: 12 }}>Past ({past.length})</div>
      {past.length === 0 && <div style={{ ...faint, padding: '6px 0' }}>No meeting held in the last 60 days. <code>/meeting</code> in a channel starts one.</div>}
      {past.map((m) => <Row key={m.id} m={m} open={open} openMinutes={openMinutes} join={join} view={view} showUnit={showUnit} />)}
    </div>
  );
}

function Chip({ m, open, showUnit }: { m: CalendarMeeting; open: (m: CalendarMeeting) => void; showUnit: boolean }) {
  const title = showUnit ? shortTitle(m) : shortTitle(m).replace(` · ${m.unitName ?? ''}`, '');
  return (
    <button onClick={() => open(m)} title={`${whenText(m.at)} · ${m.title}${hasRoom(m) ? ' — open the meeting' : m.minutesPath ? ' — open the minutes' : ''}`}
      style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--panel-2)', border: 'none', borderLeft: `3px solid ${STATUS_COLOR[m.status] ?? 'var(--border)'}`, borderRadius: 4, padding: '1px 4px', marginTop: 2, fontSize: 10.5, color: 'var(--text)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, opacity: m.status === 'cancelled' ? 0.6 : 1 }}>
      <span style={{ color: 'var(--text-faint)' }}>{clock(m.at)}</span> {title}
    </button>
  );
}

function CalendarView({ mode, anchor, setAnchor, items, open, dayOpen, setDayOpen, showUnit }: {
  mode: 'month' | 'week'; anchor: Date; setAnchor: (d: Date) => void; items: CalendarMeeting[]; open: (m: CalendarMeeting) => void;
  dayOpen: string | null; setDayOpen: (k: string | null) => void; showUnit: boolean;
}) {
  const days = useMemo(() => byDay(items), [items]);
  const today = dayKey(new Date());
  const step = (n: number) => setAnchor(mode === 'week' ? addDays(anchor, 7 * n) : new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  const title = mode === 'week'
    ? (() => { const w = weekDays(anchor); return `${w[0].toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${w[6].toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`; })()
    : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const nav = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
      <button style={btn()} aria-label="Previous" onClick={() => step(-1)}>‹</button>
      <button style={btn()} onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
      <button style={btn()} aria-label="Next" onClick={() => step(1)}>›</button>
      <div style={{ fontSize: 13, fontWeight: 600, marginLeft: 4, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} aria-live="polite">{title}</div>
    </div>
  );
  if (mode === 'week') {
    return (
      <div data-testid="week-agenda">
        {nav}
        {weekDays(anchor).map((d) => {
          const k = dayKey(d);
          const list = days.get(k) ?? [];
          return (
            <div key={k} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border-soft)', minWidth: 0 }}>
              <div style={{ width: 44, flex: 'none', textAlign: 'center' }}>
                <div style={{ ...faint, fontSize: 10.5 }}>{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: k === today ? 'var(--accent-hi)' : 'var(--text)' }}>{d.getDate()}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {list.length === 0 && <div style={{ ...faint, paddingTop: 6 }}>—</div>}
                {list.map((m) => (
                  <button key={m.id} onClick={() => open(m)} style={{ display: 'flex', gap: 8, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderLeft: `3px solid ${STATUS_COLOR[m.status] ?? 'var(--border)'}`, padding: '3px 8px', marginTop: 3, color: 'var(--text)', cursor: 'pointer', minWidth: 0 }}>
                    <span style={{ ...faint, flex: 'none' }}>{clock(m.at)}</span>
                    <span style={{ fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{showUnit ? m.title : m.title.replace(` · ${m.unitName ?? ''}`, '')}</span>
                    {m.minutesPath && <span style={{ ...faint, flex: 'none', marginLeft: 'auto' }}>minutes</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  const grid = monthGrid(anchor);
  const month = anchor.getMonth();
  const MAX = 3;
  return (
    <div data-testid="month-grid">
      {nav}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 2 }}>
        {WEEKDAYS.map((w) => <div key={w} style={{ ...label, textAlign: 'center', padding: '2px 0' }}>{w}</div>)}
        {grid.flat().map((d) => {
          const k = dayKey(d);
          const list = days.get(k) ?? [];
          const inMonth = d.getMonth() === month;
          return (
            <div key={k} data-day={k} style={{ minHeight: 78, minWidth: 0, border: '1px solid var(--border-soft)', borderRadius: 6, padding: 3, background: k === today ? 'var(--accent-dim)' : 'var(--panel)', opacity: inMonth ? 1 : 0.5 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: k === today ? 'var(--accent-hi)' : 'var(--text-dim)' }}>{d.getDate()}</div>
              {list.slice(0, MAX).map((m) => <Chip key={m.id} m={m} open={open} showUnit={showUnit} />)}
              {list.length > MAX && <button style={{ ...linkBtn, fontSize: 10.5, marginTop: 2 }} onClick={() => setDayOpen(dayOpen === k ? null : k)}>+{list.length - MAX} more</button>}
            </div>
          );
        })}
      </div>
      {dayOpen && (
        <div style={{ marginTop: 10 }}>
          <div style={label}>{new Date(`${dayOpen}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {(days.get(dayOpen) ?? []).map((m) => <Chip key={m.id} m={m} open={open} showUnit={showUnit} />)}
        </div>
      )}
    </div>
  );
}

function Details({ m, onClose, openThread, openMinutes }: { m: CalendarMeeting; onClose: () => void; openThread: (m: CalendarMeeting) => void; openMinutes: (path: string) => void }) {
  const agents = m.attendees.filter((a) => a.kind === 'agent').map((a) => a.name);
  const people = m.attendees.filter((a) => a.kind === 'human').map((a) => a.name);
  // It opens under the list or the calendar: bring it into view.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [m.id]);
  return (
    <div ref={ref} role="dialog" aria-label={`${m.title} details`} style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--panel-2)', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{m.title}</div>
          <div style={{ ...faint, marginTop: 2 }}>{MEETING_KIND_TITLES[m.kind] ?? m.kind} · {statusLabel(m)}{m.unitName ? ` · ${m.unitName}` : ''}{m.channelSlug ? ` · #${m.channelSlug}` : ''}</div>
        </div>
        <button style={btn()} onClick={onClose} aria-label="Close details">✕</button>
      </div>
      <div style={{ display: 'grid', gap: 4, marginTop: 8, fontSize: 12.5 }}>
        <div><span style={faint}>When </span>{whenText(m.at)}{m.cron ? ` · ${cadenceText(m.cron, m.at)}` : ''}</div>
        {m.facilitator && <div><span style={faint}>Facilitator </span>{m.facilitator.name}</div>}
        {(agents.length > 0 || people.length > 0) && <div style={{ overflowWrap: 'anywhere' }}><span style={faint}>Attendees </span>{[...agents, ...people].join(', ')}</div>}
        {m.summary && <div style={{ color: 'var(--text-dim)' }}>{m.summary}</div>}
        {m.status === 'upcoming' && <div style={faint}>From the cadence; it starts on its own (the agenda is composed then). Change it under Cadences.</div>}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {m.minutesPath && <button style={btn(true)} onClick={() => openMinutes(m.minutesPath!)}>Open minutes</button>}
        {m.threadRootId && (m.subChannelSlug || m.channelSlug) && <button style={btn()} onClick={() => openThread(m)}>{m.subChannelSlug ? 'Open channel' : 'Open thread'}</button>}
      </div>
    </div>
  );
}
