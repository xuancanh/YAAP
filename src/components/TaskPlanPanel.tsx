/**
 * A task's own plan on screen (docs/task-execution.md "On screen"). The
 * header is the glance: mode, status, steps done, cost against the cap. The
 * body is a compact step list grouped into stages (a step's stage is one past
 * its latest dependency, so steps of a stage run side by side) — status,
 * dependencies, tier, attempts, cost — each opening to its goal, exit criteria
 * with evidence, output and notes. The session tree (master → workers, lead →
 * continuations, worker transcripts folded until opened), the decision log,
 * the handoff packets and the versions sit behind tabs. Renders nothing when
 * there is no plan. Shown in the task drawer, under a run in the Work log and
 * above a chat that has one.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type ChatMessage, type TaskPlanHandoffView, type TaskPlanStepView, type TaskPlanView } from '../lib/api';
import { Markdown } from '../lib/md';
import { fmtTokens } from '../lib/util';
import { EXEC_MODE_HINT, EXEC_MODE_WORD, ROLE_WORD, attemptWord, planIsLive, planSummary, planTone, sessionTone, sessionTree, stepStages, stepStatusWord, usd, type SessionNode } from '../lib/task-plans';
import { Bar, Pill } from './CompanyKit';
import { TierBadge } from './ModelKit';
import '../styles/models.css';

export type TaskPlanSource = { kind: 'task'; wsId: string; taskId: string } | { kind: 'session'; sessionId: string };
type Tab = 'steps' | 'sessions' | 'decisions' | 'handoffs' | 'history';

const POLL_MS = 3_000;
const when = (iso: string) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

export function TaskPlanPanel({ source, collapsed = false }: { source: TaskPlanSource; collapsed?: boolean }) {
  const [view, setView] = useState<TaskPlanView | null>(null);
  const [tab, setTab] = useState<Tab>('steps');
  const key = source.kind === 'task' ? `${source.wsId}:${source.taskId}` : source.sessionId;
  const load = useCallback(async () => {
    let v: TaskPlanView | { plan: null } | null;
    try { v = await (source.kind === 'task' ? api.orgTaskPlan(source.wsId, source.taskId) : api.sessionTaskPlan(source.sessionId)); } catch { v = null; }
    setView(v && v.plan ? (v as TaskPlanView) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  const live = view ? planIsLive(view) : false;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);
  if (!view) return null;
  const p = view.plan;
  const required = view.steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failed = view.steps.filter((s) => s.status === 'failed').length;
  const tabs: Array<{ id: Tab; label: string; n?: number }> = [
    { id: 'steps', label: 'Steps', n: view.steps.length },
    { id: 'sessions', label: 'Sessions', n: view.sessions.length },
    ...(view.decisions.length ? [{ id: 'decisions' as const, label: 'Decisions', n: view.decisions.length }] : []),
    ...(view.handoffs.length ? [{ id: 'handoffs' as const, label: 'Handoffs', n: view.handoffs.length }] : []),
    ...(view.versions.length > 1 ? [{ id: 'history' as const, label: 'History', n: view.versions.length }] : []),
  ];
  const shown = tabs.some((t) => t.id === tab) ? tab : 'steps';
  return (
    <details data-testid="task-plan" open={!collapsed} className="tp">
      <summary className="tp-head">
        <svg className="tp-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <b className="tp-title">Plan</b>
        <span className="tp-mode" title={EXEC_MODE_HINT[p.mode]}>{EXEC_MODE_WORD[p.mode] ?? p.mode}</span>
        <Pill tone={planTone(p.status)}>{p.status}</Pill>
        {failed > 0 && <Pill tone="bad" plain>{failed} failed</Pill>}
        <span className="tp-progress" aria-hidden><Bar value={required.length ? done / required.length : 0} tone={p.status === 'done' ? 'ok' : undefined} label="Steps done" /></span>
        <span className="tp-sum co-num" data-testid="task-plan-summary">{planSummary(view)}</span>
      </summary>
      <div className="tp-body">
        <div className="tp-meta">
          <span>{EXEC_MODE_HINT[p.mode]}{p.dynamic ? ' The plan may change as it goes.' : ''}</span>
          <span className="tp-caps co-num" data-testid="task-plan-caps">
            <span title="Sessions used of the cap">{p.sessions} of {p.caps.maxSessions} sessions</span>
            <span>up to {p.caps.maxParallel} at once</span>
            {p.caps.planUsdCap > 0
              ? <span className="tp-cost" title="Cost against the plan's cap">{usd(p.usd)} of {usd(p.caps.planUsdCap)}<Bar value={p.usd / p.caps.planUsdCap} tone={p.usd / p.caps.planUsdCap > 0.85 ? 'warn' : undefined} label="Plan cost against its cap" width={54} /></span>
              : <span>{usd(p.usd)}</span>}
            <span>{fmtTokens(p.tokensIn + p.tokensOut)} tokens</span>
            <span>v{p.version}</span>
          </span>
          {p.note && <span className="co-faint">{p.note}</span>}
        </div>
        <div className="co-seg tp-tabs" role="tablist" aria-label="Plan details">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={shown === t.id} onClick={() => setTab(t.id)} data-testid={`task-plan-tab-${t.id}`}>
              {t.label}{t.n !== undefined && <span className="tp-n">{t.n}</span>}
            </button>
          ))}
        </div>
        {shown === 'steps' && <Steps steps={view.steps} />}
        {shown === 'sessions' && (
          <ul className="tp-sessions" data-testid="task-plan-sessions">
            {sessionTree(view.sessions).map((n) => <SessionRow key={n.s.sessionId} n={n} steps={view.steps} />)}
          </ul>
        )}
        {shown === 'decisions' && (
          <ul className="tp-list" data-testid="task-plan-decisions">
            {view.decisions.map((d, i) => (
              <li key={i}>
                <span>{d.text}</span>
                <span className="co-faint">{[d.proposed ? 'proposed by a parallel step' : 'every session honours it', d.stepId ? `step ${d.stepId}` : ''].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
        {shown === 'handoffs' && (
          <div className="tp-handoffs" data-testid="task-plan-handoffs">{view.handoffs.map((h, i) => <Handoff key={i} h={h} />)}</div>
        )}
        {shown === 'history' && (
          <ul className="tp-list" data-testid="task-plan-versions">
            {view.versions.map((v) => <li key={v.version}><span><b>v{v.version}</b> {v.reason}</span><span className="co-faint">{v.diff.join('; ')}</span></li>)}
          </ul>
        )}
      </div>
    </details>
  );
}

/** The steps grouped by stage: a stage with more than one step runs side by side. */
function Steps({ steps }: { steps: TaskPlanStepView[] }) {
  const stages = stepStages(steps);
  const groups: TaskPlanStepView[][] = [];
  for (const s of steps) (groups[stages.get(s.id) ?? 0] ??= []).push(s);
  const multi = groups.filter(Boolean).length > 1;
  return (
    <ol className="tp-stages">
      {groups.filter(Boolean).map((g, i) => (
        <li key={i} className="tp-stage">
          {multi && <div className="tp-stage-label">Stage {i + 1}{g.length > 1 && g.every((s) => s.parallel) ? ' · side by side' : ''}</div>}
          <ol className="tp-steps">{g.map((s) => <StepRow key={s.id} s={s} />)}</ol>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ s }: { s: TaskPlanStepView }) {
  const k = s.status === 'pending' && s.ready ? 'ready' : s.status;
  const glyph = k === 'done' ? <path d="M7 12.5l3.2 3.2L17 9" /> : k === 'failed' ? <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /> : k === 'interrupted' ? <path d="M12 7.5v5.5M12 16.5v.01" /> : k === 'skipped' ? <path d="M8 12h8" /> : null;
  return (
    <span className={`tp-icon s-${k}`} aria-hidden>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9.5" strokeWidth="1.8" />{glyph}
        {k === 'running' && <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />}
      </svg>
    </span>
  );
}

function StepRow({ s }: { s: TaskPlanStepView }) {
  const word = stepStatusWord(s);
  const met = s.criteria.filter((c) => c.met).length;
  return (
    <li data-testid="task-plan-step" data-step={s.id} data-status={s.status} className={`tp-step s-${s.status}`}>
      <details>
        <summary>
          <StepIcon s={s} />
          <span className="co-sr">{word}</span>
          <span className="tp-step-main">
            <span className="tp-step-title"><span className="co-key">{s.id}</span>{s.title}{s.optional && <span className="co-faint"> · optional</span>}</span>
            <span className="tp-step-meta" data-testid="task-plan-step-meta">
              <span className={`tp-word s-${s.status === 'pending' && s.ready ? 'ready' : s.status}`}>{word}</span>
              {s.dependsOn.length > 0 && <span>after {s.dependsOn.join(', ')}</span>}
              {attemptWord(s.attempts) && <span className="tp-warn">{attemptWord(s.attempts)}</span>}
              {s.exit.length > 0 && s.criteria.length > 0 && <span>{met}/{s.exit.length} criteria met</span>}
            </span>
          </span>
          {s.tier && <TierBadge tier={s.tier} />}
          <span className="tp-step-cost co-num">{s.tokensIn + s.tokensOut > 0 ? usd(s.usd) : ''}</span>
        </summary>
        <div className="tp-step-detail">
          <p className="tp-goal">{s.goal}</p>
          <dl className="co-dl tp-dl">
            {s.inputs.length > 0 && <><dt>Needs</dt><dd>{s.inputs.join('; ')}</dd></>}
            {s.exit.length > 0 && (
              <>
                <dt>Done when</dt>
                <dd>
                  <ul className="tp-criteria">
                    {s.exit.map((c, i) => {
                      const r = s.criteria[i];
                      return <li key={i} className={r ? (r.met ? 'met' : 'unmet') : ''}><span aria-label={r ? (r.met ? 'met' : 'not met') : 'not checked yet'}>{r ? (r.met ? '✓' : '✗') : '○'}</span>{c}{r?.evidence && <span className="co-faint"> — {r.evidence}</span>}</li>;
                    })}
                  </ul>
                </dd>
              </>
            )}
            {(s.model || s.tokensIn + s.tokensOut > 0) && <><dt>Ran on</dt><dd className="co-num">{[s.model, s.tokensIn + s.tokensOut > 0 ? `${fmtTokens(s.tokensIn + s.tokensOut)} tokens · ${usd(s.usd)}` : '', s.parallel ? 'parallel-safe' : ''].filter(Boolean).join(' · ')}</dd></>}
            {s.note && <><dt>Master&apos;s note</dt><dd>{s.note}</dd></>}
            {s.questions.length > 0 && <><dt>Open questions</dt><dd>{s.questions.join('; ')}</dd></>}
            {s.artifacts.length > 0 && <><dt>Artifacts</dt><dd>{s.artifacts.join(', ')}</dd></>}
          </dl>
          {s.output && <div className="tp-output"><div className="co-faint">Output</div><Markdown text={s.output} compact /></div>}
        </div>
      </details>
    </li>
  );
}

function Handoff({ h }: { h: TaskPlanHandoffView }) {
  return (
    <div className="tp-handoff">
      <div className="co-faint">{h.stepId ? `Step ${h.stepId} · ` : ''}{when(h.createdAt)}</div>
      <dl className="co-dl tp-dl">
        <dt>State</dt><dd>{h.state}</dd>
        {h.decisions.length > 0 && <><dt>Decisions</dt><dd>{h.decisions.join('; ')}</dd></>}
        {h.artifacts.length > 0 && <><dt>Artifacts</dt><dd>{h.artifacts.join(', ')}</dd></>}
        {h.questions.length > 0 && <><dt>Open</dt><dd>{h.questions.join('; ')}</dd></>}
        <dt>Next</dt><dd>{h.next}</dd>
      </dl>
    </div>
  );
}

function SessionRow({ n, steps }: { n: SessionNode; steps: TaskPlanStepView[] }) {
  const s = n.s;
  const step = s.stepId ? steps.find((x) => x.id === s.stepId) : undefined;
  return (
    <li data-testid="task-plan-session" data-role={s.role} className={s.depth > 0 ? 'tp-child' : ''}>
      {s.role === 'worker' ? (
        <WorkerTranscript sessionId={s.sessionId} head={<SessionHead n={n} step={step?.title} foldable />} />
      ) : <div className="tp-session-head"><SessionHead n={n} /></div>}
      {n.children.length > 0 && (
        <ul className="tp-sessions nested">
          {n.children.map((c) => <SessionRow key={c.s.sessionId} n={c} steps={steps} />)}
        </ul>
      )}
    </li>
  );
}

function SessionHead({ n, step, foldable }: { n: SessionNode; step?: string; foldable?: boolean }) {
  const s = n.s;
  return (
    <>
      <b>{ROLE_WORD[s.role] ?? s.role}</b>
      {s.stepId && <span className="co-key">{s.stepId}</span>}
      {step && <span className="tp-session-step">{step}</span>}
      <Pill tone={sessionTone(s.status)} plain>{s.status.replace('_', ' ')}</Pill>
      <span className="tp-session-end co-num">{s.model ? `${s.model} · ` : ''}{fmtTokens(s.tokensIn + s.tokensOut)} tok · {usd(s.usd)}</span>
      {foldable && <span className="co-faint tp-open">transcript</span>}
      {s.error && <span className="tp-error">{s.error.slice(0, 160)}</span>}
    </>
  );
}

/** A worker's transcript, fetched when first opened; its thinking and tool
 *  calls folded again inside. */
function WorkerTranscript({ sessionId, head }: { sessionId: string; head: React.ReactNode }) {
  const [msgs, setMsgs] = useState<ChatMessage[] | null | 'error'>(null);
  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open || msgs) return;
    void api.transcript(sessionId).then((t) => setMsgs(t.messages)).catch(() => setMsgs('error'));
  };
  return (
    <details data-testid="worker-transcript" className="tp-worker" onToggle={onToggle}>
      <summary className="tp-session-head">{head}</summary>
      <div className="tp-transcript">
        {msgs === null ? <div className="co-faint">Loading the transcript…</div>
          : msgs === 'error' ? <div className="tp-error">Could not load this session.</div>
            : msgs.length === 0 ? <div className="co-faint">Nothing yet.</div>
              : msgs.map((m) => m.role === 'tool' || m.role === 'thinking' || m.role === 'user' ? (
                <details key={m.id} className="tp-fold">
                  <summary>{m.role === 'tool' ? <span className="tp-tool">{m.toolName ?? 'tool'}</span> : m.role === 'thinking' ? 'Thinking' : 'Prompt'}</summary>
                  <pre>{m.content}</pre>
                </details>
              ) : <div key={m.id} className="tp-msg"><Markdown text={m.content} compact /></div>)}
      </div>
    </details>
  );
}
