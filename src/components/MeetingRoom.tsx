/** The meeting room (docs/meetings.md "During"): the header a meeting thread
 *  shows in ChannelView's thread panel (full width on a phone). It is one
 *  compact line — the title, the current agenda item ("2/6 · Pricing"),
 *  round N/M, the item's time box, tokens and USD, the attendee avatars
 *  with their speaking state, Join, the controls (Extend / Skip item / End
 *  for the CEO or the starter) and Expand, which opens the full-screen room
 *  (MeetingView). Everything longer — the whole agenda, the pre-read, the
 *  open items from the last meeting, the agenda proposals and the box to
 *  add one — sits in a drawer under it, collapsed by default and
 *  remembered per viewer, so the messages keep the height.
 *  `ProposalActions` is the inline Approve / Reject under a proposed
 *  decision or action and the Answer box under a question for the CEO; the
 *  speaker's reply itself streams in the thread (channel_stream with the
 *  thread as replyRootId), drawn by ChannelView. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, grad } from '../store';
import { api, type OrgMeeting } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import { MEETING_KIND_TITLES, parseMinutes } from '../lib/org';
import { initials } from '../lib/channels';
import {
  agendaRows, minutesSince, openMeetingView, parseRoom, proposalFor, readDrawer, saveDrawer, seats, tokensText, useRoomStanding,
  type Seat,
} from '../lib/meetings';
import { AGENDA_STATE, OPEN_STATE, SEAT, primaryBtn, smallBtn, statusColor } from './meeting-ui';

const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 8px', fontSize: 11, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)', whiteSpace: 'nowrap' };
const iconBtn: React.CSSProperties = { ...smallBtn, padding: '3px 6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 26, color: 'var(--text-dim)' };
const mono: React.CSSProperties = { fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' };

/** One attendee as a small round avatar ringed by their state (speaking pulses). */
/** `as` overrides the state's label and ring (an ended meeting's seats read as a record). */
export function SeatAvatar({ seat, size = 22, as }: { seat: Seat; size?: number; as?: { label: string; color: string } }) {
  const app = useApp();
  const agent = seat.kind === 'agent' ? app.agents.find((a) => a.id === seat.id) : undefined;
  const s = as ?? SEAT[seat.state];
  const dim = as ? false : seat.state === 'idle' || seat.state === 'away' || seat.state === 'passed';
  return (
    <span data-testid="seat" data-state={seat.state} title={`${seat.name}${seat.facilitator ? ' (facilitator)' : ''}: ${s.label}`}
      style={{ position: 'relative', width: size, height: size, flex: 'none', borderRadius: '50%', boxShadow: `0 0 0 2px var(--panel), 0 0 0 ${seat.state === 'speaking' ? 3.5 : 3}px ${s.color}`, background: seat.kind === 'agent' ? (agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))') : 'var(--accent-dim)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: seat.kind === 'agent' ? size * 0.52 : size * 0.4, fontWeight: 700, color: 'var(--text)', opacity: dim ? 0.55 : 1, animation: seat.state === 'speaking' ? 'pulse 1.4s infinite' : undefined }}>
      <span aria-hidden>{seat.kind === 'agent' ? (agent?.emoji ?? '🤖') : initials(seat.name)}</span>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{seat.name}{seat.facilitator ? ' ★' : ''} {s.label}</span>
    </span>
  );
}

/** A thin progress bar: `value` of `max`, amber near the end, red past it. */
export function Meter({ value, max, width = 44, height = 4, label }: { value: number; max: number; width?: number | string; height?: number; label?: string }) {
  const r = max > 0 ? value / max : 0;
  const color = r >= 1 ? 'var(--red)' : r >= 0.8 ? 'var(--amber)' : 'var(--accent)';
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(value * 10) / 10} style={{ display: 'inline-block', width, height, borderRadius: height, background: 'var(--border-soft, var(--border))', overflow: 'hidden', flex: 'none', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.min(100, r * 100)}%`, background: color, borderRadius: height, transition: 'width .4s ease' }} />
    </span>
  );
}

const roomCss = `
.mr-room{container-type:inline-size}
.mr-line{display:flex;align-items:center;gap:7px;min-width:0;height:30px}
.mr-title{font-weight:700;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:64px;max-width:34%;flex:0 1 auto}
.mr-item{min-width:44px;flex:1 1 auto;display:flex;align-items:center;gap:5px;overflow:hidden;cursor:pointer;font:inherit;font-size:11.5px;text-align:left}
.mr-item-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.mr-seats{display:flex;align-items:center;gap:6px;padding:0 4px;flex:none}
.mr-btns{display:flex;gap:4px;margin-left:auto;flex:none;align-items:center;position:relative}
.mr-clamp{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mr-more-s,.mr-more-m{display:none}
@container (max-width: 600px){.mr-cost{display:none!important}.mr-seat-m{display:none!important}.mr-more-l{display:none}.mr-more-m{display:inline}}
@container (max-width: 470px){.mr-box{display:none!important}.mr-seat-s{display:none!important}.mr-more-m{display:none}.mr-more-s{display:inline}}
@container (max-width: 400px){.mr-round{display:none!important}}
`;

export function MeetingRoom({ wsId, meeting: m, me, name, onChanged }: {
  wsId: string; meeting: OrgMeeting; me: string;
  name: (kind: 'agent' | 'human', id: string) => string;
  onChanged: (m: OrgMeeting) => void;
}) {
  const app = useApp();
  const room = useMemo(() => parseRoom(m.room), [m.room]);
  const minutes = useMemo(() => parseMinutes(m.minutes), [m.minutes]);
  const attendees = useMemo(() => { try { return JSON.parse(m.attendees || '[]') as Array<{ kind: 'agent' | 'human'; id: string }>; } catch { return []; } }, [m.attendees]);
  const standing = useRoomStanding(wsId, m.createdBy, me);
  const [, setTick] = useState(0);
  const [proposal, setProposal] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPre, setShowPre] = useState(false);
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawerState] = useState(() => readDrawer(me));
  const setDrawer = (open: boolean) => { setDrawerState(open); saveDrawer(me, open); };
  const menuRef = useRef<HTMLSpanElement>(null);
  const running = m.status === 'running';
  const before = m.status === 'scheduled' || m.status === 'postponed';
  useEffect(() => { if (!running) return; const t = setInterval(() => setTick((n) => n + 1), 15_000); return () => clearInterval(t); }, [running]);
  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [menu]);
  const act = async (fn: () => Promise<OrgMeeting>, done?: string) => {
    setBusy(true); setMenu(false);
    try { onChanged(await fn()); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  const strip = seats(room, attendees, m.facilitatorAgentId, name);
  const rows = agendaRows(room, m.status, minutes);
  const present = room.present.includes(me);
  const itemElapsed = minutesSince(room.itemStartedAt);
  const elapsed = minutesSince(m.startedAt);
  const box = room.items.length * room.itemMinutes;
  const tokens = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  const color = statusColor(m.status);
  const current = running && room.current < room.items.length ? room.items[room.current] : null;
  // The one speaking first: it is the avatar that stays at phone width.
  const shownSeats = [...strip].sort((a, b) => (b.state === 'speaking' ? 1 : 0) - (a.state === 'speaking' ? 1 : 0)).slice(0, 6);
  const openCount = room.openItems.filter((i) => i.state !== 'done' && i.state !== 'dropped').length;
  const title = m.title || MEETING_KIND_TITLES[m.kind];
  return (
    <section aria-label="Meeting room" data-testid="meeting-room" className="mr-room" style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)', minWidth: 0, flex: 'none', position: 'sticky', top: 0, zIndex: 2 }}>
      <style>{roomCss}</style>
      <div className="mr-line" style={{ padding: '5px 10px 5px 12px', boxSizing: 'content-box' }}>
        <span title={m.status} style={{ width: 8, height: 8, borderRadius: '50%', background: color, animation: running ? 'pulse 1.2s infinite' : undefined, flex: 'none' }} />
        <span className="mr-title" title={title}>{title}</span>
        <button type="button" data-testid="room-item" className="mr-item" aria-label={drawer ? 'Hide the agenda' : 'Show the agenda'} aria-expanded={drawer} aria-controls={`mr-drawer-${m.id}`}
          title={current !== null ? `Item ${room.current + 1} of ${room.items.length}: ${current}` : 'Agenda, pre-read and open items'} onClick={() => setDrawer(!drawer)}
          style={{ ...chip, borderColor: drawer ? 'var(--accent)' : 'var(--accent-dim)', background: drawer ? 'var(--accent-dim)' : 'var(--panel-2)' }}>
          {current !== null
            ? <><span style={{ ...mono, color: 'var(--accent-hi)', flex: 'none' }}>{room.current + 1}/{room.items.length}</span><span className="mr-item-text">· {current}</span></>
            : <span className="mr-item-text" style={{ color: running ? 'var(--text)' : color }}>{running ? 'Closing' : m.status === 'done' ? 'Ended' : before ? 'Agenda' : m.status}{rows.length && !running ? ` · ${rows.length} items` : ''}</span>}
          <span aria-hidden style={{ flex: 'none', color: 'var(--text-faint)', display: 'inline-block', transform: drawer ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}>▾</span>
        </button>
        {(running || m.status === 'done') && room.roundCap > 0 && <span data-testid="room-round" className="mr-round" title={`Round ${Math.max(1, room.round)} of ${room.roundCap}`} style={{ ...mono, fontSize: 11, color: 'var(--text-dim)', flex: 'none' }}>R{Math.max(1, room.round)}/{room.roundCap}</span>}
        {current !== null && (
          <span className="mr-box" title={`This item: ${itemElapsed} of ${room.itemMinutes} min`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none' }}>
            <Meter value={itemElapsed} max={room.itemMinutes} width={34} label="Time box of the current item" />
            <span style={{ ...mono, fontSize: 10.5, color: itemElapsed >= room.itemMinutes ? 'var(--red)' : 'var(--text-faint)' }}>{itemElapsed}/{room.itemMinutes}m</span>
          </span>
        )}
        {(running || m.status === 'done') && <span data-testid="room-cost" className="mr-cost" title={`${tokens.toLocaleString()} tokens · ${fmtUsd(m.usd)}`} style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', flex: 'none' }}>{tokensText(tokens)} · {fmtUsd(m.usd)}</span>}
        {strip.length > 0 && (
          <span aria-label="Attendees" className="mr-seats">
            {shownSeats.map((s, i) => <span key={`${s.kind}:${s.id}`} className={i >= 3 ? 'mr-seat-m' : i >= 1 ? 'mr-seat-s' : undefined} style={{ display: 'inline-flex' }}><SeatAvatar seat={s} size={20} /></span>)}
            {strip.length > shownSeats.length && <span className="mr-more-l" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>+{strip.length - shownSeats.length}</span>}
            {strip.length > 3 && <span className="mr-more-m" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>+{strip.length - 3}</span>}
            {strip.length > 1 && <span className="mr-more-s" style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>+{strip.length - 1}</span>}
          </span>
        )}
        <span className="mr-btns" ref={menuRef}>
          {(running || before) && !present && <button style={primaryBtn} disabled={busy} title="Be in the room: you are heard at the next turn" onClick={() => void act(() => api.joinMeeting(wsId, m.id), 'You are in the room: you are heard at the next turn')}>Join</button>}
          {running && standing.steer && <button style={iconBtn} aria-label="Meeting controls" aria-expanded={menu} title="Extend, skip the item, end" onClick={() => setMenu(!menu)}>⋯</button>}
          {menu && running && (
            <span role="menu" style={{ position: 'absolute', right: 0, top: 30, zIndex: 5, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 10, padding: 4, display: 'grid', gap: 2, minWidth: 170, boxShadow: 'var(--shadow)' }}>
              <button role="menuitem" style={{ ...smallBtn, border: 'none', background: 'none', textAlign: 'left' }} disabled={busy || m.kind === 'standup'} title="One more round, within the caps" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'extend'), 'One more round')}>Extend</button>
              <button role="menuitem" style={{ ...smallBtn, border: 'none', background: 'none', textAlign: 'left' }} disabled={busy || room.current >= room.items.length} title="Move to the next agenda item" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'skip'), 'Item skipped')}>Skip item</button>
              <button role="menuitem" style={{ ...smallBtn, border: 'none', background: 'none', textAlign: 'left', color: 'var(--red)' }} disabled={busy || Boolean(room.controls.end)} title="End after the current turn; the facilitator closes it" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'end'), 'Ending the meeting')}>{room.controls.end ? 'Ending…' : 'End'}</button>
            </span>
          )}
          <button style={iconBtn} aria-label="Expand the meeting" title="Open the full-screen room" onClick={() => openMeetingView(wsId, m.id)}>⤢</button>
        </span>
      </div>

      {drawer && (
        <div id={`mr-drawer-${m.id}`} data-testid="room-drawer" style={{ maxHeight: '42vh', overflowY: 'auto', borderTop: '1px solid var(--border-soft, var(--border))', padding: '8px 12px 10px', display: 'grid', gap: 8 }}>
          {(running || m.status === 'done') && room.roundCap > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-dim)' }}>
              <span>Round {Math.max(1, room.round)} of {room.roundCap}</span>
              {current !== null && <span>Item {room.current + 1} of {room.items.length} · {itemElapsed} / {room.itemMinutes} min</span>}
              {m.startedAt && <span>{elapsed} min elapsed{box ? ` of ~${box}` : ''}</span>}
              <span>{tokensText(tokens)} tokens · {fmtUsd(m.usd)}</span>
            </div>
          )}
          {rows.length > 0 && (
            <ol aria-label="Agenda items" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 1, fontSize: 12 }}>
              {rows.map((r) => {
                const s = AGENDA_STATE[r.state];
                return (
                  <li key={r.index} data-state={r.state} aria-current={r.state === 'current' ? 'step' : undefined} title={r.text} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, color: r.state === 'current' ? 'var(--text)' : r.state === 'upcoming' ? 'var(--text-dim)' : 'var(--text-faint)', fontWeight: r.state === 'current' ? 650 : 400 }}>
                    <span aria-hidden style={{ ...mono, width: 14, textAlign: 'center', color: s.color, fontSize: 11 }}>{s.mark}</span>
                    <span style={{ ...mono, fontSize: 10.5, color: 'var(--text-faint)', width: 14 }}>{r.index + 1}</span>
                    <span className="mr-clamp" style={{ flex: 1, textDecoration: r.state === 'skipped' ? 'line-through' : undefined }}>{r.text}</span>
                    {r.state !== 'upcoming' && <span style={{ fontSize: 10.5, color: s.color, flex: 'none' }}>{s.label}</span>}
                  </li>
                );
              })}
            </ol>
          )}
          {strip.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {strip.map((s) => (
                <span key={`${s.kind}:${s.id}`} style={{ ...chip, borderColor: SEAT[s.state].color, opacity: s.state === 'idle' || s.state === 'away' ? 0.65 : 1 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEAT[s.state].color }} />
                  {s.name}{s.facilitator ? ' ★' : ''}{s.kind === 'human' && s.id === me ? ' (you)' : ''}
                  <span style={{ color: 'var(--text-faint)' }}>{SEAT[s.state].label}</span>
                </span>
              ))}
            </div>
          )}
          {room.openItems.length > 0 && (
            <details>
              <summary style={{ fontSize: 11.5, color: 'var(--text-dim)', cursor: 'pointer' }}>Open items from the last meeting ({openCount} open)</summary>
              <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
                {room.openItems.map((i, k) => (
                  <div key={k} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                    <span style={{ ...chip, padding: '0 6px', borderColor: OPEN_STATE[i.state], color: OPEN_STATE[i.state] }}>{i.state}</span>
                    <span className="mr-clamp" title={`${i.title} — ${i.owner || 'unowned'}`}>{i.title} — {i.owner || 'unowned'}{i.due ? ` · due ${i.due.slice(0, 10)}` : ''}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {room.preRead && (
            <div>
              <button style={{ ...smallBtn, padding: '2px 8px' }} onClick={() => setShowPre(!showPre)} aria-expanded={showPre}>{showPre ? 'Hide' : 'Show'} the pre-read</button>
              {showPre && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0 0', fontFamily: 'inherit', color: 'var(--text-dim)' }}>{room.preRead}</pre>}
            </div>
          )}
          {room.agendaPath && <button style={{ ...smallBtn, justifySelf: 'start' }} title={`Open /${room.agendaPath}`} onClick={() => app.openFile({ kind: 'workspace', id: wsId }, room.agendaPath!)}>Open the agenda file</button>}
          {before && (
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{m.scheduledFor ? `Starts ${new Date(m.scheduledFor).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not started yet'} · agenda proposals are open until it starts</div>
              {room.proposals.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{room.proposals.map((p, i) => <li key={i}>{p.text}{p.why ? <span style={{ color: 'var(--text-faint)' }}> — {p.why}</span> : null}</li>)}</ul>}
              <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); const t = proposal.trim(); if (!t) return; void act(() => api.proposeMeetingAgenda(wsId, m.id, t), 'Proposed for the agenda').then(() => setProposal('')); }}>
                <input aria-label="Propose an agenda item" value={proposal} onChange={(e) => setProposal(e.target.value)} placeholder="Propose an agenda item" style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', color: 'var(--text)', fontSize: 12 }} />
                <button type="submit" style={smallBtn} disabled={busy || !proposal.trim()}>Propose</button>
              </form>
            </div>
          )}
        </div>
      )}
      {m.status === 'skipped' && <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '0 12px 8px' }}>Skipped: {room.skipped ?? 'nothing on the agenda'}. No model was called.</div>}
    </section>
  );
}

/** Approve / Reject a proposed decision or action; Answer a question for
 *  the CEO. Shows the verdict or the answer once given. Used inline under
 *  the proposal's message and on the full-screen room's Proposed board. */
export function ProposalControls({ wsId, meeting: m, kind, index, onChanged, compact }: { wsId: string; meeting: OrgMeeting; kind: 'decision' | 'action' | 'question'; index: number; onChanged: (m: OrgMeeting) => void; compact?: boolean }) {
  const app = useApp();
  const room = useMemo(() => parseRoom(m.room), [m.room]);
  const standing = useRoomStanding(wsId, m.createdBy, app.me?.actorId ?? '');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<OrgMeeting>) => {
    setBusy(true);
    try { onChanged(await fn()); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  const running = m.status === 'running';
  if (kind === 'question') {
    const a = room.answers[`question:${index}`];
    if (a) return <div data-testid="proposal-answered" style={{ fontSize: 11.5, color: 'var(--green)', marginTop: 4 }}>Answered by {a.byName}: {a.answer}</div>;
    if (!running || !standing.answer) return null;
    return (
      <form style={{ display: 'flex', gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); const t = answer.trim(); if (t) void act(() => api.meetingAnswer(wsId, m.id, index, t)).then(() => setAnswer('')); }}>
        <input aria-label="Answer the question" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={compact ? 'Answer — heard at the next turn' : 'Answer here — heard at the next turn'} style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 9px', color: 'var(--text)', fontSize: 12 }} />
        <button type="submit" style={smallBtn} disabled={busy || !answer.trim()}>Answer</button>
      </form>
    );
  }
  const v = room.verdicts[`${kind}:${index}`];
  if (v) return <div data-testid="proposal-verdict" style={{ fontSize: 11.5, marginTop: 4, color: v.verdict === 'approved' ? 'var(--green)' : 'var(--red)' }}>{v.verdict === 'approved' ? 'Approved' : 'Rejected'} by {v.byName}{v.verdict === 'rejected' ? ' — not executed' : ''}</div>;
  if (!running || !standing.rule) return null;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <button style={primaryBtn} disabled={busy} onClick={() => void act(() => api.meetingVerdict(wsId, m.id, { kind, index, verdict: 'approve' }))}>Approve</button>
      <button style={smallBtn} disabled={busy} onClick={() => void act(() => api.meetingVerdict(wsId, m.id, { kind, index, verdict: 'reject' }))}>Reject</button>
      {!compact && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{kind === 'decision' ? 'logged when the meeting closes unless rejected' : 'becomes a task when the meeting closes unless rejected'}</span>}
    </div>
  );
}

/** Inline under a proposal in a meeting's thread: the controls for the
 *  proposal the message announced, nothing on any other message. */
export function ProposalActions({ wsId, meeting: m, messageId, onChanged }: { wsId: string; meeting: OrgMeeting; messageId: string; onChanged: (m: OrgMeeting) => void }) {
  const ref = useMemo(() => proposalFor(messageId, parseMinutes(m.minutes)), [messageId, m.minutes]);
  if (!ref) return null;
  return <ProposalControls wsId={wsId} meeting={m} kind={ref.kind} index={ref.index} onChanged={onChanged} />;
}
