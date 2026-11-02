/**
 * An agent's page (docs/mission-control.md "An agent's page"): what is this
 * agent doing, what needs you, and is it healthy? One request
 * (`GET /api/agents/:id/overview`) draws it, top to bottom:
 *
 *  - `AgentHeader`: who it is, one status pill and one specific sentence
 *    ("Erroring: tool round limit (24) reached", linked to the failing run,
 *    with a fix), what a running turn is doing, and Chat / Beat now / Pause
 *    with the rest (Import, Export, Publish) in an overflow menu. The agent
 *    page shows it above every tab;
 *  - the signals: Doing, Blocked, Queue, WIP, Budget, Errors, amber or red
 *    when off; a click filters the work list (or opens Health);
 *  - Needs you, only when something waits on the owner, with its actions;
 *  - Work: one card, Now · Blocked · Up next · Reviews · Done, one line a
 *    task, expanding in place;
 *  - Activity: one timeline with filters, ten rows before "Show all";
 *  - beside it Team, Health and Goals; the agent's own notes folded last.
 *
 * `AgentDashboard` and `AgentHeader` are presentational (the web tests
 * render them with a fixture); `useAgentPage` loads the overview, keeps it
 * live and wires the actions to their routes; `AgentOverviewPanel` is the
 * org mission control's compact side panel.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, grad } from '../store';
import { api, type AgentOverview, type HomeActivity, type NeedsYouItem, type OverviewBlocked, type OverviewFollow, type OverviewTask, type TeamTile } from '../lib/api';
import { cadenceText, usd, when } from '../lib/home';
import {
  ACTIVITY_CAP, ACTIVITY_FILTERS, STATE_COLOR, STATE_WORD, activityKind, defaultWorkTab, elapsed, mergedActivity, nextWake, signals, statusSentence, waitsOnWords,
  type ActivityFilter, type Signal, type SignalLevel, type WorkTab,
} from '../lib/overview';
import { Markdown } from '../lib/md';

// ---- the idiom of the app: inline styles over the CSS variables ----

const panel: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' };
const faint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-faint)' };
const dim: React.CSSProperties = { fontSize: 12.5, color: 'var(--text-dim)' };
const chipBtn = (primary = false): React.CSSProperties => ({
  background: primary ? 'var(--accent)' : 'var(--panel-2)', color: primary ? '#fff' : 'var(--text)', border: primary ? '1px solid var(--accent)' : '1px solid var(--border)',
  borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none', font: 'inherit', lineHeight: 1.2,
});
const smallBtn = (tone: 'plain' | 'primary' | 'good' | 'bad' = 'plain'): React.CSSProperties => ({
  ...chipBtn(tone === 'primary'), padding: '4px 10px', fontSize: 11.5,
  ...(tone === 'good' ? { background: 'var(--green)', borderColor: 'var(--green)', color: '#04140d' } : {}),
  ...(tone === 'bad' ? { background: 'none', borderColor: 'var(--red)', color: 'var(--red)' } : {}),
});
const linkish: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--text)', cursor: 'pointer', textAlign: 'left', font: 'inherit', minWidth: 0 };
const inlineLink: React.CSSProperties = { ...linkish, color: 'var(--accent-hi, var(--accent))', textDecoration: 'underline', textUnderlineOffset: 3, display: 'inline' };
const clamp = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
const oneLine: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
const LEVEL_COLOR: Record<SignalLevel, string> = { ok: 'var(--text)', quiet: 'var(--text)', warn: 'var(--amber)', bad: 'var(--red)' };
const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const tint = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, var(--panel))`;

export interface DashboardActions {
  openTask: (t: { id: string; source: 'org' | 'agent' }) => void;
  openAgent: (id: string) => void;
  openFile: (path: string) => void;
  openFollow: (f: OverviewFollow) => void;
  /** A tab of the agent page: 'Work', 'Settings:General', or an old name ('Trust'). */
  openTab: (tab: string) => void;
  openActivity: (a: HomeActivity) => void;
  /** A conversation (the failing run, the turn that queued an action). */
  openSession: (sessionId: string) => void;
  chat: () => void;
  beatNow: () => void;
  togglePause: () => void;
  /** Answer a blocked org task: a comment on its timeline (it wakes the assignee). */
  comment: (taskId: string, text: string) => Promise<void>;
  reassign: (taskId: string, agentId: string) => Promise<void>;
  /** The CEO's escalation and approval cards (Approvals). */
  openApprovals: () => void;
  /** A queued background action: run it or drop it. */
  actOnEvent: (eventId: string, decision: 'approve' | 'dismiss') => Promise<void>;
  /** A connection another member's turn asks to use: allow or deny. */
  decideEvent: (eventId: string, decision: 'allow' | 'deny') => Promise<void>;
}

export interface HeaderMenuItem { label: string; title?: string; onSelect?: () => void; href?: string; download?: boolean }

function Avatar({ emoji, colors, size = 22 }: { emoji: string; colors: string; size?: number }) {
  return <span aria-hidden style={{ width: size, height: size, borderRadius: size * 0.3, background: grad(colors), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, flex: 'none' }}>{emoji}</span>;
}

function Section({ title, count, children, aside, testId, id }: { title: string; count?: number; children: React.ReactNode; aside?: React.ReactNode; testId?: string; id?: string }) {
  return (
    <section data-testid={testId} id={id} aria-label={title} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 2px 7px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 650, letterSpacing: '-.1px' }}>{title}</h3>
        {count !== undefined && count > 0 && <span style={faint}>{count}</span>}
        <span style={{ flex: 1 }} />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Long text, three lines (or `lines`) until asked for more. */
function Clamped({ text, lines = 3, style }: { text: string; lines?: number; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 70 || text.split('\n').length > lines;
  return (
    <div style={style}>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...(open ? {} : clamp(lines)) }}>{text}</div>
      {long && <button style={{ ...linkish, ...faint, textDecoration: 'underline', textUnderlineOffset: 2 }} onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'less' : 'more'}</button>}
    </div>
  );
}

// ---- the header ----

function OverflowMenu({ items }: { items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (items.length === 0) return null;
  const itemStyle: React.CSSProperties = { ...linkish, display: 'block', width: '100%', padding: '8px 12px', fontSize: 12.5, color: 'var(--text)', textDecoration: 'none', borderRadius: 6 };
  return (
    <div ref={box} style={{ position: 'relative', flex: 'none' }}>
      <button style={{ ...chipBtn(), padding: '6px 10px', letterSpacing: 1 }} aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>•••</button>
      {open && (
        <div role="menu" style={{ ...panel, position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 20, minWidth: 190, padding: 4, boxShadow: '0 8px 24px color-mix(in oklab, var(--text) 14%, transparent)' }}>
          {items.map((it) => it.href
            ? <a key={it.label} role="menuitem" href={it.href} download={it.download} title={it.title} style={itemStyle} onClick={() => setOpen(false)}>{it.label}</a>
            : <button key={it.label} role="menuitem" title={it.title} style={itemStyle} onClick={() => { setOpen(false); it.onSelect?.(); }}>{it.label}</button>)}
        </div>
      )}
    </div>
  );
}

/** The state pill, the one sentence (linked: the task, the failing run), the fix, the live call and the next wake. */
function StatusBlock({ o, now, act, compact }: { o: AgentOverview; now: Date; act: DashboardActions; compact: boolean }) {
  const s = o.status;
  const color = STATE_COLOR[s.state];
  const p = statusSentence(o, now);
  const wake = nextWake(o);
  const hb = o.heartbeat;
  const cause = s.state === 'error' ? o.cause : null;
  const sep = p.subject || p.lead.startsWith('Blocked') || p.lead === 'Working' ? ' · ' : ': ';
  // The pill says the state; the sentence says the rest without repeating it.
  const bare = p.lead === STATE_WORD[s.state] && !p.subject;
  return (
    <div data-testid="agent-status" data-state={s.state} style={{ display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, minWidth: 0 }}>
        <span data-testid="agent-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 650, color, background: tint(color, 12), border: `1px solid ${tint(color, 40)}`, borderRadius: 999, padding: '2px 9px', flex: 'none', marginTop: compact ? 0 : 2 }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, animation: s.live ? 'pulse 1.4s ease-in-out infinite' : undefined }} />
          {STATE_WORD[s.state]}{s.live ? ', live' : ''}
        </span>
        <div role="heading" aria-level={2} data-testid="agent-sentence" style={{ fontSize: compact ? 14.5 : 16.5, lineHeight: 1.35, letterSpacing: '-.2px', overflowWrap: 'anywhere', minWidth: 0, fontWeight: 500, color: s.state === 'error' ? 'var(--red)' : 'var(--text)' }}>
          {bare ? cap(p.tail || p.lead) : (
            <>
              <span style={{ color: 'var(--text-dim)' }}>{p.lead}</span>
              {p.subject && <>{' '}{o.now ? <button style={{ ...linkish, fontWeight: 650, display: 'inline', textDecoration: 'underline', textDecorationColor: 'var(--border)', textUnderlineOffset: 3 }} onClick={() => act.openTask(o.now!)}>{p.subject}</button> : <span style={{ fontWeight: 650 }}>{p.subject}</span>}</>}
              {p.tail && <span style={{ color: 'var(--text-dim)' }}>{sep}{p.tail}</span>}
            </>
          )}
        </div>
      </div>
      {cause && (
        <div data-testid="agent-cause" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', fontSize: 12.5 }}>
          {cause.fix && <span style={{ color: 'var(--text)', flex: '1 1 260px', minWidth: 0 }}>{cause.fix.text}</span>}
          <span style={{ display: 'inline-flex', gap: 10, flex: 'none' }}>
            {cause.fix?.tab && !compact && <button style={inlineLink} onClick={() => act.openTab(cause.fix!.tab!)}>Fix it</button>}
            {cause.sessionId && <button style={inlineLink} onClick={() => act.openSession(cause.sessionId!)}>See the run</button>}
            {cause.taskId && <button style={inlineLink} onClick={() => act.openTask({ id: cause.taskId!, source: 'org' })}>Open the task</button>}
            <span style={faint}>{when(cause.at, now)}</span>
          </span>
        </div>
      )}
      {s.live && (
        <div data-testid="agent-live" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0 }}>
          <span style={{ color: 'var(--blue)', fontWeight: 600, flex: 'none' }}>Now</span>
          <span style={oneLine}>{s.live.toolLabel || 'thinking'}</span>
          <span style={{ ...faint, flex: 'none' }}>{s.live.calls > 0 ? `${s.live.calls} call${s.live.calls === 1 ? '' : 's'}, ` : ''}{elapsed(s.live.startedAt, now)}</span>
        </div>
      )}
      <div style={{ ...faint, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {wake && s.state !== 'idle' && <span>Next {wake.what} {when(wake.at, now)}</span>}
        {hb && <span>Last beat {hb.lastBeatAt ? when(hb.lastBeatAt, now) : 'never'}</span>}
        {hb && !hb.enabled && <span style={{ color: 'var(--amber)' }}>Heartbeat off</span>}
        {!hb && s.lastActiveAt && <span>Active {when(s.lastActiveAt, now)}</span>}
      </div>
    </div>
  );
}

/**
 * The top of the agent page, on every tab: avatar, name, role and model;
 * the status (when the overview has loaded); Chat, Beat now, Pause and the
 * overflow menu.
 */
export function AgentHeader({ who, o, now = new Date(), busy = false, act, menu = [], aside }: {
  who: { name: string; emoji: string; colors: string; role: string; model: string };
  o: AgentOverview | null; now?: Date; busy?: boolean; act: DashboardActions | null;
  menu?: HeaderMenuItem[];
  /** A line under the role (chief of staff of…, ratings). */
  aside?: React.ReactNode;
}) {
  const s = o?.status;
  const hb = o?.heartbeat;
  const paused = s?.state === 'paused' && (s.memberStatus === 'paused' || !o?.inCompany);
  const canPause = Boolean(o && (o.inCompany || hb));
  const pauseLabel = o?.inCompany ? (s?.memberStatus === 'paused' ? 'Resume' : 'Pause') : hb?.enabled ? 'Pause heartbeat' : 'Resume heartbeat';
  return (
    <header data-testid="agent-header" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
        <Avatar emoji={who.emoji} colors={who.colors} size={46} />
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-.3px', ...oneLine }}>{who.name}</h1>
          <div style={{ ...dim, marginTop: 2, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span>{(o?.agent.title && o.agent.title !== who.name ? o.agent.title : '') || who.role || 'Durable agent'}</span>
            {(who.model || o?.agent.model) && <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-faint)', ...oneLine }}>{who.model || o?.agent.model}</span>}
          </div>
          {aside}
        </div>
        {act && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button style={chipBtn(true)} onClick={() => act.chat()}>Chat</button>
            <button style={chipBtn()} disabled={busy || paused || !o} onClick={() => act.beatNow()} title="Run the heartbeat now: it checks for reasons and runs a turn only if it finds some">Beat now</button>
            {canPause && <button style={chipBtn()} disabled={busy} onClick={() => act.togglePause()}>{pauseLabel}</button>}
            <OverflowMenu items={menu} />
          </div>
        )}
      </div>
      {o && act ? <StatusBlock o={o} now={now} act={act} compact={false} /> : <div style={{ ...faint, minHeight: 22 }}>Loading its status…</div>}
    </header>
  );
}

// ---- signals ----

function Signals({ list, onPick, active }: { list: Signal[]; onPick: (s: Signal) => void; active: WorkTab | null }) {
  return (
    <div data-testid="agent-signals" role="group" aria-label="Signals" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
      {list.map((g) => {
        const off = g.level === 'warn' || g.level === 'bad';
        const c = LEVEL_COLOR[g.level];
        const pressed = active !== null && g.target === active && g.id !== 'wip';
        return (
          <button key={g.id} data-testid={`signal-${g.id}`} data-level={g.level} aria-pressed={pressed} onClick={() => onPick(g)}
            title={`${g.label}: ${g.value}, ${g.note}`}
            style={{
              ...linkish, padding: '9px 11px', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 1,
              border: `1px solid ${off ? tint(c, 45) : pressed ? 'var(--text-faint)' : 'var(--border)'}`,
              background: off ? tint(c, 10) : 'var(--panel)',
            }}>
            <span style={{ fontSize: 11.5, color: off ? c : 'var(--text-dim)', fontWeight: 600 }}>{g.label}</span>
            <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.4px', color: off ? c : g.level === 'quiet' && g.value === '0' ? 'var(--text-faint)' : 'var(--text)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>{g.value}</span>
            <span style={{ ...faint, color: off ? c : 'var(--text-faint)', ...oneLine }}>{g.note}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- needs you ----

const NEED_WORD: Record<NeedsYouItem['kind'], string> = { action: 'Queued action', connection: 'Wants your connection', escalation: 'Escalated to you', approval: 'Asks for approval' };

function NeedsYou({ items, now, act }: { items: NeedsYouItem[]; now: Date; act: DashboardActions }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>) => { setBusy(id); try { await fn(); } finally { setBusy(null); } };
  return (
    <Section title="Needs you" count={items.length} testId="section-needs-you">
      <ul style={{ ...panel, margin: 0, padding: 0, borderColor: tint('var(--amber)', 55), background: tint('var(--amber)', 6) }}>
        {items.map((n, i) => (
          <li key={n.id} data-testid="needs-you-row" style={{ listStyle: 'none', padding: '9px 12px', borderTop: i === 0 ? 'none' : `1px solid ${tint('var(--amber)', 25)}`, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                {n.sessionId || n.taskId
                  ? <button style={{ ...linkish, fontSize: 13, fontWeight: 600, ...oneLine }} onClick={() => (n.taskId ? act.openTask({ id: n.taskId, source: 'org' }) : act.openSession(n.sessionId!))}>{n.title}</button>
                  : <span style={{ fontSize: 13, fontWeight: 600, ...oneLine }}>{n.title}</span>}
              </div>
              <div style={{ ...faint, ...oneLine }}>{NEED_WORD[n.kind]}, {when(n.at, now)}{n.detail ? `: ${n.detail}` : ''}</div>
            </div>
            <span style={{ display: 'flex', gap: 6, flex: 'none' }}>
              {n.kind === 'action' && n.eventId && <>
                <button style={smallBtn('primary')} disabled={busy === n.id} onClick={() => void run(n.id, () => act.actOnEvent(n.eventId!, 'approve'))}>Approve</button>
                <button style={smallBtn()} disabled={busy === n.id} onClick={() => void run(n.id, () => act.actOnEvent(n.eventId!, 'dismiss'))}>Dismiss</button>
              </>}
              {n.kind === 'connection' && n.eventId && <>
                <button style={smallBtn('good')} disabled={busy === n.id} onClick={() => void run(n.id, () => act.decideEvent(n.eventId!, 'allow'))}>Allow</button>
                <button style={smallBtn('bad')} disabled={busy === n.id} onClick={() => void run(n.id, () => act.decideEvent(n.eventId!, 'deny'))}>Deny</button>
              </>}
              {(n.kind === 'escalation' || n.kind === 'approval') && <button style={smallBtn('primary')} onClick={() => act.openApprovals()}>Decide</button>}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- work ----

const WORK_LABEL: Record<WorkTab, string> = { now: 'Now', blocked: 'Blocked', next: 'Up next', reviews: 'Reviews', done: 'Done' };
const STATUS_WORD: Record<string, string> = { in_progress: 'in progress', in_review: 'in review', claimed: 'claimed', todo: 'to do', waiting: 'waiting', doing: 'doing', blocked: 'blocked', done: 'done' };

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return <span style={{ fontSize: 11, fontWeight: 600, color: color ?? 'var(--text-dim)', border: `1px solid ${color ? tint(color, 50) : 'var(--border)'}`, borderRadius: 999, padding: '0 8px', flex: 'none', whiteSpace: 'nowrap', lineHeight: '18px' }}>{children}</span>;
}

function taskMeta(t: OverviewTask, now: Date, tab: WorkTab): string {
  if (tab === 'done') return `done ${when(t.updatedAt, now)}${t.acceptedBy ? `, accepted by ${t.acceptedBy}` : ''}`;
  if (t.dueAt) return `${Date.parse(t.dueAt) < now.getTime() ? 'overdue, was due' : 'due'} ${when(t.dueAt, now)}`;
  if (tab === 'now' && t.startedAt) return `started ${when(t.startedAt, now)}`;
  return `updated ${when(t.updatedAt, now)}`;
}

function TaskDetail({ t, now, act, children }: { t: OverviewTask; now: Date; act: DashboardActions; children?: React.ReactNode }) {
  return (
    <div data-testid="work-detail" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0 4px', fontSize: 12.5 }}>
      {t.outcome && <Clamped text={t.outcome} style={{ color: 'var(--text)' }} />}
      {t.doneWhen && <div style={dim}><span style={{ fontWeight: 600, color: 'var(--text)' }}>Done when</span> <Clamped text={t.doneWhen} style={{ display: 'inline' }} /></div>}
      {t.lastComment && (
        <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 9 }}>
          <span style={{ ...faint, display: 'block' }}>{t.lastComment.from}, {when(t.lastComment.at, now)}</span>
          <Clamped text={t.lastComment.text} lines={2} />
        </div>
      )}
      {t.files.length > 0 && (
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {t.files.map((f) => <button key={f} onClick={() => act.openFile(f)} style={{ ...chipBtn(), padding: '2px 8px', fontSize: 11, fontFamily: 'var(--mono)', fontWeight: 500, maxWidth: '100%', ...oneLine }}>{f}</button>)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {children}
        <button style={smallBtn()} onClick={() => act.openTask(t)}>{t.source === 'org' ? 'Open task' : 'Open in Tasks'}</button>
      </div>
    </div>
  );
}

function BlockedActions({ b, act, teammates, ask }: { b: OverviewBlocked; act: DashboardActions; teammates: Array<{ id: string; name: string }>; ask: boolean }) {
  const [mode, setMode] = useState<'none' | 'answer' | 'reassign'>(ask ? 'answer' : 'none');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const onYou = b.blocker.waitsOn.kind === 'ceo';
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); setMode('none'); setText(''); } finally { setBusy(false); } };
  if (b.source !== 'org') return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {onYou && <button style={smallBtn('primary')} onClick={() => act.openApprovals()}>Decide</button>}
        <button style={smallBtn(!onYou && mode !== 'answer' ? 'primary' : 'plain')} onClick={() => setMode(mode === 'answer' ? 'none' : 'answer')} aria-expanded={mode === 'answer'}>Answer</button>
        {teammates.length > 0 && <button style={smallBtn()} onClick={() => setMode(mode === 'reassign' ? 'none' : 'reassign')} aria-expanded={mode === 'reassign'}>Reassign</button>}
      </div>
      {mode === 'answer' && (
        <form style={{ display: 'flex', gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) void run(() => act.comment(b.id, text.trim())); }}>
          <input autoFocus={ask} aria-label={`Answer on ${b.title}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer goes on the task and wakes the agent" style={{ flex: 1, minWidth: 0, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12.5, outline: 'none' }} />
          <button type="submit" style={smallBtn('primary')} disabled={busy || !text.trim()}>Send</button>
        </form>
      )}
      {mode === 'reassign' && (
        <select aria-label={`Reassign ${b.title}`} defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void run(() => act.reassign(b.id, e.target.value)); }}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 9px', color: 'var(--text)', fontSize: 12.5, maxWidth: '100%' }}>
          <option value="">Reassign to…</option>
          {teammates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
    </div>
  );
}

function WorkRow({ t, tab, index, now, act, open, onToggle, teammates, compact }: {
  t: OverviewTask | OverviewBlocked; tab: WorkTab; index: number; now: Date; act: DashboardActions; open: boolean; onToggle: (ask?: boolean) => void;
  teammates: Array<{ id: string; name: string }>; compact: boolean;
}) {
  const [ask, setAsk] = useState(false);
  const b = 'blocker' in t ? t : null;
  const waits = b ? waitsOnWords(b.blocker.waitsOn) : '';
  const onYou = b?.blocker.waitsOn.kind === 'ceo';
  const reason = b?.blocker.reason.trim() ?? '';
  const toggle = () => (compact ? act.openTask(t) : onToggle());
  return (
    <li data-testid="work-row" data-id={t.id} style={{ listStyle: 'none', borderTop: index === 0 ? 'none' : '1px solid var(--border-soft)', padding: '0 12px' }}>
      <div style={{ display: 'flex', gap: 9, alignItems: 'center', padding: '8px 0', minWidth: 0 }}>
        {tab === 'next' && <span style={{ ...faint, width: 14, flex: 'none', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>}
        <button style={{ ...linkish, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }} onClick={toggle} aria-expanded={compact ? undefined : open}>
          <span style={{ fontSize: 13, fontWeight: 600, display: 'block', ...oneLine }}>{t.title}</span>
          <span style={{ ...faint, display: 'block', ...oneLine }}>
            {b
              ? <>{reason ? <span style={{ color: 'var(--text-dim)' }}>{reason}</span> : <span style={{ color: 'var(--amber)' }}>no reason recorded</span>}{`, since ${when(b.blocker.since, now)}`}</>
              : tab === 'reviews' ? `${t.assigneeName ? `${t.assigneeName}'s task, ` : ''}${taskMeta(t, now, tab)}` : taskMeta(t, now, tab)}
          </span>
        </button>
        {b && !reason && !compact && b.source === 'org' && (
          <button style={{ ...smallBtn(), flex: 'none' }} onClick={() => { setAsk(true); onToggle(true); }}>Ask</button>
        )}
        {waits ? <Chip color={onYou ? 'var(--red)' : 'var(--amber)'}>{waits}</Chip>
          : tab === 'now' && t.status ? <Chip>{STATUS_WORD[t.status] ?? t.status}</Chip>
          : tab === 'next' && t.status === 'waiting' ? <Chip>waiting</Chip> : null}
      </div>
      {open && !compact && (
        <TaskDetail t={t} now={now} act={act}>
          {b && reason && <div style={{ ...dim, width: '100%', overflowWrap: 'anywhere' }}>{reason}</div>}
          {b && <BlockedActions b={b} act={act} teammates={teammates} ask={ask} />}
        </TaskDetail>
      )}
    </li>
  );
}

function WorkCard({ o, now, act, teammates, compact, tab, setTab }: {
  o: AgentOverview; now: Date; act: DashboardActions; teammates: Array<{ id: string; name: string }>; compact: boolean; tab: WorkTab; setTab: (t: WorkTab) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const lists: Record<WorkTab, OverviewTask[]> = { now: o.now ? [o.now] : [], blocked: o.blocked, next: o.queue, reviews: o.reviews, done: o.done };
  const tabs: WorkTab[] = (['now', 'blocked', 'next', 'reviews', 'done'] as WorkTab[]).filter((t) => t !== 'reviews' || o.reviews.length > 0 || tab === 'reviews');
  const rows = compact && tab === 'next' ? lists.next.slice(0, 3) : lists[tab];
  const empty: Record<WorkTab, string> = {
    now: o.status.live ? `Running a turn in ${o.status.live.sessionName || 'a conversation'}, not on a task.` : `Not on a task right now.${o.queue.length ? ` ${o.queue.length} up next.` : ''}`,
    blocked: 'Nothing blocked.', next: 'Nothing queued.', reviews: 'No reviews owed.', done: 'Nothing finished in the last two weeks.',
  };
  return (
    <section data-testid="section-work" aria-label="Work" style={{ ...panel, minWidth: 0, overflow: 'hidden' }}>
      <div role="tablist" aria-label="Work" style={{ display: 'flex', gap: 2, padding: '6px 6px 0', borderBottom: '1px solid var(--border-soft)', overflowX: 'auto' }}>
        {tabs.map((t) => {
          const n = lists[t].length;
          const sel = t === tab;
          const loud = t === 'blocked' && n > 0;
          return (
            <button key={t} role="tab" aria-selected={sel} data-testid={`work-tab-${t}`} onClick={() => { setTab(t); setOpen(null); }}
              style={{ ...linkish, padding: '6px 10px 8px', fontSize: 12.5, fontWeight: sel ? 650 : 500, whiteSpace: 'nowrap', color: sel ? 'var(--text)' : 'var(--text-dim)', borderBottom: sel ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -1 }}>
              {WORK_LABEL[t]}{t !== 'now' && n > 0 && <span style={{ marginLeft: 5, fontSize: 11, color: loud ? 'var(--amber)' : 'var(--text-faint)', fontWeight: 600 }}>{n}</span>}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={WORK_LABEL[tab]}>
        {rows.length === 0
          ? <div style={{ ...dim, padding: '12px 14px' }}>{empty[tab]}</div>
          : (
            <ul style={{ margin: 0, padding: 0 }}>
              {rows.map((t, i) => (
                <WorkRow key={`${t.source}:${t.id}`} t={t} tab={tab} index={i} now={now} act={act} compact={compact} teammates={teammates}
                  open={open === `${t.source}:${t.id}`} onToggle={(ask) => setOpen(ask || open !== `${t.source}:${t.id}` ? `${t.source}:${t.id}` : null)} />
              ))}
            </ul>
          )}
        {compact && tab === 'next' && lists.next.length > 3 && <div style={{ ...faint, padding: '0 12px 8px' }}>and {lists.next.length - 3} more</div>}
      </div>
    </section>
  );
}

// ---- activity ----

function Activity({ o, now, act }: { o: AgentOverview; now: Date; act: DashboardActions }) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [all, setAll] = useState(false);
  const merged = mergedActivity(o);
  if (merged.length === 0) return null;
  const present = new Set(merged.map(activityKind));
  const rows = merged.filter((a) => filter === 'all' || activityKind(a) === filter);
  const shown = all ? rows : rows.slice(0, ACTIVITY_CAP);
  return (
    <Section title="Activity" testId="section-activity" aside={
      <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {ACTIVITY_FILTERS.filter((f) => f.id === 'all' || present.has(f.id)).map((f) => (
          <button key={f.id} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setAll(false); }}
            style={{ ...linkish, fontSize: 11.5, padding: '2px 9px', borderRadius: 999, border: '1px solid var(--border)', color: filter === f.id ? 'var(--text)' : 'var(--text-dim)', background: filter === f.id ? 'var(--panel-2)' : 'none', fontWeight: filter === f.id ? 600 : 500 }}>{f.label}</button>
        ))}
      </div>
    }>
      <ul style={{ ...panel, margin: 0, padding: '2px 0' }}>
        {shown.map((a, i) => (
          <li key={a.id} data-testid="activity-row" style={{ listStyle: 'none', padding: '7px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)', fontSize: 12.5 }}>
            {a.runs ? (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', display: 'flex', gap: 8 }}><span style={{ flex: 1, ...oneLine }}>{a.title}</span><span style={{ ...faint, flex: 'none' }}>{when(a.at, now)}</span></summary>
                <ul style={{ margin: '6px 0 0', padding: 0 }}>
                  {a.runs.items.map((r) => <li key={r.id} style={{ listStyle: 'none', ...faint, padding: '2px 0', overflowWrap: 'anywhere' }}>{when(r.at, now)}: {r.detail || r.title}</li>)}
                </ul>
              </details>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <button style={{ ...linkish, flex: 1, ...oneLine, fontFamily: a.kind === 'file' ? 'var(--mono)' : undefined, fontSize: a.kind === 'file' ? 11.5 : undefined }} onClick={() => (a.kind === 'file' && a.ref ? act.openFile(a.ref.id) : act.openActivity(a))}>{a.title}</button>
                  <span style={{ ...faint, flex: 'none' }}>{when(a.at, now)}</span>
                </div>
                {a.detail && <div style={{ ...faint, ...clamp(1), overflowWrap: 'anywhere' }}>{a.detail}</div>}
              </>
            )}
          </li>
        ))}
      </ul>
      {rows.length > ACTIVITY_CAP && (
        <button style={{ ...linkish, ...faint, marginTop: 6, padding: '2px 2px', textDecoration: 'underline', textUnderlineOffset: 2 }} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </Section>
  );
}

// ---- the side column ----

function TeamRow({ t, now, act, label }: { t: TeamTile; now: Date; act: DashboardActions; label?: string }) {
  return (
    <li style={{ listStyle: 'none' }}>
      <button onClick={() => act.openAgent(t.id)} style={{ ...linkish, width: '100%', display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px' }} title={`${t.name}: ${STATE_WORD[t.state]}${t.lastBeatAt ? `, beat ${when(t.lastBeatAt, now)}` : ''}`}>
        <Avatar emoji={t.emoji} colors={t.colors} size={20} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, ...oneLine }}>{t.name}</span>
            {label && <span style={{ ...faint, flex: 'none' }}>{label}</span>}
          </span>
          <span style={{ ...faint, display: 'block', ...oneLine }}>{t.liveLabel || t.doing || t.title || 'Nothing in progress'}</span>
        </span>
        <span style={{ fontSize: 11, color: STATE_COLOR[t.state], fontWeight: 600, flex: 'none' }}>{STATE_WORD[t.state]}</span>
      </button>
    </li>
  );
}

function Sparkline({ series }: { series: Array<{ day: string; usd: number }> }) {
  if (series.length < 2) return null;
  const w = 120; const h = 26;
  const max = Math.max(...series.map((d) => d.usd), 0.0001);
  const pts = series.map((d, i) => `${((i / (series.length - 1)) * w).toFixed(1)},${(h - 2 - (d.usd / max) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg data-testid="spend-sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Spend per day, last 30 days" style={{ display: 'block', flex: 'none' }}>
      <polyline points={pts} fill="none" stroke="var(--text-dim)" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Meter({ value, cap, color }: { value: number; cap: number; color: string }) {
  const pct = cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : 0;
  return <span aria-hidden style={{ display: 'block', height: 5, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}><span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} /></span>;
}

function Health({ o, now, act }: { o: AgentOverview; now: Date; act: DashboardActions }) {
  const h = o.health;
  const cap = h.spend.monthCapUsd ?? 0;
  const month = h.spend.monthUsd;
  const ratio = cap > 0 && month !== null ? month / cap : 0;
  const hb = o.heartbeat;
  return (
    <Section title="Health" testId="section-health" id="agent-health">
      <div style={{ ...panel, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {h.errors.length > 0 ? (
          <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {h.errors.map((e, i) => (
              <li key={i} style={{ listStyle: 'none', fontSize: 12.5, color: e.kind === 'provider' ? 'var(--amber)' : 'var(--red)', overflowWrap: 'anywhere' }}>
                {e.message} <span style={faint}>{when(e.at, now)}</span>
                {e.sessionId && <>{' '}<button style={{ ...inlineLink, fontSize: 11.5 }} onClick={() => act.openSession(e.sessionId!)}>run</button></>}
                {e.taskId && <>{' '}<button style={{ ...inlineLink, fontSize: 11.5 }} onClick={() => act.openTask({ id: e.taskId!, source: 'org' })}>task</button></>}
              </li>
            ))}
          </ul>
        ) : <div style={{ fontSize: 12.5, color: 'var(--green)' }}>No errors in the last two days.</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0 }}>
              <div style={faint}>This month</div>
              <div style={{ fontSize: 15, fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: ratio >= 1 ? 'var(--red)' : ratio >= 0.8 ? 'var(--amber)' : 'var(--text)' }}>
                {usd(month ?? h.spend.d30Usd)}{cap ? <span style={{ ...faint, fontWeight: 400 }}> of {usd(cap)}</span> : month === null ? <span style={{ ...faint, fontWeight: 400 }}> in 30 days</span> : null}
              </div>
            </div>
            <Sparkline series={h.spend.series} />
          </div>
          {cap > 0 && month !== null && <Meter value={month} cap={cap} color={ratio >= 1 ? 'var(--red)' : ratio >= 0.8 ? 'var(--amber)' : 'var(--green)'} />}
          <div style={{ ...faint, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span>{usd(h.spend.todayUsd)} today</span>
            {month !== null && <span>{usd(h.spend.d30Usd)} in chats, 30 days</span>}
          </div>
        </div>

        <div style={{ ...faint, display: 'flex', flexDirection: 'column', gap: 3, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
          {hb ? (
            <>
              <span style={{ color: hb.enabled ? 'var(--text-dim)' : 'var(--amber)' }}>Heartbeat {hb.enabled ? cadenceText(hb.cron, hb.nextDueAt) : 'off'}</span>
              <span>{hb.runsToday} of {hb.dailyRunCap} runs today, last beat {hb.lastBeatAt ? when(hb.lastBeatAt, now) : 'never'}</span>
            </>
          ) : <span>No heartbeat</span>}
          {o.nextLoop && <span>Loop {o.nextLoop.name} {when(o.nextLoop.at, now)}</span>}
          <button style={{ ...linkish, ...faint, textDecoration: 'underline', textUnderlineOffset: 2, alignSelf: 'flex-start' }} onClick={() => act.openTab('Settings:Trust')}>Trust levels</button>
        </div>
      </div>
    </Section>
  );
}

function Side({ o, now, act }: { o: AgentOverview; now: Date; act: DashboardActions }) {
  const hasTeam = Boolean(o.team.manager || o.team.reports.length || o.team.humans.length);
  return (
    <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Section title="Team" testId="section-team">
        {hasTeam ? (
          <div style={{ ...panel, padding: '4px 0' }}>
            {o.team.manager && <ul style={{ margin: 0, padding: 0 }}><TeamRow t={o.team.manager} now={now} act={act} label="manager" /></ul>}
            {o.team.unit && <div style={{ ...faint, padding: '6px 10px 2px', borderTop: o.team.manager ? '1px solid var(--border-soft)' : 'none' }}>Leads {o.team.unit.name} (#{o.team.unit.slug})</div>}
            {o.team.reports.length > 0 && <ul style={{ margin: 0, padding: 0 }}>{o.team.reports.map((r) => <TeamRow key={r.id} t={r} now={now} act={act} />)}</ul>}
            {o.team.humans.map((hm) => <div key={hm.memberAccountId} style={{ ...faint, padding: '5px 10px' }}>A person{hm.title ? `, ${hm.title}` : ''}, reports here</div>)}
          </div>
        ) : <div style={{ ...panel, ...dim, padding: '10px 12px' }}>{o.inCompany ? 'No manager or reports.' : 'Not in a company: it works on its own.'}</div>}
      </Section>
      <Health o={o} now={now} act={act} />
      {o.goals.length > 0 && (
        <Section title="Goals it owns" count={o.goals.length} testId="section-goals">
          <ul style={{ ...panel, margin: 0, padding: '2px 0' }}>
            {o.goals.map((g, i) => {
              const c = g.rag === 'red' ? 'var(--red)' : g.rag === 'amber' ? 'var(--amber)' : g.rag === 'green' ? 'var(--green)' : 'var(--text-faint)';
              return (
                <li key={g.id} style={{ listStyle: 'none', padding: '7px 10px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, ...oneLine }} title={g.title}>{g.title}</span>
                    <span style={{ ...faint, flex: 'none' }}>{g.targetValue !== null && g.currentValue !== null ? `${g.currentValue} / ${g.targetValue} ${g.unitLabel}` : `${Math.round(g.progress * 100)}%`}</span>
                  </div>
                  <Meter value={g.progress} cap={1} color={c} />
                  {g.atRisk && g.atRiskReason && <div style={{ ...faint, color: 'var(--red)' }}>{g.atRiskReason}</div>}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {o.follows.length > 0 && (
        <Section title="Following" count={o.follows.length}>
          <ul style={{ ...panel, margin: 0, padding: '2px 0' }}>
            {o.follows.map((f, i) => (
              <li key={f.id} style={{ listStyle: 'none', padding: '6px 10px', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)' }}>
                <button style={{ ...linkish, fontSize: 12.5, fontWeight: 600, display: 'block', maxWidth: '100%', ...oneLine }} onClick={() => act.openFollow(f)}>{f.title || f.targetKind}</button>
                <div style={{ ...faint, ...oneLine }}>{f.attention || `${f.unseen} new`}{f.lastActivityAt ? `, ${when(f.lastActivityAt, now)}` : ''}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ---- the page ----

export function AgentDashboard({ o, now = new Date(), compact = false, busy = false, act, teammates = [], notesOpen = false, header = true }: {
  o: AgentOverview; now?: Date; compact?: boolean; busy?: boolean; act: DashboardActions;
  /** Who a blocked task can be reassigned to. */
  teammates?: Array<{ id: string; name: string }>;
  notesOpen?: boolean;
  /** The header with identity and quick actions; the agent page draws it above its tabs instead. */
  header?: boolean;
}) {
  const [tab, setTab] = useState<WorkTab>(() => defaultWorkTab(o));
  const [picked, setPicked] = useState<WorkTab | null>(null);
  const list = signals(o, now);
  const mates = teammates.filter((m) => m.id !== o.agentId);
  const pick = (g: Signal) => {
    if (g.target === 'health') {
      const el = typeof document !== 'undefined' ? document.getElementById('agent-health') : null;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setTab(g.target); setPicked(g.target);
  };
  const work = <WorkCard o={o} now={now} act={act} teammates={mates} compact={compact} tab={tab} setTab={(t) => { setTab(t); setPicked(t); }} />;

  if (compact) {
    return (
      <div data-testid="agent-dashboard" data-compact="true" style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <StatusBlock o={o} now={now} act={act} compact />
        <Signals list={list} onPick={pick} active={picked} />
        {work}
      </div>
    );
  }

  return (
    <div data-testid="agent-dashboard" style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {header && (
        <AgentHeader who={{ name: o.agent.name, emoji: o.agent.emoji, colors: o.agent.colors, role: o.agent.role, model: o.agent.model }} o={o} now={now} busy={busy} act={act} />
      )}
      <Signals list={list} onPick={pick} active={picked} />
      {o.partial.length > 0 && <div role="status" style={{ ...faint, color: 'var(--amber)' }}>Some sections could not load: {o.partial.join(', ')}.</div>}
      {o.needsYou.length > 0 && <NeedsYou items={o.needsYou} now={now} act={act} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <div style={{ flex: '999 1 400px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {work}
          <Activity o={o} now={now} act={act} />
        </div>
        <Side o={o} now={now} act={act} />
      </div>

      <details open={notesOpen} data-testid="agent-notes" style={{ ...panel, padding: '10px 14px' }}>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 650 }}>{o.agent.name}&apos;s notes <span style={{ ...faint, fontWeight: 400 }}>kept by the agent</span></summary>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          {o.dashboard.trim() ? <Markdown text={o.dashboard} /> : <div style={dim}>No notes yet. Ask {o.agent.name} in a chat to keep notes here; it updates them with the update_dashboard tool.</div>}
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

/** The agent page's data and actions: the overview, kept live, and every button wired to its route. */
export function useAgentPage(agentId: string, onOpenTab?: (tab: string) => void) {
  const app = useApp();
  const { data, error, reload } = useAgentOverview(agentId);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(t); }, []);
  const wsId = data?.workspaceId ?? app.workspaceId;
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) app.showToast(done); await reload(); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'That did not work'); } finally { setBusy(false); }
  };
  const openTab = (tab: string) => (onOpenTab ? onOpenTab(tab) : app.openAgent(agentId, tab));
  const o = data;
  const teammates = o ? app.agents.filter((a) => a.workspaceId === o.workspaceId && a.id !== o.agentId).map((a) => ({ id: a.id, name: a.name })) : [];
  const act: DashboardActions = {
    openTask: (t) => { if (t.source === 'org') { app.setMobileDetail(true); app.openOrgTask(t.id); } else openTab('Work:Tasks'); },
    openAgent: (id) => app.openAgent(id),
    openFile: (path) => app.openFile({ kind: 'workspace', id: wsId }, path),
    openFollow: (f) => { if (f.targetKind === 'task') app.openOrgTask(f.targetId); else app.go('inbox'); },
    openTab,
    openActivity: (a) => {
      if (a.ref?.type === 'task') app.openOrgTask(a.ref.id);
      else if (a.ref?.type === 'file') app.openFile({ kind: 'workspace', id: wsId }, a.ref.id);
    },
    openSession: (id) => app.openSession(id),
    chat: () => void app.newChat(agentId),
    beatNow: () => void run(async () => {
      const r = await api.beatNow(agentId);
      app.showToast(r.ran ? `Heartbeat ran: ${r.reasons.length} reason(s)` : r.reasons.length ? `Heartbeat ${r.status}: ${r.reasons.length} reason(s), no run` : `Nothing to do (${r.status})`);
    }),
    togglePause: () => { if (!o) return; void run(() => (o.inCompany
      ? (o.status.memberStatus === 'paused' ? api.resumeOrgMember(wsId, agentId) : api.pauseOrgMember(wsId, agentId))
      : api.updateHeartbeat(agentId, { enabled: !o.heartbeat?.enabled })), o.inCompany ? (o.status.memberStatus === 'paused' ? 'Resumed' : 'Paused') : o.heartbeat?.enabled ? 'Heartbeat paused' : 'Heartbeat resumed'); },
    comment: async (taskId, text) => { await run(() => api.commentOrgTask(wsId, taskId, text), 'Answer posted'); },
    reassign: async (taskId, to) => { await run(() => api.assignOrgTask(wsId, taskId, to), 'Reassigned'); },
    openApprovals: () => { app.setOrgFocus(null); app.setOrgUnitId(null); app.setOrgPane('approvals'); app.setMobileDetail(true); },
    actOnEvent: async (eventId, decision) => {
      await run(async () => {
        const res = await api.actOnAgentEvent(agentId, eventId, decision);
        app.showToast(decision === 'dismiss' ? 'Dismissed' : res.ok ? 'Approved: the action ran' : `Action failed: ${res.error ?? 'unknown error'}`);
      });
    },
    decideEvent: async (eventId, decision) => {
      await run(async () => {
        const res = await api.decideAgentEvent(agentId, eventId, decision);
        app.showToast(!res.resolved ? 'That request had already expired' : decision === 'allow' ? 'Allowed: the turn continues' : 'Denied');
      });
    },
  };
  return { o, error, reload, busy, now, act, teammates };
}

/** The org mission control's side panel: the agent's status, signals and work, compact. */
export function AgentOverviewPanel({ agentId, onOpenTab }: { agentId: string; compact?: boolean; onOpenTab?: (tab: string) => void }) {
  const { o, error, reload, busy, now, act, teammates } = useAgentPage(agentId, onOpenTab);
  if (!o) {
    return error
      ? <div role="alert" style={{ ...panel, padding: '12px 14px', fontSize: 12.5, color: 'var(--red)' }}>Could not load this agent&apos;s overview: {error.slice(0, 200)} <button style={{ ...chipBtn(), marginLeft: 8 }} onClick={() => void reload()}>Retry</button></div>
      : <div style={{ ...faint, padding: '12px 2px' }}>Loading…</div>;
  }
  return <AgentDashboard o={o} now={now} compact busy={busy} act={act} teammates={teammates} />;
}

/** The body of the agent page's Overview tab (the header is drawn above the tabs). */
export function AgentOverviewBody({ page }: { page: ReturnType<typeof useAgentPage> }) {
  const { o, error, reload, busy, now, act, teammates } = page;
  if (!o) {
    return error
      ? <div role="alert" style={{ ...panel, padding: '12px 14px', fontSize: 12.5, color: 'var(--red)' }}>Could not load this agent&apos;s overview: {error.slice(0, 200)} <button style={{ ...chipBtn(), marginLeft: 8 }} onClick={() => void reload()}>Retry</button></div>
      : <div style={{ ...faint, padding: '12px 2px' }}>Loading…</div>;
  }
  return <AgentDashboard o={o} now={now} busy={busy} act={act} teammates={teammates} header={false} />;
}
