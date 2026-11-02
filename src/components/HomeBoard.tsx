/**
 * HomeBoard — the owner's mission control, drawn from one HomeData
 * (docs/home.md). Presentational: everything it does goes out through the
 * props (an inline decision, a navigation), so web-tests render it with a
 * fixture and no store.
 *
 * Order is attention: the state of the company in one sentence, what needs
 * the owner, what happened since the last visit, goals at risk first, the
 * team with errors surfaced, then the quieter columns (activity, money and
 * health, what's coming up, recent files). Docked it is two columns; on a
 * phone one, in the same order.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { HomeActivityKind, HomeAgent, HomeData, HomeGoal, HomeNeed, HomeNeedAction } from '../lib/api';
import { ACTIVITY_FILTERS, NEED_KIND_LABEL, actionLabel, dayHeading, defaultSentence, greeting, headline, recommendationLine, splitPath, targetOf, needTarget, usd, when, type HomeTarget } from '../lib/home';
import { Markdown } from '../lib/md';
import { I, P } from '../lib/icons';

export interface HomeBoardProps {
  data: HomeData;
  /** Phone width: one column, tighter type. */
  narrow: boolean;
  /** Wide enough for the side column. */
  wide: boolean;
  /** The owner's first name or '' — the greeting. */
  name?: string;
  now?: Date;
  /** Needs-you cards with a decision in flight. */
  busy?: Set<string>;
  onAct: (need: HomeNeed, action: HomeNeedAction) => void;
  onOpen: (target: HomeTarget) => void;
  /** "All agents": the full directory. */
  onAllAgents: () => void;
  /** The empty-state calls to action. */
  onStartCompany?: () => void;
  onNewAgent?: () => void;
  onRetry?: () => void;
}

const SEV_COLOR: Record<HomeNeed['severity'], string> = { critical: 'var(--red)', high: 'var(--amber)', normal: 'var(--accent)' };
const RAG_COLOR: Record<HomeGoal['rag'], string> = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)', grey: 'var(--text-faint)' };
const RAG_WORD: Record<HomeGoal['rag'], string> = { red: 'At risk', amber: 'Watch', green: 'On track', grey: 'Not measured' };
const STATE_COLOR: Record<HomeAgent['state'], string> = { working: 'var(--blue)', idle: 'var(--green)', blocked: 'var(--amber)', paused: 'var(--text-faint)', error: 'var(--red)' };
const STATE_WORD: Record<HomeAgent['state'], string> = { working: 'Working', idle: 'Idle', blocked: 'Blocked', paused: 'Paused', error: 'Failing' };
const NEEDS_SHOWN = 6;

const btn = (kind: 'primary' | 'plain' | 'quiet' = 'plain'): CSSProperties => ({
  background: kind === 'primary' ? 'var(--accent)' : kind === 'quiet' ? 'none' : 'var(--panel-2)',
  color: kind === 'primary' ? '#fff' : 'var(--text)', border: kind === 'primary' || kind === 'quiet' ? 'none' : '1px solid var(--border)',
  borderRadius: 8, padding: kind === 'quiet' ? '6px 4px' : '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 32,
});
const link: CSSProperties = { background: 'none', border: 'none', color: 'var(--accent-hi)', cursor: 'pointer', padding: 0, fontSize: 12.5, fontWeight: 600, textAlign: 'left' };
const faint: CSSProperties = { color: 'var(--text-faint)', fontSize: 12 };
const dim: CSSProperties = { color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.5 };
const clamp = (lines: number): CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });

function Section({ id, title, count, action, children }: { id: string; title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`home-${id}`} data-testid={`home-${id}`} style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h2 id={`home-${id}`} style={{ fontSize: 15, fontWeight: 650, margin: 0, letterSpacing: '-.1px' }}>{title}</h2>
        {count !== undefined && count > 0 && <span style={faint}>{count}</span>}
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ ...dim, color: 'var(--text-faint)', padding: '12px 0' }}>{children}</div>;
}

function Avatar({ emoji, colors, size = 34, dot }: { emoji: string; colors: string; size?: number; dot?: string }) {
  let bg = 'linear-gradient(135deg,var(--accent),var(--blue))';
  try { const [a, b] = JSON.parse(colors) as [string, string]; bg = `linear-gradient(140deg,${a},${b})`; } catch { /* default */ }
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.3, background: bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5, flex: 'none', position: 'relative' }}>
      {emoji}
      {dot && <span aria-hidden style={{ position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, borderRadius: '50%', background: dot, border: '2px solid var(--panel)' }} />}
    </span>
  );
}

function Bar({ value, color, label }: { value: number; color: string; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden', flex: 1, minWidth: 40 }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
    </div>
  );
}

// ---- 1. the header ----

function Header({ data, narrow, name, now, onOpen }: Pick<HomeBoardProps, 'data' | 'narrow' | 'name' | 'onOpen'> & { now: Date }) {
  const c = data.company;
  const sentences = headline(data, now);
  return (
    <header data-testid="home-header" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...faint, fontSize: 13 }}>{greeting(now)}{name ? `, ${name}` : ''}.</div>
      <p data-testid="home-headline" style={{ margin: 0, fontSize: narrow ? 21 : 27, lineHeight: 1.28, fontWeight: 600, letterSpacing: narrow ? '-.3px' : '-.6px', maxWidth: 760, textWrap: 'balance', fontVariantNumeric: 'tabular-nums' } as CSSProperties}>
        {sentences.join(' ')}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {c ? (
          <>
            <span data-testid="home-mode" title={c.mode === 'autonomous' ? 'The chief of staff hires, reorganizes and allocates within caps on its own' : 'Structural changes wait for your decision'}
              style={{ fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text-dim)' }}>
              {c.mode === 'autonomous' ? 'Autonomous' : 'Supervised'}
            </span>
            <button data-testid="home-run-state" onClick={() => onOpen({ to: 'pane', pane: 'board' })} title="The kill switch lives in the Company header"
              style={{ fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
                border: `1px solid ${c.status === 'paused' ? 'var(--red)' : 'var(--border)'}`, background: c.status === 'paused' ? 'color-mix(in srgb, var(--red) 12%, transparent)' : 'var(--panel)', color: c.status === 'paused' ? 'var(--red)' : 'var(--text-dim)' }}>
              <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: c.status === 'paused' ? 'var(--red)' : 'var(--green)' }} />
              {c.status === 'paused' ? 'Paused: nothing runs until you resume' : 'Running'}
            </button>
            <span style={faint}>{c.chiefName ? `${c.chiefName} is chief of staff` : 'No chief of staff'}, {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}</span>
          </>
        ) : null}
        {data.partial.length > 0 && <span role="status" style={{ ...faint, color: 'var(--amber)' }}>Some parts didn't load: {data.partial.join(', ')}.</span>}
      </div>
    </header>
  );
}

// ---- 2. needs you ----

function NeedCard({ n, now, busy, onAct, onOpen }: { n: HomeNeed; now: Date; busy: boolean; onAct: HomeBoardProps['onAct']; onOpen: HomeBoardProps['onOpen'] }) {
  const rec = recommendationLine(n);
  const def = defaultSentence(n, now);
  const target = needTarget(n);
  return (
    <article data-testid="need-card" data-kind={n.kind} aria-busy={busy}
      style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderLeft: `3px solid ${SEV_COLOR[n.severity]}`, borderRadius: 12, padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0, opacity: busy ? 0.6 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', ...faint }}>
        <span style={{ fontWeight: 600, color: n.severity === 'normal' ? 'var(--text-dim)' : SEV_COLOR[n.severity] }}>{NEED_KIND_LABEL[n.kind]}</span>
        {n.requestedBy && <span>from {n.requestedBy}</span>}
        <span>{when(n.createdAt, now)}</span>
      </div>
      <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{n.title}</div>
      {n.detail && <div style={{ ...dim, ...clamp(3), overflowWrap: 'anywhere' }}>{n.detail}</div>}
      {(n.recommendation || rec) && (
        <div style={{ ...dim, fontSize: 12.5 }}>
          {rec}{n.recommendation ? <span style={{ color: 'var(--text)' }}> “{n.recommendation}”</span> : null}
        </div>
      )}
      {def && (
        <div data-testid="need-default" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5, color: n.defaultAction === 'approve' || n.defaultAction === 'apply' ? 'var(--amber)' : 'var(--text-dim)' }}>
          <I d={P.clock} size={13} />{def}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
        {n.actions.map((a, i) => (
          <button key={a} disabled={busy} onClick={() => onAct(n, a)} style={btn(i === 0 ? 'primary' : 'plain')}>{actionLabel(n, a)}</button>
        ))}
        {target && <button onClick={() => onOpen(target)} style={btn(n.actions.length ? 'quiet' : 'plain')}>{n.actions.length ? 'Details' : 'Review'}</button>}
      </div>
    </article>
  );
}

function NeedsYou({ data, now, busy, onAct, onOpen }: Pick<HomeBoardProps, 'data' | 'onAct' | 'onOpen'> & { now: Date; busy: Set<string> }) {
  const [all, setAll] = useState(false);
  const shown = all ? data.needs : data.needs.slice(0, NEEDS_SHOWN);
  const more = data.headline.needsYou - shown.length;
  return (
    <Section id="needs" title="Needs you" count={data.headline.needsYou}
      action={data.company ? <button style={link} onClick={() => onOpen({ to: 'inbox' })}>See all in Inbox</button> : undefined}>
      {data.needs.length === 0 ? (
        <div data-testid="needs-empty" style={{ border: '1px dashed var(--border)', borderRadius: 12, padding: '14px 16px', ...dim }}>
          You're clear. {data.company ? 'New decisions, keys and escalations land here first.' : 'Approvals your agents ask for land here first.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map((n) => <NeedCard key={n.id} n={n} now={now} busy={busy.has(n.id)} onAct={onAct} onOpen={onOpen} />)}
          {more > 0 && (
            <button style={{ ...link, padding: '4px 0' }} onClick={() => (data.needs.length > shown.length ? setAll(true) : onOpen({ to: 'inbox' }))}>
              {more} more {data.needs.length > shown.length ? '' : 'in the Inbox'}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

// ---- 3. since you were last here ----

function Recap({ data, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'>) {
  const r = data.recap;
  const [open, setOpen] = useState(false);
  const stat = (n: number | string, label: string, tone?: string) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 20, fontWeight: 650, letterSpacing: '-.3px', color: tone ?? 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{n}</div>
      <div style={faint}>{label}</div>
    </div>
  );
  const brief = r.brief?.text ?? '';
  return (
    <Section id="recap" title="Since you were last here">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 12, marginBottom: 14 }}>
        {stat(r.tasksDone, 'tasks done')}
        {stat(r.tasksBlocked, 'tasks blocked', r.tasksBlocked ? 'var(--amber)' : undefined)}
        {data.company && stat(r.decisionsCount, 'decided without you')}
        {stat(r.artifactsChanged, 'files changed')}
        {r.pulse && stat(r.pulse.score, r.pulse.breaches ? `pulse, ${r.pulse.breaches} breach${r.pulse.breaches === 1 ? '' : 'es'}` : 'pulse', r.pulse.score < 60 ? 'var(--amber)' : undefined)}
      </div>
      {r.decisions.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ ...faint, marginBottom: 6 }}>Decided without you</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {r.decisions.map((d, i) => {
              const t = targetOf(d.ref);
              return (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                  <span style={{ color: 'var(--text-faint)' }}>{d.kind === 'default' ? 'By default' : d.kind === 'delegate' ? 'By your delegate' : d.kind === 'auto' ? 'On its own' : 'Logged'}: </span>
                  {t ? <button style={{ ...link, fontWeight: 500, color: 'var(--text)' }} onClick={() => onOpen(t)}>{d.title}</button> : d.title}
                  {d.detail && <span style={{ color: 'var(--text-dim)' }}> — {d.detail}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {r.people.length > 0 && (
        <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {r.people.map((p, i) => (
            <span key={i} style={{ fontSize: 12, padding: '3px 9px', borderRadius: 20, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', color: p.kind === 'hire' ? 'var(--text)' : 'var(--text-dim)' }}>{p.title}</span>
          ))}
        </div>
      )}
      {r.brief ? (
        <div data-testid="home-brief" style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 15px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{data.company?.chiefName ? `${data.company.chiefName}'s brief` : 'The latest brief'}</span>
            <span style={faint}>{when(r.brief.at)}</span>
            <span style={{ flex: 1 }} />
            <button style={link} onClick={() => onOpen({ to: 'pane', pane: 'brief' })}>Open</button>
          </div>
          <div style={{ fontSize: 13, ...(open ? {} : { maxHeight: 180, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(#000 70%, transparent)', maskImage: 'linear-gradient(#000 70%, transparent)' }) }}>
            <Markdown text={brief} compact />
          </div>
          {brief.length > 400 && <button style={{ ...link, marginTop: 6 }} onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Show less' : 'Read the whole brief'}</button>}
        </div>
      ) : data.company ? <Empty>The chief of staff hasn't written a brief yet. It arrives at the company's brief hour.</Empty> : null}
    </Section>
  );
}

// ---- 4. goals ----

function Goals({ data, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'>) {
  if (!data.company) return null;
  return (
    <Section id="goals" title="Goals" count={data.goals.length} action={<button style={link} onClick={() => onOpen({ to: 'pane', pane: 'vision' })}>Vision and goals</button>}>
      {data.goals.length === 0 ? <Empty>No objectives yet. Set a vision and the chief of staff proposes objectives and key results.</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.goals.map((g) => (
            <div key={g.id} data-testid="home-goal" data-rag={g.rag} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: RAG_COLOR[g.rag], flex: 'none' }} />
                <button style={{ ...link, color: 'var(--text)', fontSize: 13.5, fontWeight: 600, overflowWrap: 'anywhere' }} onClick={() => onOpen({ to: 'pane', pane: 'vision', focus: { kind: 'goal', id: g.id } })}>{g.title}</button>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: RAG_COLOR[g.rag] }}>{RAG_WORD[g.rag]}</span>
                {g.confidence !== null && <span style={faint}>{Math.round(g.confidence * 100)}% confident</span>}
              </div>
              {g.atRiskReason && <div style={{ ...dim, fontSize: 12.5, marginLeft: 16 }}>{g.atRiskReason}</div>}
              <div style={{ marginLeft: 16, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {g.keyResults.map((k) => (
                  <div key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--text-dim)', flex: '1 1 50%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k.title}>{k.title}</span>
                    <Bar value={k.progress} color={RAG_COLOR[k.rag]} label={`${k.title} progress`} />
                    <span style={{ ...faint, flex: 'none', fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>
                      {k.currentValue !== null && k.targetValue !== null ? `${k.currentValue} / ${k.targetValue}${k.unitLabel ? ` ${k.unitLabel}` : ''}` : `${Math.round(k.progress * 100)}%`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- 5. team ----

function Team({ data, narrow, now, onOpen, onAllAgents }: Pick<HomeBoardProps, 'data' | 'narrow' | 'onOpen' | 'onAllAgents'> & { now: Date }) {
  const failing = data.team.filter((a) => a.state === 'error').length;
  return (
    <Section id="team" title="Team" count={data.team.length} action={<button style={link} onClick={onAllAgents}>All agents</button>}>
      {failing > 0 && <div role="alert" style={{ fontSize: 12.5, color: 'var(--red)', fontWeight: 600, marginBottom: 8 }}>{failing === 1 ? 'One agent is failing.' : `${failing} agents are failing.`} Fix them before they miss work.</div>}
      {data.team.length === 0 ? <Empty>No agents yet.</Empty> : (
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'repeat(auto-fill, minmax(min(100%, 230px), 1fr))', gap: 8 }}>
          {data.team.map((a) => (
            <button key={a.id} data-testid="team-agent" data-state={a.state} onClick={() => onOpen({ to: 'agent', agentId: a.id })}
              style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--panel)', color: 'var(--text)', border: `1px solid ${a.state === 'error' ? 'var(--red)' : 'var(--border)'}`, borderRadius: 11, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, font: 'inherit' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <Avatar emoji={a.emoji} colors={a.colors} dot={STATE_COLOR[a.state]} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: STATE_COLOR[a.state], flex: 'none' }}>{STATE_WORD[a.state]}</span>
                  </span>
                  <span style={{ ...faint, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.isChief ? 'Chief of staff' : a.title || 'Agent'}</span>
                </span>
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text-dim)', ...clamp(2), overflowWrap: 'anywhere' }}>
                {a.doing || (a.state === 'paused' ? 'Paused' : 'Nothing in progress')}
              </span>
              {a.errors.map((e, i) => (
                <span key={i} data-testid="agent-error" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--red)', background: 'color-mix(in srgb, var(--red) 10%, transparent)', borderRadius: 7, padding: '5px 8px', overflowWrap: 'anywhere', ...clamp(3) }}>
                  {e.message}
                </span>
              ))}
              <span style={{ ...faint, fontSize: 11.5 }}>
                {a.lastActiveAt ? `Active ${when(a.lastActiveAt, now)}` : 'Not active yet'}{a.lastBeatAt ? `, heartbeat ${when(a.lastBeatAt, now)}` : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- 6. activity ----

function Activity({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  const [filter, setFilter] = useState<'all' | HomeActivityKind>('all');
  const present = new Set(data.activity.map((a) => a.kind));
  const filters = ACTIVITY_FILTERS.filter((f) => f.id === 'all' || present.has(f.id));
  const rows = filter === 'all' ? data.activity : data.activity.filter((a) => a.kind === filter);
  return (
    <Section id="activity" title="Activity">
      {filters.length > 2 && (
        <div role="group" aria-label="Filter activity" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {filters.map((f) => (
            <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 20, cursor: 'pointer', border: '1px solid var(--border)', background: filter === f.id ? 'var(--text)' : 'var(--panel)', color: filter === f.id ? 'var(--bg)' : 'var(--text-dim)', fontWeight: 600 }}>
              {f.label}
            </button>
          ))}
        </div>
      )}
      {rows.length === 0 ? <Empty>Nothing yet this week.</Empty> : (
        <ol data-testid="activity-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((a) => {
            const t = targetOf(a.ref);
            return (
              <li key={a.id} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border-soft)' }}>
                <span style={{ ...faint, fontSize: 11.5, paddingTop: 1 }}>{when(a.at, now)}</span>
                <span style={{ minWidth: 0, fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                  {t ? <button style={{ ...link, color: 'var(--text)', fontWeight: 500, fontSize: 13 }} onClick={() => onOpen(t)}>{a.title}</button> : a.title}
                  {(a.actor || a.detail) && <span style={{ display: 'block', ...faint }}>{[a.actor, a.detail].filter(Boolean).join(': ')}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

// ---- 7. spend & health ----

function SpendHealth({ data, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'>) {
  const s = data.spend;
  const h = data.health;
  const cap = s.monthCapUsd ?? 0;
  const projectedOver = cap > 0 && (s.projectedUsd ?? 0) > cap;
  return (
    <Section id="spend" title="Spend and health" action={data.company ? <button style={link} onClick={() => onOpen({ to: 'pane', pane: 'spend' })}>Spend</button> : undefined}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <div><div style={{ fontSize: 18, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{usd(s.todayUsd)}</div><div style={faint}>today</div></div>
          <div><div style={{ fontSize: 18, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{usd(s.monthUsd)}</div><div style={faint}>{cap > 0 ? `of ${usd(cap)} this month` : 'this month'}</div></div>
        </div>
        {cap > 0 && (
          <div>
            <Bar value={(s.monthUsd ?? 0) / cap} color={s.forecastState === 'stop' ? 'var(--red)' : s.forecastState === 'warn' ? 'var(--amber)' : 'var(--green)'} label="Month spend against the envelope" />
            {s.projectedUsd !== null && <div style={{ ...faint, marginTop: 5, color: projectedOver ? 'var(--amber)' : 'var(--text-faint)' }}>On pace for {usd(s.projectedUsd)} by month end{projectedOver ? ', over the envelope' : ''}.</div>}
          </div>
        )}
        {s.tokens && <div style={{ ...faint, color: s.tokens.over ? 'var(--red)' : 'var(--text-faint)' }}>{Math.round(s.tokens.spent / 1000)}k of {Math.round(s.tokens.budget / 1000)}k tokens this month{s.tokens.over ? ': over budget, agents are stopped' : ''}.</div>}
        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: h.status === 'ok' ? 'var(--green)' : h.status === 'incident' ? 'var(--red)' : 'var(--amber)' }} />
            {h.status === 'ok' ? 'All systems normal' : h.status === 'incident' ? `${h.openIncidents.length} open incident${h.openIncidents.length === 1 ? '' : 's'}` : 'Degraded'}
          </div>
          {h.openIncidents.slice(0, 3).map((i) => (
            <button key={i.id} style={{ ...link, color: 'var(--text-dim)', fontWeight: 500 }} onClick={() => onOpen({ to: 'pane', pane: 'incidents', focus: { kind: 'incident', id: i.id } })}>{i.severity}: {i.title}</button>
          ))}
          {h.providers.map((p) => <div key={p.provider} style={{ fontSize: 12.5, color: 'var(--amber)', overflowWrap: 'anywhere' }}>{p.provider} is {p.state}{p.lastError ? `: ${p.lastError}` : ''}</div>)}
          {h.audit && (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
              <button style={{ ...link, fontWeight: 500 }} onClick={() => onOpen({ to: 'pane', pane: 'audit' })}>Last audit {when(h.audit.at)}</button>: {h.audit.findings === 0 ? 'no findings' : `${h.audit.findings} finding${h.audit.findings === 1 ? '' : 's'}`}
              {h.audit.top.map((f, i) => <div key={i} style={{ ...faint, overflowWrap: 'anywhere' }}>{f.severity ? `${f.severity}: ` : ''}{f.title}</div>)}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

// ---- 8. coming up ----

function ComingUp({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  const groups: Array<{ day: string; rows: HomeData['upcoming'] }> = [];
  for (const u of data.upcoming) {
    const day = dayHeading(u.at, now);
    const g = groups.at(-1);
    if (g && g.day === day) g.rows.push(u); else groups.push({ day, rows: [u] });
  }
  return (
    <Section id="upcoming" title="Coming up">
      {groups.length === 0 ? <Empty>{data.company ? 'No meetings, rituals or deadlines this week.' : 'No scheduled loops in the next day.'}</Empty> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groups.map((g) => (
            <div key={g.day}>
              <div style={{ ...faint, fontWeight: 600, marginBottom: 4 }}>{g.day}</div>
              {g.rows.map((u) => {
                const t = targetOf(u.ref);
                return (
                  <div key={u.id} style={{ display: 'grid', gridTemplateColumns: '68px minmax(0,1fr)', gap: 8, padding: '3px 0', fontSize: 13 }}>
                    <span style={{ ...faint, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{new Date(u.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      {t ? <button style={{ ...link, color: 'var(--text)', fontWeight: 500, fontSize: 13 }} onClick={() => onOpen(t)}>{u.title}</button> : u.title}
                      {u.detail && <span style={{ ...faint, color: u.detail === 'overdue' ? 'var(--red)' : 'var(--text-faint)' }}> {u.detail}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// ---- 9. recent artifacts ----

function Artifacts({ data, now, onOpen }: Pick<HomeBoardProps, 'data' | 'onOpen'> & { now: Date }) {
  return (
    <Section id="artifacts" title="Recent files">
      {data.artifacts.length === 0 ? <Empty>Files your agents write show up here.</Empty> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {data.artifacts.map((f) => {
            const { name, dir } = splitPath(f.path);
            return (
              <li key={f.path}>
                <button onClick={() => onOpen({ to: 'file', path: f.path })} style={{ width: '100%', display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: '6px 0', textAlign: 'left', font: 'inherit', minWidth: 0 }}>
                  <I d={P.file} size={15} stroke="var(--text-faint)" style={{ flex: 'none' }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    <span style={{ display: 'block', ...faint, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.updatedBy.name || f.updatedBy.kind} {f.version > 1 ? `edited v${f.version}` : 'created'} {when(f.updatedAt, now)}{dir ? ` in ${dir}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---- the board ----

export function HomeBoard(props: HomeBoardProps) {
  const { data, narrow, wide, name, onOpen, onAct, onAllAgents } = props;
  const now = props.now ?? new Date();
  const busy = props.busy ?? new Set<string>();
  const nothingYet = data.team.length === 0;
  const pad = narrow ? '20px 16px 40px' : '32px 32px 60px';
  const main = (
    <>
      <NeedsYou data={data} now={now} busy={busy} onAct={onAct} onOpen={onOpen} />
      <Recap data={data} onOpen={onOpen} />
      <Goals data={data} onOpen={onOpen} />
      {!wide && <Team data={data} narrow={narrow} now={now} onOpen={onOpen} onAllAgents={onAllAgents} />}
      <Activity data={data} now={now} onOpen={onOpen} />
    </>
  );
  const side = (
    <>
      {wide && <Team data={data} narrow={narrow} now={now} onOpen={onOpen} onAllAgents={onAllAgents} />}
      <SpendHealth data={data} onOpen={onOpen} />
      <ComingUp data={data} now={now} onOpen={onOpen} />
      <Artifacts data={data} now={now} onOpen={onOpen} />
    </>
  );
  return (
    <div data-testid="home-board" style={{ maxWidth: 1240, margin: '0 auto', padding: pad, display: 'flex', flexDirection: 'column', gap: narrow ? 26 : 32, minWidth: 0 }}>
      <Header data={data} narrow={narrow} name={name} onOpen={onOpen} now={now} />
      {nothingYet && (
        <div data-testid="home-start" style={{ border: '1px solid var(--border)', background: 'var(--panel)', borderRadius: 14, padding: narrow ? '18px 16px' : '22px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 650 }}>Start a company with a Chief of Staff</div>
          <div style={{ ...dim, maxWidth: 560 }}>Give it a vision and a monthly budget. The chief of staff proposes goals, hires specialists and brings you only the decisions that need you.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {props.onStartCompany && <button style={btn('primary')} onClick={props.onStartCompany}>Start a company</button>}
            {props.onNewAgent && <button style={btn()} onClick={props.onNewAgent}>Create one agent</button>}
          </div>
        </div>
      )}
      {!nothingYet && !data.company && props.onStartCompany && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', ...dim }}>
          <span>Your agents work one by one. A chief of staff can run them as a company, with goals and a budget.</span>
          <button style={link} onClick={props.onStartCompany}>Start a company</button>
        </div>
      )}
      {wide ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 380px)', gap: 40, alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, minWidth: 0 }}>{main}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 30, minWidth: 0 }}>{side}</div>
        </div>
      ) : (
        <>{main}{side}</>
      )}
    </div>
  );
}

/** While the first request is in flight, or after it failed. */
export function HomeStatus({ error, onRetry, narrow }: { error: string | null; onRetry?: () => void; narrow: boolean }) {
  return (
    <div data-testid="home-status" style={{ maxWidth: 1240, margin: '0 auto', padding: narrow ? '20px 16px' : '32px', width: '100%' }}>
      {error ? (
        <div role="alert" style={{ border: '1px solid var(--border)', background: 'var(--panel)', borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Home didn't load</div>
          <div style={{ ...dim, overflowWrap: 'anywhere' }}>{error}</div>
          {onRetry && <button style={btn()} onClick={onRetry}>Try again</button>}
        </div>
      ) : (
        <div aria-busy style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ height: 14, width: 140, borderRadius: 6, background: 'var(--panel-2)' }} />
          <div style={{ height: 30, width: 'min(560px, 100%)', borderRadius: 8, background: 'var(--panel-2)' }} />
          <div style={{ height: 120, borderRadius: 12, background: 'var(--panel)' , border: '1px solid var(--border)' }} />
        </div>
      )}
    </div>
  );
}
