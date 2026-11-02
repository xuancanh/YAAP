/** The meeting room (docs/meetings.md "During"): the header a meeting thread
 *  shows in ChannelView's thread panel (full width on a phone) — the agenda
 *  items and which is current, round N of M, the item's time box and the
 *  meeting's elapsed time against the whole box, the attendee strip
 *  (speaking now / spoke / passed / waiting; people present or not), tokens
 *  and USD, Join, and for the CEO or the starter Extend / Skip item / End.
 *  Before the start: the pre-read, the agenda proposals and a box to add
 *  one. `ProposalActions` is the inline Approve / Reject under a proposed
 *  decision or action and the Answer box under a question for the CEO. The
 *  speaker's reply itself streams in the thread (channel_stream with the
 *  thread as replyRootId), drawn by ChannelView. */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgMeeting } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import { MEETING_KIND_TITLES, parseMinutes } from '../lib/org';
import { minutesSince, parseRoom, proposalFor, seats, tokensText, type SeatState } from '../lib/meetings';

const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 8px', fontSize: 11, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)', whiteSpace: 'nowrap' };
const smallBtn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '3px 9px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' };
const SEAT: Record<SeatState, { label: string; color: string }> = {
  speaking: { label: 'speaking', color: 'var(--green)' },
  spoke: { label: 'spoke', color: 'var(--accent)' },
  passed: { label: 'passed', color: 'var(--text-faint)' },
  waiting: { label: 'waiting', color: 'var(--amber)' },
  idle: { label: 'not called', color: 'var(--border)' },
  present: { label: 'present', color: 'var(--green)' },
  away: { label: 'not joined', color: 'var(--border)' },
};
const OPEN_STATE: Record<string, string> = { done: 'var(--green)', late: 'var(--red)', blocked: 'var(--amber)', open: 'var(--accent)', dropped: 'var(--text-faint)' };

export function MeetingRoom({ wsId, meeting: m, me, name, onChanged }: {
  wsId: string; meeting: OrgMeeting; me: string;
  name: (kind: 'agent' | 'human', id: string) => string;
  onChanged: (m: OrgMeeting) => void;
}) {
  const app = useApp();
  const room = useMemo(() => parseRoom(m.room), [m.room]);
  const attendees = useMemo(() => { try { return JSON.parse(m.attendees || '[]') as Array<{ kind: 'agent' | 'human'; id: string }>; } catch { return []; } }, [m.attendees]);
  const [, setTick] = useState(0);
  const [proposal, setProposal] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPre, setShowPre] = useState(false);
  const running = m.status === 'running';
  const before = m.status === 'scheduled' || m.status === 'postponed';
  useEffect(() => { if (!running) return; const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, [running]);
  const act = async (fn: () => Promise<OrgMeeting>, done?: string) => {
    setBusy(true);
    try { onChanged(await fn()); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  const strip = seats(room, attendees, m.facilitatorAgentId, name);
  const present = room.present.includes(me);
  const itemElapsed = minutesSince(room.itemStartedAt);
  const elapsed = minutesSince(m.startedAt);
  const box = room.items.length * room.itemMinutes;
  const tokens = (m.tokensIn ?? 0) + (m.tokensOut ?? 0);
  const color = running ? 'var(--green)' : m.status === 'done' ? 'var(--text-dim)' : m.status === 'cancelled' ? 'var(--red)' : 'var(--amber)';
  return (
    <section aria-label="Meeting room" data-testid="meeting-room" style={{ borderBottom: '1px solid var(--border)', padding: '10px 14px', background: 'var(--panel)', display: 'grid', gap: 8, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, animation: running ? 'pulse 1.2s infinite' : undefined, flex: 'none' }} />
        <span style={{ fontWeight: 700, fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>{m.title || MEETING_KIND_TITLES[m.kind]}</span>
        <span style={{ fontSize: 11.5, color }}>{m.status}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(running || before) && !present && <button style={{ ...smallBtn, background: 'var(--accent)', color: '#fff', border: 'none' }} disabled={busy} onClick={() => void act(() => api.joinMeeting(wsId, m.id), 'You are in the room: you are heard at the next turn')}>Join</button>}
          {running && <button style={smallBtn} disabled={busy || m.kind === 'standup'} title="One more round, within the caps" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'extend'), 'One more round')}>Extend</button>}
          {running && <button style={smallBtn} disabled={busy || room.current >= room.items.length} title="Move to the next agenda item" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'skip'), 'Item skipped')}>Skip item</button>}
          {running && <button style={{ ...smallBtn, color: 'var(--red)' }} disabled={busy || Boolean(room.controls.end)} title="End after the current turn; the facilitator closes it" onClick={() => void act(() => api.controlMeeting(wsId, m.id, 'end'), 'Ending the meeting')}>{room.controls.end ? 'Ending…' : 'End'}</button>}
        </span>
      </div>

      {(running || m.status === 'done') && room.roundCap > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-dim)' }}>
          <span data-testid="room-round">Round {Math.max(1, room.round)} of {room.roundCap}</span>
          {room.items.length > 0 && room.current < room.items.length && <span>Item {room.current + 1} of {room.items.length} · {itemElapsed} / {room.itemMinutes} min</span>}
          {m.startedAt && <span>{elapsed} min elapsed{box ? ` of ~${box}` : ''}</span>}
          <span data-testid="room-cost">{tokensText(tokens)} tokens · {fmtUsd(m.usd)}</span>
        </div>
      )}

      {room.items.length > 0 && (
        <ol aria-label="Agenda items" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2, fontSize: 12 }}>
          {room.items.map((it, i) => {
            const current = running && i === room.current;
            const done = i < room.current;
            return (
              <li key={i} aria-current={current ? 'step' : undefined} style={{ color: current ? 'var(--text)' : done ? 'var(--text-faint)' : 'var(--text-dim)', fontWeight: current ? 700 : 400, textDecoration: done ? 'line-through' : undefined, overflowWrap: 'anywhere' }}>
                {it}{current ? ' ← now' : ''}
              </li>
            );
          })}
        </ol>
      )}

      {strip.length > 0 && (
        <div aria-label="Attendees" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {strip.map((s) => (
            <span key={`${s.kind}:${s.id}`} data-testid="seat" data-state={s.state} title={`${s.name}${s.facilitator ? ' (facilitator)' : ''}: ${SEAT[s.state].label}`} style={{ ...chip, borderColor: SEAT[s.state].color, opacity: s.state === 'idle' || s.state === 'away' ? 0.6 : 1 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEAT[s.state].color, animation: s.state === 'speaking' ? 'pulse 1.2s infinite' : undefined }} />
              {s.name}{s.facilitator ? ' ★' : ''}{s.kind === 'human' && s.id === me ? ' (you)' : ''}
              <span style={{ color: 'var(--text-faint)' }}>{SEAT[s.state].label}</span>
            </span>
          ))}
        </div>
      )}

      {room.openItems.length > 0 && (
        <details>
          <summary style={{ fontSize: 11.5, color: 'var(--text-dim)', cursor: 'pointer' }}>Open items from the last meeting ({room.openItems.filter((i) => i.state !== 'done' && i.state !== 'dropped').length} open)</summary>
          <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
            {room.openItems.map((i, k) => (
              <div key={k} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                <span style={{ ...chip, padding: '0 6px', borderColor: OPEN_STATE[i.state], color: OPEN_STATE[i.state] }}>{i.state}</span>
                <span style={{ overflowWrap: 'anywhere' }}>{i.title} — {i.owner || 'unowned'}{i.due ? ` · due ${i.due.slice(0, 10)}` : ''}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {before && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{m.scheduledFor ? `Starts ${new Date(m.scheduledFor).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not started yet'} · agenda proposals are open until it starts</div>
          {room.preRead && (
            <div>
              <button style={{ ...smallBtn, padding: '2px 8px' }} onClick={() => setShowPre(!showPre)} aria-expanded={showPre}>{showPre ? 'Hide' : 'Show'} the pre-read</button>
              {showPre && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: '6px 0 0', fontFamily: 'inherit', color: 'var(--text-dim)' }}>{room.preRead}</pre>}
            </div>
          )}
          {room.proposals.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>{room.proposals.map((p, i) => <li key={i}>{p.text}{p.why ? <span style={{ color: 'var(--text-faint)' }}> — {p.why}</span> : null}</li>)}</ul>}
          <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); const t = proposal.trim(); if (!t) return; void act(() => api.proposeMeetingAgenda(wsId, m.id, t), 'Proposed for the agenda').then(() => setProposal('')); }}>
            <input aria-label="Propose an agenda item" value={proposal} onChange={(e) => setProposal(e.target.value)} placeholder="Propose an agenda item" style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', color: 'var(--text)', fontSize: 12 }} />
            <button type="submit" style={smallBtn} disabled={busy || !proposal.trim()}>Propose</button>
          </form>
        </div>
      )}
      {m.status === 'skipped' && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Skipped: {room.skipped ?? 'nothing on the agenda'}. No model was called.</div>}
    </section>
  );
}

/** Inline under a proposal in a running meeting's thread: Approve / Reject a
 *  decision or an action; Answer a question for the CEO. Shows the verdict
 *  or the answer once given. */
export function ProposalActions({ wsId, meeting: m, messageId, onChanged }: { wsId: string; meeting: OrgMeeting; messageId: string; onChanged: (m: OrgMeeting) => void }) {
  const app = useApp();
  const ref = useMemo(() => proposalFor(messageId, parseMinutes(m.minutes)), [messageId, m.minutes]);
  const room = useMemo(() => parseRoom(m.room), [m.room]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  if (!ref) return null;
  const act = async (fn: () => Promise<OrgMeeting>) => {
    setBusy(true);
    try { onChanged(await fn()); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  const running = m.status === 'running';
  if (ref.kind === 'question') {
    const a = room.answers[`question:${ref.index}`];
    if (a) return <div data-testid="proposal-answered" style={{ fontSize: 11.5, color: 'var(--green)', marginTop: 4 }}>Answered by {a.byName}: {a.answer}</div>;
    if (!running) return null;
    return (
      <form style={{ display: 'flex', gap: 6, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); const t = answer.trim(); if (t) void act(() => api.meetingAnswer(wsId, m.id, ref.index, t)).then(() => setAnswer('')); }}>
        <input aria-label="Answer the question" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer here — heard at the next turn" style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 9px', color: 'var(--text)', fontSize: 12 }} />
        <button type="submit" style={smallBtn} disabled={busy || !answer.trim()}>Answer</button>
      </form>
    );
  }
  const v = room.verdicts[`${ref.kind}:${ref.index}`];
  if (v) return <div data-testid="proposal-verdict" style={{ fontSize: 11.5, marginTop: 4, color: v.verdict === 'approved' ? 'var(--green)' : 'var(--red)' }}>{v.verdict === 'approved' ? 'Approved' : 'Rejected'} by {v.byName}{v.verdict === 'rejected' ? ' — not executed' : ''}</div>;
  if (!running) return null;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
      <button style={{ ...smallBtn, background: 'var(--accent)', color: '#fff', border: 'none' }} disabled={busy} onClick={() => void act(() => api.meetingVerdict(wsId, m.id, { kind: ref.kind as 'decision' | 'action', index: ref.index, verdict: 'approve' }))}>Approve</button>
      <button style={smallBtn} disabled={busy} onClick={() => void act(() => api.meetingVerdict(wsId, m.id, { kind: ref.kind as 'decision' | 'action', index: ref.index, verdict: 'reject' }))}>Reject</button>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{ref.kind === 'decision' ? 'logged when the meeting closes unless rejected' : 'becomes a task when the meeting closes unless rejected'}</span>
    </div>
  );
}
