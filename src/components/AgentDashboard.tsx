/**
 * An agent's Dashboard tab (docs/mission-control.md): "what is this agent
 * doing", at a glance. One request (`GET /api/agents/:id/overview`) draws it:
 *
 *  - the status sentence ("Working on Draft three newsletter issues · 2 h in",
 *    "Blocked on 3 tasks · waiting on you for 1", "Idle: next heartbeat in
 *    14 min", "Paused", "Erroring: provider rejected model …"), the tool call
 *    of a running turn, the next wake, and Chat / Beat now / Pause;
 *  - Now, Blocked (with what each waits on and a way to unblock it), Up next,
 *    Recently done, Goals it owns, Team, Health and, folded, the agent's own
 *    notes (update_dashboard).
 *
 * `AgentDashboard` is presentational (the web tests render it with a
 * fixture); `AgentOverviewPanel` loads it, keeps it live on the workspace
 * stream with a poll behind it, and wires the actions to their routes. The
 * org mission control's side panel renders the same panel in compact form.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, grad } from '../store';
import { api, type AgentOverview, type HomeActivity, type OverviewBlocked, type OverviewFollow, type OverviewTask, type TeamTile } from '../lib/api';
import { cadenceText, usd, when } from '../lib/home';
import { STATE_COLOR, STATE_WORD, elapsed, nextWake, statusSentence, waitsOnWords } from '../lib/overview';
import { Markdown } from '../lib/md';

// ---- the idiom of the app: inline styles over the CSS variables ----

const panel: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' };
const faint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)' };
const dim: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)' };
const chipBtn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'var(--panel-2)', color: primary ? '#fff' : 'var(--text)', border: primary ? '1px solid var(--accent)' : '1px solid var(--border)',
  borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none', font: 'inherit', lineHeight: 1.2,
});
const linkish: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--text)', cursor: 'pointer', textAlign: 'left', font: 'inherit', minWidth: 0 };
const clamp = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
const TRUST_WORD = ['ask', 'draft', 'notify', 'auto'];

export interface DashboardActions {
  openTask: (t: { id: string; source: 'org' | 'agent' }) => void;
  openAgent: (id: string) => void;
  openFile: (path: string) => void;
  openFollow: (f: OverviewFollow) => void;
  openTab: (tab: string) => void;
  openActivity: (a: HomeActivity) => void;
  chat: () => void;
  beatNow: () => void;
  togglePause: () => void;
  /** Answer a blocked org task: a comment on its timeline (it wakes the assignee). */
  comment: (taskId: string, text: string) => Promise<void>;
  reassign: (taskId: string, agentId: string) => Promise<void>;
  /** The CEO's escalation cards (Approvals). */
  openApprovals: () => void;
}

function Avatar({ emoji, colors, size = 22 }: { emoji: string; colors: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: size * 0.3, background: grad(colors), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{emoji}</span>;
}

function Section({ title, count, children, aside, testId }: { title: string; count?: number; children: React.ReactNode; aside?: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 2px 7px' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650, letterSpacing: '-.1px' }}>{title}</h3>
        {count !== undefined && count > 0 && <span style={faint}>{count}</span>}
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ ...panel, padding: '12px 14px', ...dim }}>{children}</div>;
}

/** The header: the sentence, what the running turn is doing, when it next wakes, and the quick actions. */
function StatusHeader({ o, now, compact, busy, act }: { o: AgentOverview; now: Date; compact: boolean; busy: boolean; act: DashboardActions }) {
  const s = o.status;
  const color = STATE_COLOR[s.state];
  const p = statusSentence(o, now);
  const wake = nextWake(o);
  const hb = o.heartbeat;
  const paused = s.state === 'paused' && (s.memberStatus === 'paused' || !o.inCompany);
  const canPause = o.inCompany || Boolean(hb);
  const pauseLabel = o.inCompany ? (s.memberStatus === 'paused' ? 'Resume' : 'Pause') : hb?.enabled ? 'Pause heartbeat' : 'Resume heartbeat';
  return (
    <div data-testid="agent-status" data-state={s.state} style={{ ...panel, padding: compact ? '12px 14px' : '16px 18px', borderLeft: `4px solid ${color}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 650, color }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: color, animation: s.live ? 'pulse 1.4s ease-in-out infinite' : undefined }} />
          {STATE_WORD[s.state]}{s.live ? ' · live' : ''}
        </span>
        {s.lastActiveAt && <span style={faint}>active {when(s.lastActiveAt, now)}</span>}
      </div>
      <div role="heading" aria-level={2} data-testid="agent-sentence" style={{ fontSize: compact ? 16 : 20, lineHeight: 1.3, letterSpacing: '-.3px', overflowWrap: 'anywhere' }}>
        <span style={{ fontWeight: 500, color: p.subject ? 'var(--text-dim)' : 'var(--text)' }}>{p.lead}</span>
        {p.subject && (
          <>{' '}{o.now ? <button style={{ ...linkish, fontWeight: 700, display: 'inline', textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }} onClick={() => act.openTask(o.now!)}>{p.subject}</button> : <span style={{ fontWeight: 700 }}>{p.subject}</span>}</>
        )}
        {p.tail && <span style={{ fontWeight: 500, color: s.state === 'error' ? 'var(--red)' : 'var(--text-dim)' }}>{p.subject || p.lead.startsWith('Blocked') || p.lead === 'Working' ? ' · ' : ': '}{p.tail}</span>}
      </div>
      {s.live && (
        <div data-testid="agent-live" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0 }}>
          <span style={{ color: 'var(--blue)', fontWeight: 600, flex: 'none' }}>Now</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.live.toolLabel || 'thinking'}</span>
          <span style={{ ...faint, flex: 'none' }}>{s.live.calls > 0 ? `${s.live.calls} call${s.live.calls === 1 ? '' : 's'} · ` : ''}{elapsed(s.live.startedAt, now)}</span>
        </div>
      )}
      <div style={{ ...faint, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {wake && s.state !== 'idle' && <span>Next {wake.what} {when(wake.at, now)}</span>}
        {hb && <span>Last beat {hb.lastBeatAt ? when(hb.lastBeatAt, now) : 'never'}</span>}
        {hb && <span>{hb.runsToday}/{hb.dailyRunCap} runs today</span>}
        {hb && !hb.enabled && <span style={{ color: 'var(--amber)' }}>Heartbeat off</span>}
      </div>
      {!compact && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
          <button style={chipBtn(true)} onClick={() => act.chat()}>Chat</button>
          <button style={chipBtn()} disabled={busy || paused} onClick={() => act.beatNow()} title="Run the heartbeat now: it checks for reasons and runs a turn only if it finds some">Beat now</button>
          {canPause && <button style={chipBtn()} disabled={busy} onClick={() => act.togglePause()}>{pauseLabel}</button>}
        </div>
      )}
    </div>
  );
}

function TaskMeta({ t, now }: { t: OverviewTask; now: Date }) {
  const bits = [
    t.startedAt ? `started ${when(t.startedAt, now)}` : `updated ${when(t.updatedAt, now)}`,
    t.dueAt ? `${Date.parse(t.dueAt) < now.getTime() ? 'overdue, was due' : 'due'} ${when(t.dueAt, now)}` : '',
  ].filter(Boolean);
  return <div style={faint}>{bits.join(' · ')}</div>;
}

function NowCard({ t, now, act, compact }: { t: OverviewTask; now: Date; act: DashboardActions; compact: boolean }) {
  return (
    <div data-testid="agent-now" style={{ ...panel, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <button style={{ ...linkish, fontSize: 14.5, fontWeight: 650, flex: 1 }} onClick={() => act.openTask(t)}>{t.title}</button>
        <button style={chipBtn()} onClick={() => act.openTask(t)}>{t.source === 'org' ? 'Open' : 'Tasks'}</button>
      </div>
      {t.outcome && <div style={{ fontSize: 13, ...clamp(compact ? 2 : 3) }}>{t.outcome}</div>}
      {t.doneWhen && !compact && <div style={dim}><span style={{ fontWeight: 600 }}>Done when</span> {t.doneWhen}</div>}
      <TaskMeta t={t} now={now} />
      {t.lastComment && (
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 9, fontSize: 12.5 }}>
          <span style={{ ...faint, display: 'block' }}>{t.lastComment.from}, {when(t.lastComment.at, now)}</span>
          <span style={clamp(2)}>{t.lastComment.text}</span>
        </div>
      )}
      {t.files.length > 0 && !compact && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {t.files.map((f) => <button key={f} onClick={() => act.openFile(f)} style={{ ...chipBtn(), padding: '2px 8px', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 500, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</button>)}
        </div>
      )}
    </div>
  );
}

function BlockedRow({ b, now, act, teammates, compact }: { b: OverviewBlocked; now: Date; act: DashboardActions; teammates: Array<{ id: string; name: string }>; compact: boolean }) {
  const [mode, setMode] = useState<'none' | 'answer' | 'reassign'>('none');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const waits = waitsOnWords(b.blocker.waitsOn);
  const onYou = b.blocker.waitsOn.kind === 'ceo';
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); setMode('none'); setText(''); } finally { setBusy(false); } };
  return (
    <li style={{ padding: '10px 12px', borderTop: '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 5, listStyle: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <button style={{ ...linkish, fontSize: 13, fontWeight: 600, flex: '1 1 180px' }} onClick={() => act.openTask(b)}>{b.title}</button>
        {waits && <span style={{ fontSize: 11, fontWeight: 650, color: onYou ? 'var(--red)' : 'var(--amber)', flex: 'none' }}>{waits}</span>}
        <span style={{ ...faint, flex: 'none' }}>since {when(b.blocker.since, now)}</span>
      </div>
      <div style={{ ...dim, ...clamp(2) }}>{b.blocker.reason}</div>
      {!compact && b.source === 'org' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {onYou && <button style={chipBtn(true)} onClick={() => act.openApprovals()}>Decide</button>}
          <button style={chipBtn(!onYou && mode !== 'answer')} onClick={() => setMode(mode === 'answer' ? 'none' : 'answer')} aria-expanded={mode === 'answer'}>Answer</button>
          {teammates.length > 0 && <button style={chipBtn()} onClick={() => setMode(mode === 'reassign' ? 'none' : 'reassign')} aria-expanded={mode === 'reassign'}>Reassign</button>}
          <button style={chipBtn()} onClick={() => act.openTask(b)}>Open</button>
        </div>
      )}
      {mode === 'answer' && (
        <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(() => act.comment(b.id, text.trim())); }}>
          <input aria-label={`Answer on ${b.title}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer goes on the task and wakes the agent" style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12.5, outline: 'none' }} />
          <button type="submit" style={chipBtn(true)} disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
      {mode === 'reassign' && (
        <select aria-label={`Reassign ${b.title}`} defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void run(() => act.reassign(b.id, e.target.value)); }}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12.5, maxWidth: '100%' }}>
          <option value="">Reassign to…</option>
          {teammates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
    </li>
  );
}

function TaskList({ rows, now, act, numbered, empty, testId }: { rows: OverviewTask[]; now: Date; act: DashboardActions; numbered?: boolean; empty?: string; testId?: string }) {
  if (rows.length === 0) return empty ? <Empty>{empty}</Empty> : null;
  const Tag = numbered ? 'ol' : 'ul';
  return (
    <Tag data-testid={testId} style={{ ...panel, margin: 0, padding: '4px 0' }}>
      {rows.map((t, i) => (
        <li key={`${t.source}:${t.id}`} style={{ listStyle: 'none', padding: '7px 12px', display: 'flex', gap: 9, alignItems: 'baseline', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)' }}>
          {numbered && <span style={{ ...faint, width: 14, flex: 'none', textAlign: 'right' }}>{i + 1}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <button style={{ ...linkish, fontSize: 12.5, fontWeight: 600, display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => act.openTask(t)}>{t.title}</button>
            {t.outcome && <div style={{ ...faint, ...clamp(1) }}>{t.outcome}</div>}
          </div>
          <span style={{ ...faint, flex: 'none' }}>
            {t.status === 'done' ? when(t.updatedAt, now) : t.status === 'in_review' ? t.assigneeName || 'review' : t.dueAt ? `due ${when(t.dueAt, now)}` : t.status === 'waiting' ? 'waiting' : ''}
          </span>
        </li>
      ))}
    </Tag>
  );
}

function ActivityRows({ rows, now, act }: { rows: HomeActivity[]; now: Date; act: DashboardActions }) {
  if (rows.length === 0) return null;
  return (
    <ul style={{ ...panel, margin: 0, padding: '4px 0' }}>
      {rows.map((a, i) => (
        <li key={a.id} style={{ listStyle: 'none', padding: '7px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)', fontSize: 12.5 }}>
          {a.runs ? (
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--text-dim)' }}>{a.title} <span style={faint}>· {when(a.at, now)}</span></summary>
              <ul style={{ margin: '6px 0 0', padding: 0 }}>
                {a.runs.items.map((r) => <li key={r.id} style={{ listStyle: 'none', ...faint, padding: '2px 0' }}>{when(r.at, now)} · {r.detail || r.title}</li>)}
              </ul>
            </details>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <button style={{ ...linkish, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => act.openActivity(a)}>{a.title}</button>
              <span style={{ ...faint, flex: 'none' }}>{when(a.at, now)}</span>
            </div>
          )}
          {!a.runs && a.detail && <div style={{ ...faint, ...clamp(1) }}>{a.detail}</div>}
        </li>
      ))}
    </ul>
  );
}

function Tile({ t, now, act, role }: { t: TeamTile; now: Date; act: DashboardActions; role?: string }) {
  return (
    <button onClick={() => act.openAgent(t.id)} style={{ ...panel, ...linkish, padding: '9px 11px', display: 'flex', gap: 9, alignItems: 'flex-start', borderLeft: `3px solid ${STATE_COLOR[t.state]}`, width: '100%' }}>
      <Avatar emoji={t.emoji} colors={t.colors} size={26} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontSize: 12.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
          <span style={{ fontSize: 11, color: STATE_COLOR[t.state], fontWeight: 600, flex: 'none' }}>{STATE_WORD[t.state]}</span>
        </span>
        <span style={{ ...faint, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{role ?? t.title}{t.lastBeatAt ? ` · beat ${when(t.lastBeatAt, now)}` : ''}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', ...clamp(1) }}>{t.liveLabel || t.doing || 'Nothing in progress'}</span>
      </span>
    </button>
  );
}

function Meter({ value, cap, color }: { value: number; cap: number; color: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  return <span aria-hidden style={{ display: 'block', height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}><span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} /></span>;
}

export function AgentDashboard({ o, now = new Date(), compact = false, busy = false, act, teammates = [], notesOpen = false, extra }: {
  o: AgentOverview; now?: Date; compact?: boolean; busy?: boolean; act: DashboardActions;
  /** Who a blocked task can be reassigned to. */
  teammates?: Array<{ id: string; name: string }>;
  notesOpen?: boolean;
  /** Below the sections (the agent page's actionable events and usage). */
  extra?: React.ReactNode;
}) {
  const grid: React.CSSProperties = { display: 'grid', gap: 16, gridTemplateColumns: compact ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', alignItems: 'start' };
  const h = o.health;
  const spendCap = h.spend.monthCapUsd ?? 0;
  const loud = h.errors;
  const routineHidden = o.recent.filter((r) => r.runs).length;

  if (compact) {
    return (
      <div data-testid="agent-dashboard" data-compact="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <StatusHeader o={o} now={now} compact busy={busy} act={act} />
        {o.now && <NowCard t={o.now} now={now} act={act} compact />}
        {o.blocked.length > 0 && <Section title="Blocked" count={o.blocked.length}><ul style={{ ...panel, margin: 0, padding: 0 }}>{o.blocked.map((b) => <BlockedRow key={b.id} b={b} now={now} act={act} teammates={teammates} compact />)}</ul></Section>}
        {o.queue.length > 0 && <Section title="Up next" count={o.queue.length}><TaskList rows={o.queue.slice(0, 3)} now={now} act={act} numbered /></Section>}
        <div style={{ ...faint, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {h.wip && <span>WIP {h.wip.open}/{h.wip.limit}</span>}
          <span>{usd(h.spend.todayUsd)} today</span>
          {h.spend.monthUsd !== null && <span>{usd(h.spend.monthUsd)}{spendCap ? ` of ${usd(spendCap)}` : ''} this month</span>}
          {o.team.reports.length > 0 && <span>{o.team.reports.length} report{o.team.reports.length === 1 ? '' : 's'}</span>}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="agent-dashboard" style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <StatusHeader o={o} now={now} compact={false} busy={busy} act={act} />
      {o.partial.length > 0 && <div role="status" style={{ ...faint, color: 'var(--amber)' }}>Some sections could not load: {o.partial.join(', ')}.</div>}

      <Section title="Now" testId="section-now">
        {o.now ? <NowCard t={o.now} now={now} act={act} compact={false} />
          : <Empty>{o.status.live ? `Running a turn in ${o.status.live.sessionName || 'a conversation'}, not on a task.` : 'Not on a task right now.'}{o.queue.length > 0 ? ` ${o.queue.length} queued below.` : ''}</Empty>}
      </Section>

      {o.blocked.length > 0 && (
        <Section title="Blocked" count={o.blocked.length} testId="section-blocked">
          <ul style={{ ...panel, margin: 0, padding: 0, overflow: 'hidden' }}>
            {o.blocked.map((b) => <BlockedRow key={`${b.source}:${b.id}`} b={b} now={now} act={act} teammates={teammates.filter((m) => m.id !== o.agentId)} compact={false} />)}
          </ul>
        </Section>
      )}

      <div style={grid}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Section title="Up next" count={o.queue.length} testId="section-queue">
            <TaskList rows={o.queue} now={now} act={act} numbered empty="Nothing queued." />
          </Section>
          {o.reviews.length > 0 && (
            <Section title="Reviews it owes" count={o.reviews.length}>
              <TaskList rows={o.reviews} now={now} act={act} />
            </Section>
          )}
          {o.follows.length > 0 && (
            <Section title="Following" count={o.follows.length}>
              <ul style={{ ...panel, margin: 0, padding: '4px 0' }}>
                {o.follows.map((f, i) => (
                  <li key={f.id} style={{ listStyle: 'none', padding: '7px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)' }}>
                    <button style={{ ...linkish, fontSize: 12.5, fontWeight: 600, display: 'block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => act.openFollow(f)}>{f.title || f.targetKind}</button>
                    <div style={faint}>{f.attention || `${f.unseen} new`}{f.lastActorName ? ` · ${f.lastActorName}` : ''}{f.lastActivityAt ? ` · ${when(f.lastActivityAt, now)}` : ''}</div>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {o.goals.length > 0 && (
            <Section title="Goals it owns" count={o.goals.length} testId="section-goals">
              <ul style={{ ...panel, margin: 0, padding: '4px 0' }}>
                {o.goals.map((g, i) => {
                  const c = g.rag === 'red' ? 'var(--red)' : g.rag === 'amber' ? 'var(--amber)' : g.rag === 'green' ? 'var(--green)' : 'var(--text-faint)';
                  return (
                    <li key={g.id} style={{ listStyle: 'none', padding: '8px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0 }}>{g.title}</span>
                        <span style={{ ...faint, flex: 'none' }}>{g.targetValue !== null && g.currentValue !== null ? `${g.currentValue} / ${g.targetValue} ${g.unitLabel}` : `${Math.round(g.progress * 100)}%`}{g.confidence !== null ? ` · ${Math.round(g.confidence * 100)}% sure` : ''}</span>
                      </div>
                      <Meter value={g.progress} cap={1} color={c} />
                      {g.atRisk && g.atRiskReason && <div style={{ ...faint, color: 'var(--red)' }}>{g.atRiskReason}</div>}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <Section title="Recently done" count={o.done.length} testId="section-done">
            <TaskList rows={o.done} now={now} act={act} empty="Nothing finished in the last two weeks." />
          </Section>
          {o.files.length > 0 && (
            <Section title="Files it wrote">
              <ul style={{ ...panel, margin: 0, padding: '4px 0' }}>
                {o.files.map((f, i) => (
                  <li key={f.path} style={{ listStyle: 'none', padding: '6px 12px', display: 'flex', gap: 8, alignItems: 'baseline', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)' }}>
                    <button style={{ ...linkish, fontFamily: 'var(--mono)', fontSize: 11.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => act.openFile(f.path)}>{f.path}</button>
                    <span style={{ ...faint, flex: 'none' }}>{when(f.updatedAt, now)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {o.recent.length > 0 && (
            <Section title="Its week" count={o.recent.length - routineHidden || undefined} testId="section-recent">
              <ActivityRows rows={o.recent.slice(0, 12)} now={now} act={act} />
            </Section>
          )}
        </div>
      </div>

      <div style={grid}>
        <Section title="Team" testId="section-team">
          {o.team.manager || o.team.reports.length || o.team.humans.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {o.team.unit && <div style={faint}>Leads {o.team.unit.name} · #{o.team.unit.slug}</div>}
              {o.team.manager && <Tile t={o.team.manager} now={now} act={act} role={`Manager · ${o.team.manager.title || 'lead'}`} />}
              {o.team.reports.map((r) => <Tile key={r.id} t={r} now={now} act={act} />)}
              {o.team.humans.map((hm) => <div key={hm.memberAccountId} style={{ ...panel, padding: '8px 11px', ...dim }}>A person{hm.title ? `, ${hm.title}` : ''}, reports here</div>)}
            </div>
          ) : <Empty>{o.inCompany ? 'No manager or reports.' : 'Not in a company: it works on its own.'}</Empty>}
        </Section>

        <Section title="Health" testId="section-health">
          <div style={{ ...panel, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {loud.length > 0 ? (
              <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {loud.map((e, i) => <li key={i} style={{ listStyle: 'none', fontSize: 12.5, color: e.kind === 'provider' ? 'var(--amber)' : 'var(--red)', overflowWrap: 'anywhere' }}>{e.message} <span style={faint}>· {when(e.at, now)}</span></li>)}
              </ul>
            ) : <div style={{ fontSize: 12.5, color: 'var(--green)' }}>No errors in the last two days.</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
              <div><div style={faint}>Today</div><div style={{ fontSize: 14, fontWeight: 650 }}>{usd(h.spend.todayUsd)}</div></div>
              <div><div style={faint}>30 days</div><div style={{ fontSize: 14, fontWeight: 650 }}>{usd(h.spend.d30Usd)}</div></div>
              <div><div style={faint}>This month</div><div style={{ fontSize: 14, fontWeight: 650 }}>{usd(h.spend.monthUsd)}{spendCap ? <span style={{ ...faint, fontWeight: 400 }}> of {usd(spendCap)}</span> : null}</div></div>
            </div>
            {spendCap > 0 && h.spend.monthUsd !== null && <Meter value={h.spend.monthUsd} cap={spendCap} color={h.spend.monthUsd / spendCap > 0.9 ? 'var(--red)' : h.spend.monthUsd / spendCap > 0.7 ? 'var(--amber)' : 'var(--green)'} />}
            <div style={{ ...faint, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {h.wip && <span style={{ color: h.wip.open >= h.wip.limit ? 'var(--amber)' : undefined }}>WIP {h.wip.open}/{h.wip.limit}</span>}
              {o.heartbeat && <span>Heartbeat {o.heartbeat.enabled ? cadenceText(o.heartbeat.cron, o.heartbeat.nextDueAt) : 'off'}</span>}
              {o.heartbeat && <span>{o.heartbeat.runsToday}/{o.heartbeat.dailyRunCap} runs today</span>}
              {o.nextLoop && <span>{o.nextLoop.name} {when(o.nextLoop.at, now)}</span>}
            </div>
            {h.trust.length > 0 && (
              <button style={{ ...linkish, display: 'flex', gap: 5, flexWrap: 'wrap' }} onClick={() => act.openTab('Trust')} title="Trust levels per action class (the Trust tab)">
                {h.trust.map((t) => <span key={t.actionClass} style={{ fontSize: 10.5, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '1px 7px', color: 'var(--text-dim)' }}>{t.actionClass.replace(/_/g, ' ')}: {TRUST_WORD[t.effective] ?? t.effective}</span>)}
              </button>
            )}
          </div>
        </Section>
      </div>

      {extra}

      <details open={notesOpen} data-testid="agent-notes" style={{ ...panel, padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 650 }}>{o.agent.name}&apos;s notes <span style={{ ...faint, fontWeight: 400 }}>kept by the agent (update_dashboard)</span></summary>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {o.dashboard.trim() ? <Markdown text={o.dashboard} /> : <div style={dim}>No notes yet. Ask {o.agent.name} in a chat to set up its dashboard; it keeps the page current with the update_dashboard tool.</div>}
        </div>
      </details>
    </div>
  );
}

// ---- the container ----

/** Org events are not all on the workspace stream: poll, faster while a turn runs. */
const POLL_MS = 30_000;
const LIVE_POLL_MS = 8_000;
const DEBOUNCE_MS = 1_500;

export function useAgentOverview(agentId: string | null) {
  const app = useApp();
  const [data, setData] = useState<AgentOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async () => {
    if (!agentId) return;
    try {
      const o = await api.agentOverview(agentId);
      if (o.agentId !== agentId) return;
      setData(o); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [agentId]);
  useEffect(() => { setData(null); setError(null); void load(); }, [load]);
  const soon = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(() => { void load(); }, DEBOUNCE_MS); }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => app.onWorkspaceEvent((ev) => {
    if (ev.type === 'file.changed' || ev.type === 'file_changed' || ev.type === 'task_update' || ev.type === 'channel_approval') soon();
    else if ((ev.type === 'channel_typing' || ev.type === 'channel_message') && 'agentId' in ev && ev.agentId === agentId) soon();
  }), [app, soon, agentId]);
  const live = Boolean(data?.status.live) || data?.status.state === 'working';
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, live ? LIVE_POLL_MS : POLL_MS);
    const onFocus = () => soon();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [load, soon, live]);
  return { data, error, reload: load };
}

/** The Dashboard tab (and, compact, the mission control's side panel): data, live updates, actions. */
export function AgentOverviewPanel({ agentId, compact = false, onOpenTab, extra }: { agentId: string; compact?: boolean; onOpenTab?: (tab: string) => void; extra?: React.ReactNode }) {
  const app = useApp();
  const { data, error, reload } = useAgentOverview(agentId);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setTick(new Date()), 30_000); return () => clearInterval(t); }, []);
  const wsId = data?.workspaceId ?? app.workspaceId;
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) app.showToast(done); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'That did not work'); } finally { setBusy(false); }
  };
  if (!data) {
    return error
      ? <div role="alert" style={{ ...panel, padding: '12px 14px', fontSize: 12.5, color: 'var(--red)' }}>Could not load this agent&apos;s overview: {error.slice(0, 200)} <button style={{ ...chipBtn(), marginLeft: 8 }} onClick={() => void reload()}>Retry</button></div>
      : <div style={{ ...faint, padding: '12px 2px' }}>Loading…</div>;
  }
  const o = data;
  const teammates = app.agents.filter((a) => a.workspaceId === o.workspaceId && a.id !== o.agentId).map((a) => ({ id: a.id, name: a.name }));
  const act: DashboardActions = {
    openTask: (t) => { if (t.source === 'org') { app.setMobileDetail(true); app.openOrgTask(t.id); } else (onOpenTab ?? ((tab) => app.openAgent(o.agentId, tab)))('Tasks'); },
    openAgent: (id) => app.openAgent(id),
    openFile: (path) => app.openFile({ kind: 'workspace', id: wsId }, path),
    openFollow: (f) => { if (f.targetKind === 'task') app.openOrgTask(f.targetId); else app.go('inbox'); },
    openTab: (tab) => (onOpenTab ? onOpenTab(tab) : app.openAgent(o.agentId, tab)),
    openActivity: (a) => {
      if (a.ref?.type === 'task') app.openOrgTask(a.ref.id);
      else if (a.ref?.type === 'file') app.openFile({ kind: 'workspace', id: wsId }, a.ref.id);
    },
    chat: () => void app.newChat(o.agentId),
    beatNow: () => void run(async () => {
      const r = await api.beatNow(o.agentId);
      app.showToast(r.ran ? `Heartbeat ran: ${r.reasons.length} reason(s)` : r.reasons.length ? `Heartbeat ${r.status}: ${r.reasons.length} reason(s), no run` : `Nothing to do (${r.status})`);
    }),
    togglePause: () => void run(() => (o.inCompany
      ? (o.status.memberStatus === 'paused' ? api.resumeOrgMember(wsId, o.agentId) : api.pauseOrgMember(wsId, o.agentId))
      : api.updateHeartbeat(o.agentId, { enabled: !o.heartbeat?.enabled })), o.inCompany ? (o.status.memberStatus === 'paused' ? 'Resumed' : 'Paused') : o.heartbeat?.enabled ? 'Heartbeat paused' : 'Heartbeat resumed'),
    comment: async (taskId, text) => { await run(() => api.commentOrgTask(wsId, taskId, text), 'Answer posted'); },
    reassign: async (taskId, agentId) => { await run(() => api.assignOrgTask(wsId, taskId, agentId), 'Reassigned'); },
    openApprovals: () => { app.setOrgFocus(null); app.setOrgUnitId(null); app.setOrgPane('approvals'); app.setMobileDetail(true); },
  };
  return <AgentDashboard o={o} now={tick} compact={compact} busy={busy} act={act} teammates={teammates} extra={extra} />;
}
