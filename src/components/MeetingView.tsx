/** The full-screen meeting room (docs/meetings.md "During" → "The
 *  full-screen room"): `#/ws/<workspaceId>/meeting/<meetingId>`, opened
 *  with Expand in the thread's room header, Room on the agenda root and
 *  Join / View on the Meetings list. It fills the main area:
 *
 *  - a top bar with the title, the status, the agenda ribbon (one segment
 *    per item, sized by its time box, the current one filling live) and
 *    Thread / Close;
 *  - left: the agenda with each item's state (done / current / upcoming /
 *    parked / skipped) and its time box, the open items from the last
 *    meeting, the pre-read, and the agenda proposals with the propose box;
 *  - center: the live transcript of the meeting thread — turns folded per
 *    attendee, the speaker's reply streaming in, people's messages — and
 *    the thread composer (Join to be heard at the next turn);
 *  - right: the stats (elapsed against the box, round N/M, tokens and $,
 *    skips) with Extend / Skip item / End, who is on the floor, the
 *    attendees' live state, the Proposed board (decisions, actions, risks,
 *    questions with Approve / Reject / Answer) and the parking lot.
 *
 *  Once the meeting ends the center switches to its summary: the minutes
 *  (opening the file in Artifacts), the decisions taken, the action items
 *  with their task keys, the cost. Live through meeting_update,
 *  channel_message, channel_typing and channel_stream on the workspace
 *  stream, with a poll as the fallback. Controls follow the server's rules
 *  (roomStanding); everyone else reads. On a phone the three columns are
 *  tabs. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type ChannelMember, type ChannelMessage, type OrgMeeting, type WorkspaceEvent } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import { MEETING_KIND_TITLES, parseMinutes } from '../lib/org';
import { Markdown, type RefResolver } from '../lib/md';
import {
  agendaRows, closeMeetingView, foldTurns, meetingComposerHint, meetingStream, minutesSince, mmss, parseRoom, proposalFor, proposedBoard, seats, tokensText, useRoomStanding,
  type AgendaRow, type MeetingRoute, type MeetingStream, type Proposed, type Turn,
} from '../lib/meetings';
import { Meter, ProposalControls, SeatAvatar } from './MeetingRoom';
import { AGENDA_STATE, OPEN_STATE, SEAT, primaryBtn, smallBtn, statusColor } from './meeting-ui';
import { Chip, Composer, MinutesCard } from './ChannelView';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' };
const heading: React.CSSProperties = { fontSize: 12.5, fontWeight: 650, color: 'var(--text)', margin: 0, display: 'flex', alignItems: 'baseline', gap: 6 };
const count: React.CSSProperties = { ...mono, fontSize: 11, color: 'var(--text-faint)', fontWeight: 400 };
const faint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.45 };
const noRefs: RefResolver = () => null;

interface LiveReply { liveId: string; agentId: string; threadRootId: string | null; replyRootId?: string; text: string }
type PhoneTab = 'agenda' | 'transcript' | 'room';
type Center = 'summary' | 'transcript';

const css = `
.mv-root{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--bg)}
.mv-grid{flex:1;display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr) minmax(280px,340px);min-height:0}
.mv-col{min-height:0;overflow-y:auto;display:flex;flex-direction:column}
.mv-side{background:var(--panel);padding:14px 14px 20px;gap:18px}
.mv-left{border-right:1px solid var(--border)}
.mv-right{border-left:1px solid var(--border)}
.mv-clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mv-turn-body.folded{max-height:180px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 70%,transparent);mask-image:linear-gradient(#000 70%,transparent)}
.mv-btn:focus-visible,.mv-root button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width: 1180px){.mv-grid{grid-template-columns:minmax(220px,260px) minmax(0,1fr) minmax(260px,300px)}}
@media (prefers-reduced-motion: reduce){.mv-root *{animation:none!important;transition:none!important}}
`;

/** The route host: picks the workspace the address names, then the room. */
export function MeetingScreen({ route }: { route: MeetingRoute }) {
  const app = useApp();
  const wsId = route.workspaceId ?? app.workspaceId;
  useEffect(() => {
    if (wsId && wsId !== app.workspaceId && app.workspaces.some((w) => w.id === wsId)) app.pickWorkspace(wsId);
  }, [wsId, app]);
  if (!wsId || wsId !== app.workspaceId) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Opening the meeting…</div>;
  return <MeetingView key={route.meetingId} wsId={wsId} meetingId={route.meetingId} />;
}

/** `stream` overrides where the meeting's messages come from (default:
 *  meetingStream — its thread in the channel). */
export function MeetingView({ wsId, meetingId, stream: given }: { wsId: string; meetingId: string; stream?: MeetingStream | null }) {
  const app = useApp();
  const me = app.me?.actorId ?? '';
  const [m, setM] = useState<OrgMeeting | null | undefined>(undefined);
  const [msgs, setMsgs] = useState<ChannelMessage[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [live, setLive] = useState<LiveReply[]>([]);
  const [typing, setTyping] = useState<Record<string, { agentId: string; threadRootId: string | null; replyRootId?: string }>>({});
  const [tab, setTab] = useState<PhoneTab>('transcript');
  const [center, setCenter] = useState<Center | null>(null);
  const [, setTick] = useState(0);

  const channelId = m?.channelId ?? null;
  const rootId = m?.threadRootId ?? null;
  const parentId = m?.parentChannelId ?? null;
  const derived = useMemo(() => meetingStream(wsId, { channelId, threadRootId: rootId, parentChannelId: parentId }, app.channels), [wsId, channelId, rootId, parentId, app.channels]);
  const candidate = given !== undefined ? given : derived;
  // Stable while it names the same place (the channel list refreshes often).
  const streamKey = candidate?.key ?? null;
  const stream = useMemo(() => candidate, [streamKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const slug = stream?.slug ?? null;
  const running = m?.status === 'running';
  const ended = m?.status === 'done' || m?.status === 'cancelled' || m?.status === 'skipped';

  const loadMeeting = useCallback(() => api.orgMeeting(wsId, meetingId).then(setM).catch(() => setM((cur) => (cur === undefined ? null : cur))), [wsId, meetingId]);
  const loadThread = useCallback(() => {
    if (!stream) return;
    void stream.load().then(setMsgs).catch(() => {});
  }, [stream]);
  useEffect(() => { void loadMeeting(); }, [loadMeeting]);
  useEffect(() => { loadThread(); }, [loadThread]);
  useEffect(() => { if (slug) void api.channel(wsId, slug).then((d) => setMembers(d.members)).catch(() => setMembers([])); }, [wsId, slug]);
  // The poll is the fallback for a dropped event stream: often while it runs.
  useEffect(() => {
    const t = setInterval(() => { void loadMeeting(); if (running) loadThread(); }, running ? 15_000 : 60_000);
    return () => clearInterval(t);
  }, [running, loadMeeting, loadThread]);
  useEffect(() => { if (!running) return; const t = setInterval(() => setTick((n) => n + 1), 1_000); return () => clearInterval(t); }, [running]);

  // Live: the room, the thread's messages, the speaker's reply.
  useEffect(() => {
    const chId = stream?.channelId ?? channelId;
    if (!chId) return;
    return app.onWorkspaceEvent((ev: WorkspaceEvent) => {
      if (ev.type === 'meeting_update') { if (ev.meetingId === meetingId) void loadMeeting(); return; }
      if (!('channelId' in ev) || ev.channelId !== chId) return;
      if (ev.type === 'channel_message') {
        const x = ev.message;
        if (!stream?.owns(x)) return;
        setMsgs((l) => (l.some((y) => y.id === x.id) ? l.map((y) => (y.id === x.id ? x : y)) : [...l, x]));
      } else if (ev.type === 'channel_typing') {
        if (!stream?.ownsLive(ev)) return;
        setTyping((t) => { const n = { ...t }; if (ev.on) n[ev.liveId] = { agentId: ev.agentId, threadRootId: ev.threadRootId, replyRootId: ev.replyRootId }; else delete n[ev.liveId]; return n; });
        if (!ev.on) setLive((l) => l.filter((x) => x.liveId !== ev.liveId));
      } else if (ev.type === 'channel_stream') {
        if (!stream?.ownsLive(ev)) return;
        setLive((l) => {
          const i = l.findIndex((x) => x.liveId === ev.liveId);
          if (ev.done) return i < 0 ? l : l.filter((x) => x.liveId !== ev.liveId);
          if (i < 0) return [...l, { liveId: ev.liveId, agentId: ev.agentId, threadRootId: ev.threadRootId, replyRootId: ev.replyRootId, text: ev.delta }];
          return l.map((x, j) => (j === i ? { ...x, text: x.text + ev.delta } : x));
        });
      }
    });
  }, [app, channelId, stream, meetingId, loadMeeting]);

  const nameOf = useCallback((kind: 'agent' | 'human' | 'system', id: string): string => {
    if (kind === 'system') return 'system';
    const mm = members.find((x) => x.memberKind === kind && x.memberId === id);
    if (mm) return mm.name;
    return kind === 'agent' ? (app.agents.find((a) => a.id === id)?.name ?? 'agent') : app.nameOf(id);
  }, [members, app]);

  if (m === undefined) return <div className="mv-root" style={{ alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 13 }}>Loading the meeting…</div>;
  if (m === null) {
    return (
      <div className="mv-root" style={{ alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-dim)', fontSize: 13 }}>
        <style>{css}</style>
        <div>This meeting could not be loaded. It may belong to another workspace.</div>
        <button style={smallBtn} onClick={closeMeetingView}>Close</button>
      </div>
    );
  }

  const room = parseRoom(m.room);
  const minutes = parseMinutes(m.minutes);
  const rows = agendaRows(room, m.status, minutes);
  const attendees = (() => { try { return JSON.parse(m.attendees || '[]') as Array<{ kind: 'agent' | 'human'; id: string }>; } catch { return []; } })();
  const strip = seats(room, attendees, m.facilitatorAgentId, (k, id) => nameOf(k, id));
  const onChanged = (x: OrgMeeting) => setM(x);
  const centerView: Center = center ?? (ended && m.status !== 'skipped' ? 'summary' : 'transcript');
  const stacked = app.stacked;

  const left = <AgendaRail wsId={wsId} m={m} rows={rows} onChanged={onChanged} />;
  const right = <RoomPanel wsId={wsId} m={m} strip={strip} live={live} me={me} nameOf={nameOf} onChanged={onChanged} />;
  const middle = (
    <CenterPane wsId={wsId} m={m} stream={stream} msgs={msgs} live={live} typing={typing} me={me} nameOf={nameOf} members={members}
      view={centerView} setView={setCenter} onChanged={onChanged} />
  );

  return (
    <div className="mv-root" data-testid="meeting-view">
      <style>{css}</style>
      <TopBar m={m} rows={rows} stream={stream} />
      {stacked ? (
        <>
          <div role="tablist" aria-label="Meeting sections" style={{ display: 'flex', gap: 4, padding: '6px 12px', borderBottom: '1px solid var(--border)', background: 'var(--panel)', flex: 'none' }}>
            {([['agenda', 'Agenda'], ['transcript', centerView === 'summary' ? 'Summary' : 'Transcript'], ['room', 'Room']] as Array<[PhoneTab, string]>).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ flex: 1, background: tab === k ? 'var(--accent)' : 'var(--panel-2)', color: tab === k ? '#fff' : 'var(--text-dim)', border: '1px solid', borderColor: tab === k ? 'var(--accent)' : 'var(--border)', borderRadius: 8, padding: '6px 0', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{label}</button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {tab === 'agenda' && <div className="mv-col mv-side" style={{ flex: 1 }}>{left}</div>}
            {tab === 'transcript' && middle}
            {tab === 'room' && <div className="mv-col mv-side" style={{ flex: 1 }}>{right}</div>}
          </div>
        </>
      ) : (
        <div className="mv-grid">
          <aside aria-label="Agenda" className="mv-col mv-side mv-left">{left}</aside>
          <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{middle}</div>
          <aside aria-label="Room" className="mv-col mv-side mv-right">{right}</aside>
        </div>
      )}
    </div>
  );
}

// ---- top bar and the agenda ribbon ----

function TopBar({ m, rows, stream }: { m: OrgMeeting; rows: AgendaRow[]; stream: MeetingStream | null }) {
  const slug = stream?.slug ?? null;
  const app = useApp();
  const room = parseRoom(m.room);
  const running = m.status === 'running';
  const color = statusColor(m.status);
  const cur = rows.find((r) => r.state === 'current');
  const statusText = running ? (cur ? `Item ${cur.index + 1} of ${rows.length} · ${cur.text}` : 'Closing') : m.status === 'done' ? 'Ended' : m.status === 'scheduled' || m.status === 'postponed' ? (m.scheduledFor ? `Starts ${new Date(m.scheduledFor).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not started') : m.status === 'cancelled' ? 'Cancelled' : 'Skipped';
  const openThread = () => { if (!stream) return; closeMeetingView(); app.openChannel(stream.slug, stream.threadRootId); };
  return (
    <header style={{ flex: 'none', background: 'var(--panel)', borderBottom: '1px solid var(--border)', padding: app.stacked ? '8px 12px 10px' : '10px 18px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <button onClick={closeMeetingView} aria-label="Close the room" title="Back" style={{ ...smallBtn, padding: '4px 8px', fontSize: 13 }}>‹</button>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: color, flex: 'none', animation: running ? 'pulse 1.2s infinite' : undefined }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: app.stacked ? 15 : 17, fontWeight: 650, letterSpacing: '-.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={m.title}>{m.title || MEETING_KIND_TITLES[m.kind]}</h1>
          <div data-testid="mv-status" style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={statusText}>
            <span style={{ color, fontWeight: 600 }}>{running ? 'Live' : m.status === 'done' ? 'Ended' : m.status}</span>
            <span> · {MEETING_KIND_TITLES[m.kind] ?? m.kind}{slug ? ` in #${slug}` : ''}</span>
            {running && cur && <span> · {statusText}</span>}
            {!running && m.status !== 'done' && <span> · {statusText}</span>}
          </div>
        </div>
        {stream && <button style={smallBtn} onClick={openThread} title={`Open the meeting in #${stream.slug}`}>{stream.placeLabel}</button>}
      </div>
      {rows.length > 0 && <Ribbon rows={rows} itemMinutes={room.itemMinutes} />}
    </header>
  );
}

/** One segment per agenda item, sized by its time box (or the time it
 *  took, when longer); the current one fills as its box runs. */
function Ribbon({ rows, itemMinutes }: { rows: AgendaRow[]; itemMinutes: number }) {
  return (
    <ol aria-label="Agenda progress" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 3, height: 8 }}>
      {rows.map((r) => {
        const span = Math.max(itemMinutes, r.minutes ?? 0) || 1;
        const fill = r.state === 'done' ? 1 : r.state === 'current' ? Math.min(1, (r.minutes ?? 0) / Math.max(1, itemMinutes)) : 0;
        const over = r.state === 'current' && (r.minutes ?? 0) >= itemMinutes;
        const base = r.state === 'skipped' ? 'repeating-linear-gradient(135deg,var(--border) 0 3px,transparent 3px 6px)' : r.state === 'parked' ? 'var(--amber)' : 'var(--panel-2)';
        return (
          <li key={r.index} data-state={r.state} title={`${r.index + 1}. ${r.text} — ${AGENDA_STATE[r.state].label}${r.minutes !== null ? ` · ${mmss(r.minutes)} of ${itemMinutes}:00` : ''}`}
            style={{ flex: `${span} 1 0`, minWidth: 6, borderRadius: 4, background: base, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', opacity: r.state === 'parked' ? 0.6 : 1 }}>
            <span style={{ position: 'absolute', inset: 0, width: `${fill * 100}%`, background: over ? 'var(--red)' : r.state === 'done' ? 'var(--green)' : 'var(--accent)', opacity: r.state === 'done' ? 0.55 : 1, transition: 'width 1s linear' }} />
          </li>
        );
      })}
    </ol>
  );
}

// ---- left: the agenda rail ----

function AgendaRail({ wsId, m, rows, onChanged }: { wsId: string; m: OrgMeeting; rows: AgendaRow[]; onChanged: (m: OrgMeeting) => void }) {
  const app = useApp();
  const room = parseRoom(m.room);
  const before = m.status === 'scheduled' || m.status === 'postponed';
  const [proposal, setProposal] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [pre, setPre] = useState(before);
  const open = room.openItems.filter((i) => i.state !== 'done' && i.state !== 'dropped').length;
  const propose = async () => {
    const t = proposal.trim(); if (!t) return;
    setBusy(true);
    try { onChanged(await api.proposeMeetingAgenda(wsId, m.id, t, why.trim() || undefined)); setProposal(''); setWhy(''); app.showToast('Proposed for the agenda'); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  return (
    <>
      <section aria-labelledby="mv-agenda" style={{ display: 'grid', gap: 6 }}>
        <h2 id="mv-agenda" style={heading}>Agenda <span style={count}>{rows.length} items · {room.itemMinutes} min each</span></h2>
        {rows.length === 0 && <div style={faint}>{before ? 'The agenda is set when the meeting starts: the open items, the agenda you wrote or the kind\'s standard items, then the proposals.' : 'No agenda items.'}</div>}
        <ol aria-label="Agenda items" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
          {rows.map((r) => {
            const s = AGENDA_STATE[r.state];
            const cur = r.state === 'current';
            return (
              <li key={r.index} data-testid="mv-item" data-state={r.state} aria-current={cur ? 'step' : undefined}
                style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr)', gap: 8, padding: '7px 8px', borderRadius: 8, background: cur ? 'var(--accent-dim)' : undefined, border: '1px solid', borderColor: cur ? 'var(--accent)' : 'transparent' }}>
                <span aria-hidden style={{ ...mono, fontSize: 12, color: s.color, textAlign: 'center', lineHeight: '18px' }}>{s.mark}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="mv-clamp2" title={r.text} style={{ fontSize: 13, lineHeight: 1.35, fontWeight: cur ? 650 : 450, color: r.state === 'upcoming' || cur ? 'var(--text)' : 'var(--text-dim)', textDecoration: r.state === 'skipped' ? 'line-through' : undefined }}>
                    <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)', marginRight: 6 }}>{r.index + 1}</span>{r.text}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: 'var(--text-faint)' }}>
                    <span style={{ color: s.color }}>{s.label}{r.how === 'time' ? ' · time ran out' : ''}</span>
                    <span style={{ marginLeft: 'auto', ...mono }}>
                      {cur ? `${mmss(r.minutes ?? 0)} / ${room.itemMinutes}:00` : r.minutes !== null ? `${mmss(r.minutes)}` : r.state === 'unreached' ? '' : `${room.itemMinutes} min`}
                    </span>
                  </span>
                  {cur && <span style={{ display: 'block', marginTop: 5 }}><Meter value={r.minutes ?? 0} max={room.itemMinutes} width="100%" label={`Time box of item ${r.index + 1}`} /></span>}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      {room.openItems.length > 0 && (
        <section aria-labelledby="mv-open" style={{ display: 'grid', gap: 6 }}>
          <h2 id="mv-open" style={heading}>From the last meeting <span style={count}>{open} open of {room.openItems.length}</span></h2>
          {room.openItems.map((i, k) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: OPEN_STATE[i.state], border: `1px solid ${OPEN_STATE[i.state]}`, borderRadius: 999, padding: '0 6px' }}>{i.state}</span>
              <span style={{ minWidth: 0 }}>
                <span className="mv-clamp2" title={i.title}>{i.title}</span>
                <span style={faint}>{i.owner || 'unowned'}{i.due ? ` · due ${i.due.slice(0, 10)}` : ''}{i.taskId ? ' · ' : ''}</span>
                {i.taskId && <button onClick={() => app.openOrgTask(i.taskId!)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, padding: 0, cursor: 'pointer' }}>task</button>}
              </span>
            </div>
          ))}
        </section>
      )}

      {room.preRead && (
        <section aria-labelledby="mv-pre" style={{ display: 'grid', gap: 6 }}>
          <h2 id="mv-pre" style={heading}>
            Pre-read
            <button onClick={() => setPre(!pre)} aria-expanded={pre} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, cursor: 'pointer', padding: 0 }}>{pre ? 'Hide' : 'Show'}</button>
          </h2>
          {pre ? <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}><Markdown text={room.preRead} refs={noRefs} compact /></div> : <div style={faint}>Compiled from the record before the meeting: check-ins, at-risk goals, what moved and what is blocked.</div>}
        </section>
      )}

      <section aria-labelledby="mv-props" style={{ display: 'grid', gap: 6 }}>
        <h2 id="mv-props" style={heading}>Agenda proposals <span style={count}>{room.proposals.length}</span></h2>
        {room.proposals.length === 0 && !before && <div style={faint}>Nobody proposed an item.</div>}
        {room.proposals.map((p, i) => (
          <div key={i} style={{ fontSize: 12.5, lineHeight: 1.4 }}>
            <div>{p.text}</div>
            <div style={faint}>{p.byKind === 'agent' ? (app.agents.find((a) => a.id === p.by)?.name ?? 'an attendee') : app.nameOf(p.by)}{p.why ? ` — ${p.why}` : ''}</div>
          </div>
        ))}
        {before ? (
          <form style={{ display: 'grid', gap: 6 }} onSubmit={(e) => { e.preventDefault(); void propose(); }}>
            <input aria-label="Propose an agenda item" value={proposal} onChange={(e) => setProposal(e.target.value)} placeholder="Propose an agenda item" style={fieldStyle} />
            <input aria-label="Why" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it belongs here (optional)" style={fieldStyle} />
            <button type="submit" style={{ ...smallBtn, justifySelf: 'start' }} disabled={busy || !proposal.trim()}>Propose</button>
          </form>
        ) : room.proposals.length > 0 || m.status === 'running' ? <div style={faint}>Proposals closed when the meeting started.</div> : null}
      </section>
    </>
  );
}
const fieldStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12.5 };

// ---- center: transcript or summary ----

function CenterPane({ wsId, m, stream, msgs, live, typing, me, nameOf, members, view, setView, onChanged }: {
  wsId: string; m: OrgMeeting; stream: MeetingStream | null; msgs: ChannelMessage[]; live: LiveReply[];
  typing: Record<string, { agentId: string; threadRootId: string | null; replyRootId?: string }>; me: string;
  nameOf: (kind: 'agent' | 'human' | 'system', id: string) => string; members: ChannelMember[];
  view: Center; setView: (v: Center) => void; onChanged: (m: OrgMeeting) => void;
}) {
  const app = useApp();
  const room = parseRoom(m.room);
  const running = m.status === 'running';
  const before = m.status === 'scheduled' || m.status === 'postponed';
  const ended = m.status === 'done' || m.status === 'cancelled';
  const present = room.present.includes(me);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [busy, setBusy] = useState(false);
  const opener = stream?.openerId ?? null;
  const rootMsg = opener ? msgs.find((x) => x.id === opener) ?? null : null;
  const replies = useMemo(() => msgs.filter((x) => x.id !== opener), [msgs, opener]);
  const turns = useMemo(() => foldTurns(replies), [replies]);
  const thinking = Object.values(typing).filter((t) => !live.some((l) => l.agentId === t.agentId));
  useEffect(() => {
    if (!stick.current) return;
    requestAnimationFrame(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; });
  }, [msgs.length, live, thinking.length, view]);
  const join = async () => {
    setBusy(true);
    try { onChanged(await api.joinMeeting(wsId, m.id)); app.showToast('You are in the room: you are heard at the next turn'); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'could not join'); } finally { setBusy(false); }
  };
  const mentionables = members.map((x) => ({ kind: x.memberKind, id: x.memberId, name: x.name }));
  const minutes = parseMinutes(m.minutes);
  return (
    <section aria-label={view === 'summary' ? 'Summary' : 'Transcript'} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', borderBottom: '1px solid var(--border-soft, var(--border))', flex: 'none' }}>
        {ended ? (
          <div role="tablist" aria-label="Center view" style={{ display: 'flex', gap: 2, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 2 }}>
            {(['summary', 'transcript'] as Center[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} style={{ background: view === v ? 'var(--accent)' : 'none', color: view === v ? '#fff' : 'var(--text-dim)', border: 'none', borderRadius: 6, padding: '3px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{v === 'summary' ? 'Summary' : 'Transcript'}</button>
            ))}
          </div>
        ) : <h2 style={heading}>Transcript <span style={count}>{replies.length} messages</span></h2>}
        <span style={{ marginLeft: 'auto', ...faint }}>{running ? (present ? 'You are in the room' : 'Watching') : ended ? `${m.rounds} round${m.rounds === 1 ? '' : 's'}` : ''}</span>
      </div>

      {view === 'summary' ? <Summary wsId={wsId} m={m} nameOf={nameOf} /> : (
        <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} style={{ flex: 1, overflowY: 'auto', padding: '14px 0 10px', minHeight: 0 }}>
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 20px', display: 'grid', gap: 4 }}>
            {rootMsg && <RootLine msg={rootMsg} name={nameOf(rootMsg.authorKind, rootMsg.authorId)} />}
            {!rootMsg && before && <div style={{ ...faint, textAlign: 'center', padding: '40px 0' }}>The transcript starts when the meeting does. Until then, propose agenda items on the left.</div>}
            {turns.map((t) => <TurnBlock key={t.key} wsId={wsId} m={m} turn={t} me={me} name={nameOf(t.authorKind, t.authorId)} onChanged={onChanged} minutes={minutes} />)}
            {live.map((l) => (
              <article key={l.liveId} data-testid="mv-live" style={{ display: 'flex', gap: 11, padding: '9px 0' }}>
                <Chip kind="agent" agent={app.agents.find((a) => a.id === l.agentId)} name={nameOf('agent', l.agentId)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><b style={{ fontSize: 13 }}>{nameOf('agent', l.agentId)}</b><span style={{ fontSize: 11, color: 'var(--green)' }}>speaking…</span></div>
                  <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{l.text}<span style={{ animation: 'blink 1s infinite', color: 'var(--accent)' }}>▋</span></div>
                </div>
              </article>
            ))}
            {thinking.map((t) => (
              <div key={t.agentId} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', fontSize: 12, color: 'var(--text-dim)' }}>
                <Chip kind="agent" agent={app.agents.find((a) => a.id === t.agentId)} name={nameOf('agent', t.agentId)} size={22} />
                {nameOf('agent', t.agentId)} is preparing a turn
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'transcript' && (running || before) && (stream || !present) && (
        <div style={{ flex: 'none', borderTop: '1px solid var(--border)' }}>
          {!present && (
            <div data-testid="mv-join" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px', background: 'var(--panel)', fontSize: 12.5, color: 'var(--text-dim)' }}>
              <span style={{ flex: 1 }}>{before ? 'Join now and you are in the room when it starts.' : 'Join to speak: the next speaker hears you.'}</span>
              <button style={primaryBtn} disabled={busy} onClick={() => void join()}>Join</button>
            </div>
          )}
          {stream && <Composer wsId={wsId} slug={stream.slug} folder={stream.folder} mentionables={mentionables} threadRootId={stream.threadRootId} compact orgMode {...meetingComposerHint(m, me)} />}
        </div>
      )}
      {view === 'transcript' && ended && <div style={{ flex: 'none', borderTop: '1px solid var(--border)', padding: '10px 20px', ...faint, background: 'var(--panel)' }}>The meeting has ended; its messages stay in {stream ? `#${stream.slug}` : 'its channel'}.</div>}
    </section>
  );
}

/** The agenda root, folded to one line (the agenda is on the left). */
function RootLine({ msg, name }: { msg: ChannelMessage; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border-soft, var(--border))', borderRadius: 10, padding: '8px 12px', background: 'var(--panel)', marginBottom: 6 }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12, cursor: 'pointer', padding: 0, width: '100%', textAlign: 'left', display: 'flex', gap: 6 }}>
        <span>{open ? '▾' : '▸'}</span><span>{name} opened the meeting with the agenda</span>
      </button>
      {open && <div style={{ fontSize: 13, lineHeight: 1.55, marginTop: 6 }}><Markdown text={msg.text} refs={noRefs} compact /></div>}
    </div>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const isProposalText = (t: string) => /^(Decision proposed|Action proposed|Question for the CEO):/.test(t);

/** One attendee's turn: their consecutive messages, folded when long. */
function TurnBlock({ wsId, m, turn, me, name, onChanged, minutes }: { wsId: string; m: OrgMeeting; turn: Turn; me: string; name: string; onChanged: (m: OrgMeeting) => void; minutes: ReturnType<typeof parseMinutes> }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const first = turn.messages[0];
  if (turn.authorKind === 'system') {
    return (
      <div data-testid="mv-system" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 11.5, color: 'var(--text-dim)' }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-soft, var(--border))' }} />
        <span style={{ background: 'var(--panel-2)', border: '1px solid var(--border-soft, var(--border))', borderRadius: 20, padding: '3px 11px', maxWidth: '82%', textAlign: 'center' }}>{first.text}</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-soft, var(--border))' }} />
      </div>
    );
  }
  if (/"kind"\s*:\s*"minutes"/.test(first.attachments ?? '')) {
    return <div style={{ padding: '6px 0' }}><MinutesCard wsId={wsId} meetingId={m.id} fallback={first.text} refs={noRefs} onDecision={() => undefined} onTask={(id) => app.openOrgTask(id)} /></div>;
  }
  const agent = turn.authorKind === 'agent' ? app.agents.find((a) => a.id === turn.authorId) : undefined;
  const mine = turn.authorKind === 'human' && turn.authorId === me;
  const length = turn.messages.reduce((n, x) => n + x.text.length, 0);
  const foldable = length > 900;
  const facilitator = turn.authorKind === 'agent' && turn.authorId === m.facilitatorAgentId;
  return (
    <article data-testid="mv-turn" data-author={turn.authorKind} style={{ display: 'flex', gap: 11, padding: '9px 10px', margin: '0 -10px', borderRadius: 10, background: turn.authorKind === 'human' ? 'var(--panel)' : undefined, borderLeft: turn.authorKind === 'human' ? '3px solid var(--accent)' : '3px solid transparent' }}>
      <Chip kind={turn.authorKind} agent={agent} name={name} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13, color: mine ? 'var(--accent-hi)' : 'var(--text)' }}>{name}{mine ? ' (you)' : ''}</span>
          {facilitator && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>facilitator</span>}
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>{timeOf(first.createdAt)}</span>
          {turn.messages.length > 1 && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{turn.messages.length} messages</span>}
        </div>
        <div className={`mv-turn-body${foldable && !open ? ' folded' : ''}`} style={{ display: 'grid', gap: 6, marginTop: 2 }}>
          {turn.messages.map((x) => {
            const ref = turn.authorKind === 'agent' && isProposalText(x.text) ? proposalFor(x.id, minutes) : null;
            return (
              <div key={x.id} style={ref ? { border: '1px solid var(--border)', borderRadius: 9, padding: '7px 10px', background: 'var(--panel)' } : undefined}>
                <div style={{ fontSize: 14, lineHeight: 1.6 }}><Markdown text={x.text} refs={noRefs} compact /></div>
                {ref && <ProposalControls wsId={wsId} meeting={m} kind={ref.kind} index={ref.index} onChanged={onChanged} />}
              </div>
            );
          })}
        </div>
        {foldable && <button onClick={() => setOpen(!open)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 0 0' }}>{open ? 'Fold the turn' : 'Show the whole turn'}</button>}
      </div>
    </article>
  );
}

/** After the end: the minutes, the decisions taken, the action items and the cost. */
function Summary({ wsId, m, nameOf }: { wsId: string; m: OrgMeeting; nameOf: (kind: 'agent' | 'human' | 'system', id: string) => string }) {
  const app = useApp();
  const minutes = parseMinutes(m.minutes);
  const room = parseRoom(m.room);
  const board = proposedBoard(minutes, room);
  const decisions = board.filter((p) => p.kind === 'decision');
  const actions = board.filter((p) => p.kind === 'action');
  const questions = board.filter((p) => p.kind === 'question');
  const tokens = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  const took = m.startedAt && m.endedAt ? Math.max(0, Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 60_000)) : null;
  const how = minutes.endedBy === 'stopped' ? 'stopped in the thread' : minutes.endedBy === 'usd_cap' ? 'stopped at the USD cap' : minutes.endedBy === 'ended' ? 'ended by a person' : m.status === 'cancelled' ? 'cancelled' : 'closed by the facilitator';
  const openMinutes = () => { if (!m.minutesPath) return; closeMeetingView(); app.openFile({ kind: 'workspace', id: wsId }, m.minutesPath); };
  const openDecision = (id: string) => { closeMeetingView(); app.setOrgFocus({ kind: 'decision', id }); app.setOrgUnitId(null); app.setOrgPane('decisions'); app.setMobileDetail(true); };
  const rowStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'start', padding: '9px 0', borderTop: '1px solid var(--border-soft, var(--border))' };
  return (
    <div data-testid="mv-summary" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 20px 32px', display: 'grid', gap: 22 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ ...faint, fontSize: 12.5 }}>
            {how} · {m.rounds} round{m.rounds === 1 ? '' : 's'}{took !== null ? ` · ${took} min` : ''} · <span data-testid="mv-summary-cost">{tokensText(tokens)} tokens · {fmtUsd(m.usd)}</span>
          </div>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, maxWidth: '68ch', whiteSpace: 'pre-wrap' }}>{minutes.summary || m.summary || 'No summary was written.'}</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {m.minutesPath ? <button style={primaryBtn} onClick={openMinutes} title={`Open /${m.minutesPath}`}>Open the minutes</button> : <span style={faint}>The minutes file is written when the meeting closes.</span>}
            {m.minutesPath && <span style={{ ...faint, ...mono, alignSelf: 'center' }}>/{m.minutesPath}</span>}
          </div>
        </div>

        <section aria-labelledby="mv-s-dec">
          <h2 id="mv-s-dec" style={{ ...heading, fontSize: 14, marginBottom: 4 }}>Decisions <span style={count}>{decisions.filter((d) => d.verdict !== 'rejected').length} taken</span></h2>
          {decisions.length === 0 && <div style={faint}>No decision was proposed.</div>}
          {decisions.map((d) => (
            <div key={d.index} data-testid="mv-decision" style={{ ...rowStyle, opacity: d.verdict === 'rejected' ? 0.6 : 1 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: d.verdict === 'rejected' ? 'line-through' : undefined }}>{d.title}</div>
                {d.detail && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{d.detail}</div>}
                <div style={{ ...faint, marginTop: 2 }}>proposed by {nameOf('agent', d.by)}{d.verdict ? ` · ${d.verdict} by ${d.verdictBy ?? 'a person'}` : ''}</div>
              </div>
              {d.decisionId ? <button onClick={() => openDecision(d.decisionId!)} style={{ ...smallBtn, ...mono, fontSize: 11 }} title="Open in the decision log">#decision:{d.decisionId.slice(0, 8)}</button> : <span style={faint}>{d.verdict === 'rejected' ? 'not logged' : ''}</span>}
            </div>
          ))}
        </section>

        <section aria-labelledby="mv-s-act">
          <h2 id="mv-s-act" style={{ ...heading, fontSize: 14, marginBottom: 4 }}>Action items <span style={count}>{actions.filter((a) => a.verdict !== 'rejected').length}</span></h2>
          {actions.length === 0 && <div style={faint}>No action was proposed.</div>}
          {actions.map((a) => (
            <div key={a.index} data-testid="mv-action" style={{ ...rowStyle, opacity: a.verdict === 'rejected' ? 0.6 : 1 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, textDecoration: a.verdict === 'rejected' ? 'line-through' : undefined }}>{a.title}</div>
                <div style={{ ...faint, marginTop: 2 }}>{[a.detail, a.due ? `due ${a.due.slice(0, 10)}` : '', a.verdict === 'rejected' ? `rejected by ${a.verdictBy ?? 'a person'}` : ''].filter(Boolean).join(' · ')}</div>
              </div>
              {a.taskId ? <button onClick={() => app.openOrgTask(a.taskId!)} style={{ ...smallBtn, ...mono, fontSize: 11 }} title="Open on the board">{a.taskKey ?? a.taskId.slice(0, 8)}</button> : <span style={faint}>{a.verdict === 'rejected' ? 'no task' : ''}</span>}
            </div>
          ))}
        </section>

        {questions.length > 0 && (
          <section aria-labelledby="mv-s-q">
            <h2 id="mv-s-q" style={{ ...heading, fontSize: 14, marginBottom: 4 }}>Questions for the CEO <span style={count}>{questions.length}</span></h2>
            {questions.map((q) => (
              <div key={q.index} style={rowStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5 }}>{q.title}</div>
                  <div style={{ ...faint, marginTop: 2 }}>{q.answer ? `Answered by ${q.verdictBy ?? 'a person'}: ${q.answer}` : 'Goes to the next brief'}</div>
                </div>
                <span />
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

// ---- right: stats, controls, the floor, attendees, proposals, parking lot ----

function RoomPanel({ wsId, m, strip, live, me, nameOf, onChanged }: {
  wsId: string; m: OrgMeeting; strip: ReturnType<typeof seats>; live: LiveReply[]; me: string;
  nameOf: (kind: 'agent' | 'human' | 'system', id: string) => string; onChanged: (m: OrgMeeting) => void;
}) {
  const app = useApp();
  const room = parseRoom(m.room);
  const minutes = parseMinutes(m.minutes);
  const standing = useRoomStanding(wsId, m.createdBy, me);
  const [busy, setBusy] = useState(false);
  const running = m.status === 'running';
  const ended = m.status === 'done' || m.status === 'cancelled';
  const box = room.items.length * room.itemMinutes;
  const [now, setNow] = useState(() => Date.now());
  // Only a meeting still ahead or running needs a ticking clock; an ended one is a record.
  useEffect(() => { if (ended) return; const t = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(t); }, [ended]);
  const elapsedMin = m.startedAt ? Math.max(0, ((m.endedAt ? Date.parse(m.endedAt) : now) - Date.parse(m.startedAt)) / 60_000) : 0;
  const tokens = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  const itemMin = running ? minutesSince(room.itemStartedAt) : 0;
  const rows = agendaRows(room, m.status, minutes);
  const covered = rows.filter((r) => r.state === 'done').length;
  const skipped = rows.filter((r) => r.state === 'skipped').length;
  const unreached = rows.filter((r) => r.state === 'unreached').length;
  const endedHow = minutes.endedBy === 'stopped' ? 'stopped in the thread' : minutes.endedBy === 'usd_cap' ? 'stopped at the USD cap' : minutes.endedBy === 'ended' ? 'ended by a person' : m.status === 'cancelled' ? 'cancelled' : 'closed by the facilitator';
  /** An ended meeting's seats read as a record: who attended, who joined. */
  const seatLabel = (s: ReturnType<typeof seats>[number]): { label: string; color: string } => {
    if (!ended) return { label: s.state === 'speaking' ? 'speaking now' : SEAT[s.state].label, color: s.state === 'idle' || s.state === 'away' ? 'var(--text-faint)' : SEAT[s.state].color };
    if (s.kind === 'human') return s.state === 'present' ? { label: 'joined', color: 'var(--text-dim)' } : { label: 'did not join', color: 'var(--text-faint)' };
    return { label: 'attended', color: 'var(--text-dim)' };
  };
  const control = async (action: 'extend' | 'skip' | 'end', done: string) => {
    if (action === 'end' && !confirm('End the meeting after the current turn? The facilitator closes it and writes the minutes.')) return;
    setBusy(true);
    try { onChanged(await api.controlMeeting(wsId, m.id, action)); app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  const speaker = room.speaking ? strip.find((s) => s.kind === 'agent' && s.id === room.speaking) : null;
  const speakerLive = speaker ? live.find((l) => l.agentId === speaker.id) : null;
  const agents = strip.filter((s) => s.kind === 'agent');
  const people = strip.filter((s) => s.kind === 'human');
  const board = proposedBoard(minutes, room);
  const parked = minutes.parked ?? [];
  const stat = (label: string, value: React.ReactNode, testid?: string) => (
    <div data-testid={testid} style={{ display: 'grid', gap: 1 }}>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ ...mono, fontSize: 14, fontWeight: 600 }}>{value}</span>
    </div>
  );
  return (
    <>
      <section aria-label="Stats" data-testid="mv-stats" style={{ display: 'grid', gap: 10, paddingBottom: 14, borderBottom: '1px solid var(--border-soft, var(--border))' }}>
        {ended ? (
          <div data-testid="mv-ended" style={{ display: 'grid', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span data-testid="mv-elapsed" style={{ ...mono, fontSize: 30, fontWeight: 600, letterSpacing: '-1px', lineHeight: 1 }}>{m.startedAt && m.endedAt ? `${Math.max(0, Math.round(elapsedMin))} min` : '—'}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{m.status === 'cancelled' ? 'Cancelled' : 'Ended'}{m.endedAt ? ` ${new Date(m.endedAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
            </div>
            <div style={faint}>{endedHow}{box ? ` · time box ~${box} min` : ''}</div>
          </div>
        ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          {m.startedAt || !m.scheduledFor
            ? <><span data-testid="mv-elapsed" style={{ ...mono, fontSize: 30, fontWeight: 600, letterSpacing: '-1px', lineHeight: 1 }}>{m.startedAt ? mmss(elapsedMin) : '0:00'}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{box ? `of ~${box} min` : 'elapsed'}</span></>
            : <><span data-testid="mv-elapsed" style={{ ...mono, fontSize: 30, fontWeight: 600, letterSpacing: '-1px', lineHeight: 1 }}>{new Date(m.scheduledFor).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>starts in {Math.max(0, Math.round((Date.parse(m.scheduledFor) - now) / 60_000))} min</span></>}
        </div>
        )}
        {box > 0 && !ended && <Meter value={elapsedMin} max={box} width="100%" height={5} label="Elapsed against the whole time box" />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '10px 8px' }}>
          {stat('Round', room.roundCap ? `${Math.max(1, room.round)}/${room.roundCap}` : '—', 'mv-round')}
          {ended
            ? stat('Covered', rows.length ? `${covered}/${rows.length}` : '—', 'mv-covered')
            : stat('This item', running && room.current < room.items.length ? `${itemMin}/${room.itemMinutes}m` : '—')}
          {ended ? stat('Skipped', skipped + unreached, 'mv-skipped') : stat('Skips', room.controls.skip)}
          {stat('Tokens', tokensText(tokens), 'mv-tokens')}
          {stat('Spend', fmtUsd(m.usd), 'mv-usd')}
          {stat('Extended', room.extended)}
        </div>
        {running && standing.steer && (
          <div role="group" aria-label="Controls" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
            <button style={smallBtn} disabled={busy || m.kind === 'standup'} title={m.kind === 'standup' ? 'A standup is one round' : 'One more round, within the caps'} onClick={() => void control('extend', 'One more round')}>Extend</button>
            <button style={smallBtn} disabled={busy || room.current >= room.items.length} title="Move to the next agenda item" onClick={() => void control('skip', 'Item skipped')}>Skip item</button>
            <button style={{ ...smallBtn, color: 'var(--red)', borderColor: 'var(--red)' }} disabled={busy || Boolean(room.controls.end)} title="End after the current turn; the facilitator closes it" onClick={() => void control('end', 'Ending the meeting')}>{room.controls.end ? 'Ending…' : 'End'}</button>
          </div>
        )}
        {running && !standing.steer && <div style={faint}>You are watching. The CEO or the person who started the meeting steers it.</div>}
      </section>

      {running && (
        <section aria-label="On the floor" data-testid="mv-floor" style={{ display: 'grid', gap: 8 }}>
          <h2 style={heading}>On the floor</h2>
          {speaker ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--green)', background: 'var(--panel-2)' }}>
              <SeatAvatar seat={speaker} size={30} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 650 }}>{speaker.name}{speaker.facilitator ? ' · facilitator' : ''}</div>
                <div className="mv-clamp2" style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{speakerLive?.text ? speakerLive.text.slice(-200) : 'is preparing a turn'}</div>
              </div>
            </div>
          ) : <div style={faint}>Between turns.</div>}
        </section>
      )}

      <section aria-label="Attendees" style={{ display: 'grid', gap: 6 }}>
        <h2 style={heading}>Attendees <span style={count}>{agents.length} agents · {people.filter((p) => p.state === 'present').length}/{people.length} people {ended ? 'joined' : 'here'}</span></h2>
        {[...agents, ...people].map((s) => (
          <div key={`${s.kind}:${s.id}`} data-testid="mv-seat" data-state={s.state} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '3px 0', minWidth: 0 }}>
            <SeatAvatar seat={s} size={24} as={ended ? seatLabel(s) : undefined} />
            <span style={{ fontSize: 13, minWidth: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}{s.facilitator ? ' ★' : ''}{s.kind === 'human' && s.id === me ? ' (you)' : ''}</span>
            <span style={{ fontSize: 11.5, color: seatLabel(s).color, flex: 'none' }}>{seatLabel(s).label}</span>
          </div>
        ))}
      </section>

      <section aria-label="Proposed" data-testid="mv-proposed" style={{ display: 'grid', gap: 8 }}>
        <h2 style={heading}>Proposed <span style={count}>{board.length}</span></h2>
        {board.length === 0 && <div style={faint}>{ended ? 'Nothing was proposed.' : 'Decisions, actions, risks and questions for the CEO land here as attendees propose them.'}</div>}
        {board.map((p) => <ProposedCard key={`${p.kind}:${p.index}`} wsId={wsId} m={m} p={p} by={nameOf('agent', p.by)} onChanged={onChanged} />)}
      </section>

      <section aria-label="Parking lot" style={{ display: 'grid', gap: 6 }}>
        <h2 style={heading}>Parking lot <span style={count}>{parked.length}</span></h2>
        {parked.length === 0 && <div style={faint}>Nothing parked. Parked points become backlog tasks when the minutes are executed.</div>}
        {parked.map((p, i) => (
          <div key={i} style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span aria-hidden style={{ color: 'var(--amber)' }}>∥</span>
            <span style={{ flex: 1, minWidth: 0 }}>{p.text}</span>
            {p.taskId && <button onClick={() => app.openOrgTask(p.taskId!)} style={{ ...smallBtn, ...mono, fontSize: 10.5, padding: '1px 6px' }}>{p.taskKey ?? 'task'}</button>}
          </div>
        ))}
      </section>
    </>
  );
}

const KIND: Record<Proposed['kind'], { label: string; color: string }> = {
  decision: { label: 'Decision', color: 'var(--accent)' },
  action: { label: 'Action', color: 'var(--green)' },
  risk: { label: 'Risk', color: 'var(--amber)' },
  question: { label: 'Question', color: 'var(--blue)' },
};

function ProposedCard({ wsId, m, p, by, onChanged }: { wsId: string; m: OrgMeeting; p: Proposed; by: string; onChanged: (m: OrgMeeting) => void }) {
  const k = KIND[p.kind];
  return (
    <div data-testid="mv-proposal" data-kind={p.kind} style={{ borderRadius: 9, border: '1px solid var(--border)', borderLeft: `3px solid ${k.color}`, padding: '8px 10px', background: 'var(--panel-2)', opacity: p.verdict === 'rejected' ? 0.65 : 1 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 650, color: k.color }}>{k.label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 'auto' }}>{by}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 550, marginTop: 2, lineHeight: 1.4 }}>{p.title}</div>
      {p.detail && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.4 }}>{p.detail}</div>}
      {p.kind !== 'risk' && <ProposalControls wsId={wsId} meeting={m} kind={p.kind} index={p.index} onChanged={onChanged} compact />}
    </div>
  );
}
