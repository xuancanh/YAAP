/** Shared look of the meeting room views (MeetingRoom, MeetingView): the
 *  button styles and the colours and labels of seat, agenda and open-item states. */
import type { AgendaState, SeatState } from '../lib/meetings';

export const smallBtn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '3px 9px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
export const primaryBtn: React.CSSProperties = { ...smallBtn, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' };

export const SEAT: Record<SeatState, { label: string; color: string }> = {
  speaking: { label: 'speaking', color: 'var(--green)' },
  spoke: { label: 'spoke', color: 'var(--accent)' },
  passed: { label: 'passed', color: 'var(--text-faint)' },
  waiting: { label: 'waiting', color: 'var(--amber)' },
  idle: { label: 'not called', color: 'var(--border)' },
  present: { label: 'present', color: 'var(--green)' },
  away: { label: 'not joined', color: 'var(--border)' },
};
export const OPEN_STATE: Record<string, string> = { done: 'var(--green)', late: 'var(--red)', blocked: 'var(--amber)', open: 'var(--accent)', dropped: 'var(--text-faint)' };
export const AGENDA_STATE: Record<AgendaState, { label: string; color: string; mark: string }> = {
  done: { label: 'done', color: 'var(--green)', mark: '✓' },
  current: { label: 'now', color: 'var(--accent)', mark: '●' },
  upcoming: { label: 'up next', color: 'var(--text-faint)', mark: '○' },
  parked: { label: 'parked', color: 'var(--amber)', mark: '∥' },
  skipped: { label: 'skipped', color: 'var(--text-faint)', mark: '↷' },
};
export const statusColor = (s: string): string => (s === 'running' ? 'var(--green)' : s === 'done' ? 'var(--text-dim)' : s === 'cancelled' ? 'var(--red)' : 'var(--amber)');
