/**
 * A task's own plan on screen (docs/task-execution.md "On screen"): the
 * mode, version, sessions and cost against the caps; every step with its
 * status, dependencies, tier, attempts, cost, the session that ran it, its
 * output and its exit criteria with evidence; the decision log; the handoff
 * packets; and the session tree (master → workers, lead → continuations)
 * whose worker transcripts stay collapsed until opened — like tool calls and
 * thinking elsewhere. Renders nothing when there is no plan. Shown in the
 * task drawer, under a run in the Work log and above a chat that has one.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type ChatMessage, type TaskPlanHandoffView, type TaskPlanStepView, type TaskPlanView } from '../lib/api';
import { Markdown } from '../lib/md';
import { fmtTokens } from '../lib/util';
import { EXEC_MODE_HINT, EXEC_MODE_WORD, ROLE_WORD, planIsLive, planStepTone, planSummary, planTone, sessionTone, sessionTree, usd, type SessionNode } from '../lib/task-plans';
import { Pill } from './CompanyKit';

export type TaskPlanSource = { kind: 'task'; wsId: string; taskId: string } | { kind: 'session'; sessionId: string };

const POLL_MS = 3_000;
const faint: React.CSSProperties = { fontSize: 11, color: 'var(--text-faint)' };
const box: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 };
const pre: React.CSSProperties = { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.5, background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '7px 9px', maxHeight: 280, overflowY: 'auto' };
const summary: React.CSSProperties = { cursor: 'pointer', fontSize: 12, display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' };

export function TaskPlanPanel({ source, collapsed = false }: { source: TaskPlanSource; collapsed?: boolean }) {
  const [view, setView] = useState<TaskPlanView | null>(null);
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
  return (
    <details data-testid="task-plan" open={!collapsed} style={box}>
      <summary style={{ ...summary, fontSize: 12.5 }}>
        <b>Plan</b>
        <span title={EXEC_MODE_HINT[p.mode]}>{EXEC_MODE_WORD[p.mode] ?? p.mode}{p.dynamic ? ' · dynamic' : ''}</span>
        <span style={faint}>v{p.version}</span>
        <Pill tone={planTone(p.status)}>{p.status}</Pill>
        <span style={{ ...faint, marginLeft: 'auto' }} data-testid="task-plan-summary">{planSummary(view)} · {fmtTokens(p.tokensIn + p.tokensOut)} tok</span>
      </summary>
      <div style={faint}>
        {EXEC_MODE_HINT[p.mode]} Caps: {p.caps.maxSessions} sessions, {p.caps.maxParallel} at once{p.caps.planUsdCap > 0 ? `, ${usd(p.caps.planUsdCap)}` : ''}.{p.note ? ` ${p.note}.` : ''}
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {view.steps.map((s) => <StepRow key={s.id} s={s} />)}
      </ol>
      {view.decisions.length > 0 && (
        <details data-testid="task-plan-decisions">
          <summary style={summary}><span style={{ fontWeight: 600 }}>Decisions</span><span style={faint}>{view.decisions.length} · every session honours them</span></summary>
          <ul style={{ margin: '5px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {view.decisions.map((d, i) => <li key={i}>{d.text}{d.proposed && <span style={faint}> · proposed by a parallel step</span>}{d.stepId && <span style={faint}> · {d.stepId}</span>}</li>)}
          </ul>
        </details>
      )}
      {view.handoffs.length > 0 && (
        <details data-testid="task-plan-handoffs">
          <summary style={summary}><span style={{ fontWeight: 600 }}>Handoffs</span><span style={faint}>{view.handoffs.length}</span></summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 5 }}>{view.handoffs.map((h, i) => <Handoff key={i} h={h} />)}</div>
        </details>
      )}
      <details data-testid="task-plan-sessions">
        <summary style={summary}><span style={{ fontWeight: 600 }}>Sessions</span><span style={faint}>{view.sessions.length}</span></summary>
        <ul style={{ listStyle: 'none', margin: '5px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {sessionTree(view.sessions).map((n) => <SessionRow key={n.s.sessionId} n={n} steps={view.steps} />)}
        </ul>
      </details>
      {view.versions.length > 1 && (
        <details>
          <summary style={summary}><span style={{ fontWeight: 600 }}>Versions</span><span style={faint}>{view.versions.length}</span></summary>
          <ul style={{ margin: '5px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {view.versions.map((v) => <li key={v.version}>v{v.version}: {v.reason} <span style={faint}>— {v.diff.join('; ')}</span></li>)}
          </ul>
        </details>
      )}
    </details>
  );
}

function StepRow({ s }: { s: TaskPlanStepView }) {
  const meta = [s.dependsOn.length ? `after ${s.dependsOn.join(', ')}` : '', s.parallel ? 'parallel-safe' : '', s.tier ?? '', s.attempts > 1 ? `attempt ${s.attempts}` : '', s.optional ? 'optional' : ''].filter(Boolean).join(' · ');
  return (
    <li data-testid="task-plan-step" data-step={s.id} data-status={s.status}>
      <details>
        <summary style={summary}>
          <Pill tone={planStepTone(s.status)}>{s.status}</Pill>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s.id}</span>
          <span style={{ fontSize: 12.5 }}>{s.title}</span>
          {meta && <span style={faint}>{meta}</span>}
          <span style={{ ...faint, marginLeft: 'auto' }}>{s.tokensIn + s.tokensOut > 0 ? `${fmtTokens(s.tokensIn + s.tokensOut)} tok · ${usd(s.usd)}` : s.ready ? 'ready' : ''}</span>
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, margin: '6px 0 2px 4px', fontSize: 12 }}>
          <div>{s.goal}</div>
          {s.inputs.length > 0 && <div style={faint}>Needs: {s.inputs.join('; ')}</div>}
          <div>
            <div style={faint}>Exit criteria</div>
            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
              {s.exit.map((c, i) => { const r = s.criteria[i]; return <li key={i}>{r ? (r.met ? '✓ ' : '✗ ') : ''}{c}{r?.evidence && <span style={faint}> — {r.evidence}</span>}</li>; })}
            </ul>
          </div>
          {s.output && <><div style={faint}>Output{s.model ? ` · ${s.model}` : ''}</div><div style={{ fontSize: 12.5, lineHeight: 1.55 }}><Markdown text={s.output} compact /></div></>}
          {s.questions.length > 0 && <div style={faint}>Open questions: {s.questions.join('; ')}</div>}
          {s.artifacts.length > 0 && <div style={faint}>Artifacts: {s.artifacts.join(', ')}</div>}
          {s.note && <div style={faint}>Master's note: {s.note}</div>}
        </div>
      </details>
    </li>
  );
}

function Handoff({ h }: { h: TaskPlanHandoffView }) {
  return (
    <div style={{ borderLeft: '2px solid var(--accent-dim)', paddingLeft: 9, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={faint}>{h.stepId ? `step ${h.stepId} · ` : ''}{h.createdAt.slice(0, 16).replace('T', ' ')}</div>
      <div><b>State:</b> {h.state}</div>
      {h.decisions.length > 0 && <div><b>Decisions:</b> {h.decisions.join('; ')}</div>}
      {h.artifacts.length > 0 && <div><b>Artifacts:</b> {h.artifacts.join(', ')}</div>}
      {h.questions.length > 0 && <div><b>Open:</b> {h.questions.join('; ')}</div>}
      <div><b>Next:</b> {h.next}</div>
    </div>
  );
}

function SessionRow({ n, steps }: { n: SessionNode; steps: TaskPlanStepView[] }) {
  const s = n.s;
  const step = s.stepId ? steps.find((x) => x.id === s.stepId) : undefined;
  return (
    <li data-testid="task-plan-session" data-role={s.role} style={{ marginLeft: s.depth > 0 ? 14 : 0 }}>
      {s.role === 'worker' ? (
        <WorkerTranscript sessionId={s.sessionId} head={<SessionHead n={n} step={step?.title} />} />
      ) : <div style={summary}><SessionHead n={n} /></div>}
      {n.children.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {n.children.map((c) => <SessionRow key={c.s.sessionId} n={c} steps={steps} />)}
        </ul>
      )}
    </li>
  );
}

function SessionHead({ n, step }: { n: SessionNode; step?: string }) {
  const s = n.s;
  return (
    <>
      <span style={{ fontWeight: 600 }}>{ROLE_WORD[s.role] ?? s.role}</span>
      {s.stepId && <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{s.stepId}</span>}
      {step && <span>{step}</span>}
      <Pill tone={sessionTone(s.status)} plain>{s.status.replace('_', ' ')}</Pill>
      {s.error && <span style={{ ...faint, color: 'var(--red)' }}>{s.error.slice(0, 120)}</span>}
      <span style={{ ...faint, marginLeft: 'auto' }}>{s.model ? `${s.model} · ` : ''}{fmtTokens(s.tokensIn + s.tokensOut)} tok · {usd(s.usd)}</span>
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
    <details data-testid="worker-transcript" onToggle={onToggle}>
      <summary style={summary}>{head}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 2px 6px', paddingLeft: 9, borderLeft: '1px solid var(--border-soft)' }}>
        {msgs === null ? <div style={faint}>Loading the transcript…</div>
          : msgs === 'error' ? <div style={{ ...faint, color: 'var(--red)' }}>Could not load this session.</div>
            : msgs.length === 0 ? <div style={faint}>Nothing yet.</div>
              : msgs.map((m) => m.role === 'tool' || m.role === 'thinking' || m.role === 'user' ? (
                <details key={m.id}>
                  <summary style={{ ...summary, ...faint, fontWeight: 600 }}>{m.role === 'tool' ? <span style={{ fontFamily: 'var(--mono)' }}>{m.toolName ?? 'tool'}</span> : m.role === 'thinking' ? 'Thinking' : 'Prompt'}</summary>
                  <pre style={{ ...pre, marginTop: 4 }}>{m.content}</pre>
                </details>
              ) : <div key={m.id} style={{ fontSize: 12.5, lineHeight: 1.55 }}><Markdown text={m.content} compact /></div>)}
      </div>
    </details>
  );
}
