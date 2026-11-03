/**
 * The agent's Work log (docs/work-log.md): its own runs — heartbeat, loops,
 * org task runs, meeting rounds, channel wakes — as a timeline grouped by
 * trigger. Each run expands to its internal thinking, every tool call with
 * input and output, the files it wrote, tokens and cost, its outcome and a
 * link to its task. Filters (trigger, outcome, task, dates), search, paging.
 * The human chat keeps only the conversation; the thinking lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type WorkLogFilters, type WorkLogGroup, type WorkOutcome, type WorkRun, type WorkRunDetail, type WorkTrigger } from '../lib/api';
import { Markdown } from '../lib/md';
import { fmtTokens } from '../lib/util';

const PAGE = 30;

export const OUTCOME_COLOR: Record<WorkOutcome, string> = {
  done: 'var(--green)', blocked: 'var(--amber)', error: 'var(--red)', stopped: 'var(--text-faint)', running: 'var(--accent)',
};
export const TRIGGER_LABEL: Record<WorkTrigger, string> = {
  heartbeat: 'Heartbeat', loop: 'Loop', task: 'Task', meeting: 'Meeting', channel: 'Channel', org: 'Org', app: 'Mini app', other: 'Other',
};

const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12 };
const faint: React.CSSProperties = { fontSize: 11, color: 'var(--text-faint)' };
const chip = (on: boolean): React.CSSProperties => ({
  fontSize: 11.5, padding: '3px 10px', borderRadius: 999, border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
  background: on ? 'var(--accent-dim)' : 'none', color: on ? 'var(--text)' : 'var(--text-dim)', fontWeight: on ? 600 : 500, cursor: 'pointer', whiteSpace: 'nowrap',
});
const input: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12, padding: '5px 9px', outline: 'none', minWidth: 0 };
const pre: React.CSSProperties = { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.5, background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '7px 9px', maxHeight: 320, overflowY: 'auto' };

function fmtUsd(n: number | null): string {
  if (n === null) return '';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
/** The one line a run reads as: its answer, else its prompt. */
function headline(r: WorkRun): string {
  const text = (r.answer || r.input || '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}
function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

type Filters = Pick<WorkLogFilters, 'trigger' | 'key' | 'outcome' | 'task' | 'session' | 'from' | 'to' | 'q'>;

export function WorkLogTab({ agentId }: { agentId: string }) {
  const app = useApp();
  const [filters, setFilters] = useState<Filters>({});
  const [search, setSearch] = useState('');
  const [runs, setRuns] = useState<WorkRun[]>([]);
  const [groups, setGroups] = useState<WorkLogGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Record<string, WorkRunDetail | 'loading' | 'error'>>({});
  /** A run a link asked for that is not on the loaded page. */
  const [linked, setLinked] = useState<WorkRun | null>(null);
  const expandFirst = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async (f: Filters, after: string | null) => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.workLog(agentId, { ...f, limit: PAGE, cursor: after });
      if (mine !== seq.current) return;
      setRuns((prev) => (after ? [...prev, ...page.runs.filter((r) => !prev.some((x) => x.id === r.id))] : page.runs));
      setGroups(page.groups);
      setCursor(page.nextCursor);
      if (!after && expandFirst.current && page.runs[0]) {
        expandFirst.current = false;
        setOpen(new Set([page.runs[0].id]));
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message.slice(0, 200) : 'Could not load the work log');
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [agentId]);

  // a link (a work session, a run) focuses the log once
  const focus = app.workLogFocus;
  useEffect(() => {
    if (!focus || focus.agentId !== agentId) return;
    app.clearWorkLogFocus();
    setSearch('');
    setLinked(null);
    if (focus.turnId) {
      setFilters({});
      setOpen(new Set([focus.turnId]));
      void api.workRun(agentId, focus.turnId).then((d) => { setDetails((x) => ({ ...x, [d.id]: d })); setLinked(d); }).catch(() => undefined);
    } else if (focus.sessionId) {
      expandFirst.current = true;
      setFilters({ session: focus.sessionId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, agentId]);

  // search is debounced into the filters
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => ((f.q ?? '') === search.trim() ? f : { ...f, q: search.trim() || undefined })), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { void load(filters, null); }, [filters, load]);

  const toggle = (id: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!details[id]) {
      setDetails((x) => ({ ...x, [id]: 'loading' }));
      void api.workRun(agentId, id).then((d) => setDetails((x) => ({ ...x, [id]: d }))).catch(() => setDetails((x) => ({ ...x, [id]: 'error' })));
    }
  };
  // a run opened by a link loads its detail too
  useEffect(() => {
    for (const id of open) {
      if (!details[id]) {
        setDetails((x) => ({ ...x, [id]: 'loading' }));
        void api.workRun(agentId, id).then((d) => setDetails((x) => ({ ...x, [id]: d }))).catch(() => setDetails((x) => ({ ...x, [id]: 'error' })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  const set = (patch: Partial<Filters>) => setFilters((f) => {
    const next = { ...f, ...patch };
    for (const k of Object.keys(next) as Array<keyof Filters>) if (next[k] === undefined || next[k] === '') delete next[k];
    return next;
  });
  const total = groups.reduce((n, g) => n + g.count, 0);
  const sessionName = filters.session ? (runs[0]?.sessionName ?? 'one session') : '';
  const shown = linked && !runs.some((r) => r.id === linked.id) ? [linked, ...runs] : runs;
  const byDay = useMemo(() => {
    const out: Array<{ day: string; runs: WorkRun[] }> = [];
    for (const r of shown) {
      const day = dayOf(r.createdAt);
      const last = out.at(-1);
      if (last && last.day === day) last.runs.push(r); else out.push({ day, runs: [r] });
    }
    return out;
  }, [shown]);

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="work-log">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Work log</span>
        <span style={faint}>its own runs, their thinking and tool calls — conversations stay in Chats</span>
        <input aria-label="Search the work log" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search runs…" style={{ ...input, marginLeft: 'auto', width: 190 }} />
      </div>

      {/* trigger groups: one chip per heartbeat, loop, task, meeting, channel */}
      <div role="group" aria-label="Filter by trigger" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        <button aria-pressed={!filters.trigger} onClick={() => set({ trigger: undefined, key: undefined })} style={chip(!filters.trigger)}>All{total ? ` · ${total}` : ''}</button>
        {groups.map((g) => {
          const on = filters.trigger === g.trigger && (filters.key ?? '') === g.key;
          return (
            <button key={`${g.trigger}:${g.key}`} aria-pressed={on} title={`${TRIGGER_LABEL[g.trigger]} · last ${dayOf(g.lastAt)}`}
              onClick={() => (on ? set({ trigger: undefined, key: undefined }) : set({ trigger: g.trigger, key: g.key }))} style={chip(on)}>
              {g.label} · {g.count}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={faint}>Outcome{' '}
          <select aria-label="Outcome" value={filters.outcome ?? ''} onChange={(e) => set({ outcome: e.target.value || undefined })} style={input}>
            <option value="">any</option>
            {(['done', 'blocked', 'error', 'stopped', 'running'] as const).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label style={faint}>Task{' '}
          <input aria-label="Task" value={filters.task ?? ''} onChange={(e) => set({ task: e.target.value.trim() || undefined })} placeholder="ENG-12" style={{ ...input, width: 90 }} />
        </label>
        <label style={faint}>From{' '}<input aria-label="From" type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} style={input} /></label>
        <label style={faint}>To{' '}<input aria-label="To" type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} style={input} /></label>
        {filters.session && (
          <button onClick={() => set({ session: undefined })} title="Show every run" style={chip(true)}>{sessionName} ×</button>
        )}
      </div>

      {error && <div role="alert" style={{ ...card, padding: '10px 14px', fontSize: 12.5, color: 'var(--red)' }}>{error}</div>}
      {!error && !loading && shown.length === 0 && (
        <div style={{ ...card, padding: 18, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {Object.keys(filters).length ? 'No runs match.' : 'No runs yet. Heartbeats, scheduled loops, task runs and meetings show up here as the agent works.'}
        </div>
      )}

      {byDay.map((d) => (
        <div key={d.day}>
          <div style={{ ...faint, fontWeight: 600, margin: '4px 2px 6px' }}>{d.day}</div>
          <ul style={{ ...card, margin: 0, padding: '2px 0', listStyle: 'none' }}>
            {d.runs.map((r, i) => (
              <RunRow key={r.id} r={r} first={i === 0} open={open.has(r.id)} onToggle={() => toggle(r.id)} detail={details[r.id]} agentId={agentId} />
            ))}
          </ul>
        </div>
      ))}

      {cursor && (
        <button type="button" disabled={loading} onClick={() => void load(filters, cursor)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 12, fontWeight: 600, padding: '4px 2px', cursor: loading ? 'default' : 'pointer' }}>
          {loading ? 'Loading…' : 'Load more runs'}
        </button>
      )}
      {loading && !cursor && shown.length === 0 && <div style={faint}>Loading…</div>}
    </div>
  );
}

function RunRow({ r, first, open, onToggle, detail, agentId }: { r: WorkRun; first: boolean; open: boolean; onToggle: () => void; detail?: WorkRunDetail | 'loading' | 'error'; agentId: string }) {
  const app = useApp();
  const openTask = () => {
    if (!r.task) return;
    if (r.task.kind === 'org') { app.setMobileDetail(true); app.openOrgTask(r.task.id); } else app.openAgent(agentId, 'Work:Tasks');
  };
  return (
    <li data-testid="work-run" data-run={r.id} style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)' }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer', minWidth: 0 }}>
        <span title={r.outcome} aria-label={`outcome ${r.outcome}`} style={{ width: 8, height: 8, borderRadius: '50%', background: OUTCOME_COLOR[r.outcome], flex: 'none' }} />
        <span style={{ ...faint, flex: 'none', fontFamily: 'var(--mono)' }}>{timeOf(r.createdAt)}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 6, padding: '0 7px', flex: 'none', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.outcome === 'error' ? 'var(--red)' : 'var(--text)' }}>
          {r.outcome === 'error' && r.error ? r.error : headline(r) || '(no answer)'}
        </span>
        <span style={{ ...faint, flex: 'none' }}>
          {r.steps > 0 ? `${r.steps} step${r.steps === 1 ? '' : 's'} · ` : ''}{fmtTokens(r.tokensIn + r.tokensOut)} tok{r.usd !== null ? ` · ${fmtUsd(r.usd)}` : ''}
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: OUTCOME_COLOR[r.outcome], flex: 'none', textTransform: 'uppercase', letterSpacing: '.4px' }}>{r.outcome}</span>
      </div>
      {open && (
        <div style={{ padding: '2px 12px 12px 29px', display: 'flex', flexDirection: 'column', gap: 9 }} data-testid="work-run-detail">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', ...faint }}>
            <span>{TRIGGER_LABEL[r.trigger]}</span>
            <span>{r.tokensIn.toLocaleString()} in · {r.tokensOut.toLocaleString()} out{r.model ? ` · ${r.model}` : ''}</span>
            {r.usd !== null && <span>{fmtUsd(r.usd)}</span>}
            {r.task && <button onClick={openTask} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{[r.task.key, r.task.title].filter(Boolean).join(' ')} →</button>}
            {r.archived && <span>archived session</span>}
          </div>
          {r.outcome === 'error' && r.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{r.error}</div>}
          {detail === 'loading' || detail === undefined ? <div style={faint}>Loading the run…</div>
            : detail === 'error' ? <div style={{ ...faint, color: 'var(--red)' }}>Could not load this run.</div>
              : <RunDetail d={detail} agentId={agentId} />}
        </div>
      )}
    </li>
  );
}

function RunDetail({ d, agentId }: { d: WorkRunDetail; agentId: string }) {
  const app = useApp();
  const ws = app.agents.find((a) => a.id === agentId)?.workspaceId || app.workspaceId;
  const openPath = (path: string) => {
    if (path.startsWith('/')) app.openFile({ kind: 'workspace', id: ws }, path.slice(1));
    else app.openFile({ kind: 'agent', id: agentId }, path.replace(/^~\//, ''));
  };
  let call = 0;
  return (
    <>
      <details>
        <summary style={{ cursor: 'pointer', ...faint, fontWeight: 600 }}>Prompt</summary>
        <pre style={{ ...pre, marginTop: 5 }}>{d.input}</pre>
      </details>
      {d.messages.filter((m) => m.role !== 'user').map((m) => {
        if (m.role === 'thinking') {
          return (
            <div key={m.id} data-testid="work-thinking">
              <div style={{ ...faint, fontWeight: 600, marginBottom: 3 }}>Thinking</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic', whiteSpace: 'pre-wrap', lineHeight: 1.55, borderLeft: '2px solid var(--border)', paddingLeft: 9 }}>{m.content}</div>
            </div>
          );
        }
        if (m.role === 'tool') {
          const rec = d.toolCalls[call++];
          return (
            <details key={m.id} data-testid="work-tool">
              <summary style={{ cursor: 'pointer', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{m.toolName ?? rec?.tool ?? 'tool'}</span>
                {rec?.isError && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>ERROR</span>}
                {rec?.approved && rec.approved !== 'allow-once' && <span style={faint}>{rec.approved}</span>}
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 5 }}>
                {rec && <><div style={faint}>Input</div><pre style={pre}>{stringify(rec.input)}</pre></>}
                <div style={faint}>Output</div>
                <pre style={pre}>{m.content}</pre>
              </div>
            </details>
          );
        }
        return <div key={m.id} style={{ fontSize: 13, lineHeight: 1.6 }}><Markdown text={m.content} compact /></div>;
      })}
      {d.files.length > 0 && (
        <div>
          <div style={{ ...faint, fontWeight: 600, marginBottom: 3 }}>Files written</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {d.files.map((f) => (
              <button key={`${f.op}:${f.path}`} onClick={() => openPath(f.path)} title={`${f.op} ${f.path}`}
                style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text)', cursor: 'pointer' }}>
                {f.op === 'write' ? '' : `${f.op} `}{f.path}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
