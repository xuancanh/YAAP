/**
 * The agent's Work log (docs/work-log.md): its own runs — heartbeat, loops,
 * org task runs, meeting rounds, channel wakes — as a timeline grouped by
 * trigger. Each run expands to its internal thinking, every tool call with
 * input and output, the files it wrote, tokens and cost, its outcome and a
 * link to its task. Filters (trigger, outcome, task, dates), search, paging.
 * The human chat keeps only the conversation; the thinking lives here.
 *
 * Intervening (docs/work-log.md "Intervening"): a running run expands live
 * (its stream watched through GET /api/chats/:id/live, polled when that
 * instance cannot be reached), with Stop and inline approvals; a composer
 * messages the agent in that work session (queued for the next turn while
 * one runs); Continue in chat opens the session in the chat view; a failed
 * or stopped run can Rerun. Viewers read only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type LiveItem } from '../store';
import { api, watchSession, type ApprovalDecision, type WorkLogFilters, type WorkLogGroup, type WorkOutcome, type WorkRun, type WorkRunDetail, type WorkTrigger } from '../lib/api';
import { Markdown } from '../lib/md';
import { fmtTokens } from '../lib/util';
import { applyWatchEvent, liveSteps } from '../lib/work-live';
import { ToolCard } from './ChatView';

const PAGE = 30;
/** How often a hot log (a run in progress, a message waiting) refreshes. */
const HOT_POLL_MS = 3_000;
/** How often a running run is re-read when its stream cannot be watched. */
const RUN_POLL_MS = 2_000;

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
const actionBtn = (tone: 'plain' | 'danger' | 'primary' = 'plain'): React.CSSProperties => ({
  background: tone === 'primary' ? 'var(--accent)' : 'none', color: tone === 'danger' ? 'var(--red)' : tone === 'primary' ? '#fff' : 'var(--text)',
  border: `1px solid ${tone === 'danger' ? 'var(--red)' : tone === 'primary' ? 'var(--accent)' : 'var(--border)'}`,
  borderRadius: 7, padding: '3px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none',
});
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer', fontSize: 11, fontWeight: 600 };

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
/** The summary fields of a run detail (to update its row). */
function stripDetail(d: WorkRunDetail): WorkRun {
  const { messages: _m, toolCalls: _t, ...run } = d;
  void _m; void _t;
  return run;
}

/** "you" or the person's name, for a run a person sent. */
function useWho() {
  const app = useApp();
  return (by: string | undefined): string => {
    const me = app.me;
    if (!me) return 'you';
    const actor = by || me.ownerAccountId || '';
    if (actor === me.actorId) return 'you';
    return app.nameOf?.(actor) || 'a person';
  };
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

  const fetchDetail = useCallback((id: string) => {
    setDetails((x) => ({ ...x, [id]: 'loading' }));
    void api.workRun(agentId, id).then((d) => setDetails((x) => ({ ...x, [id]: d }))).catch(() => setDetails((x) => ({ ...x, [id]: 'error' })));
  }, [agentId]);
  const toggle = (id: string) => {
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    if (!details[id]) fetchDetail(id);
  };
  // a run opened by a link (or opened live) loads its detail too
  useEffect(() => {
    for (const id of open) if (!details[id]) fetchDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentId]);

  /** Re-read the first page, keeping what Load more fetched: new runs join
   *  the top, known ones update in place (a run finishing, a rerun starting). */
  const refresh = useCallback(async () => {
    const mine = seq.current;
    try {
      const p = await api.workLog(agentId, { ...filters, limit: PAGE });
      if (mine !== seq.current) return;
      setRuns((prev) => {
        const byId = new Map(p.runs.map((r) => [r.id, r]));
        const fresh = p.runs.filter((r) => !prev.some((x) => x.id === r.id));
        return [...fresh, ...prev.map((r) => byId.get(r.id) ?? r)];
      });
      setGroups(p.groups);
    } catch { /* the next poll tries again */ }
  }, [agentId, filters]);
  const reloadRun = useCallback((id: string) => {
    void api.workRun(agentId, id).then((d) => {
      setDetails((x) => ({ ...x, [id]: d }));
      setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, ...stripDetail(d) } : r)));
      setLinked((l) => (l && l.id === id ? d : l));
    }).catch(() => undefined);
  }, [agentId]);
  /** Open a run by id (a rerun's original, a new rerun), loading it if needed. */
  const focusRun = useCallback((id: string) => {
    setOpen((s) => new Set(s).add(id));
    if (!runs.some((r) => r.id === id)) {
      void api.workRun(agentId, id).then((d) => { setDetails((x) => ({ ...x, [d.id]: d })); setLinked(d); }).catch(() => undefined);
    }
  }, [agentId, runs]);

  // Live: a run in progress opens by itself (once), and while anything is in
  // progress or a message waits for its turn, the log keeps itself fresh.
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    const running = runs.filter((r) => r.outcome === 'running' && !autoOpened.current.has(r.id));
    if (running.length === 0) return;
    for (const r of running) autoOpened.current.add(r.id);
    setOpen((s) => { const n = new Set(s); for (const r of running) n.add(r.id); return n; });
  }, [runs]);
  const [kick, setKick] = useState(0);
  const sessionsHere = useMemo(() => new Set(runs.map((r) => r.sessionId).concat(filters.session ? [filters.session] : [])), [runs, filters.session]);
  const waiting = (app.queueAll ?? []).some((q) => sessionsHere.has(q.sessionId)) || [...(app.streamingIds ?? [])].some((id) => sessionsHere.has(id));
  const hot = waiting || runs.some((r) => r.outcome === 'running') || kick > 0;
  useEffect(() => {
    if (!hot) return;
    const t = setInterval(() => { void refresh(); }, HOT_POLL_MS);
    return () => clearInterval(t);
  }, [hot, refresh]);
  // a message just sent: look again soon, and keep looking for a while
  const onSent = useCallback(() => {
    setKick((k) => k + 1);
    setTimeout(() => { void refresh(); }, 600);
    setTimeout(() => setKick((k) => Math.max(0, k - 1)), 20_000);
  }, [refresh]);

  const set = (patch: Partial<Filters>) => setFilters((f) => {
    const next = { ...f, ...patch };
    for (const k of Object.keys(next) as Array<keyof Filters>) if (next[k] === undefined || next[k] === '') delete next[k];
    return next;
  });
  const total = groups.reduce((n, g) => n + g.count, 0);
  const sessionName = filters.session ? (runs[0]?.sessionName ?? 'one session') : '';
  const agentName = app.agents.find((a) => a.id === agentId)?.name ?? 'the agent';
  const readOnly = app.me?.role === 'viewer';
  const sessionRunning = filters.session ? runs.some((r) => r.sessionId === filters.session && r.outcome === 'running') : false;
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

      {filters.session && (
        <div data-testid="work-session-box" style={{ ...card, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{sessionName}</span>
            <span style={faint}>a work session of {agentName}</span>
            <button onClick={() => app.openInChat(filters.session!)} style={{ ...actionBtn(), marginLeft: 'auto' }}>Continue in chat</button>
          </div>
          {readOnly
            ? <div style={faint}>Read-only: viewers can follow the work but not message, stop or approve.</div>
            : <SessionComposer sessionId={filters.session} agentName={agentName} running={sessionRunning} onSent={onSent} />}
        </div>
      )}

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
              <RunRow key={r.id} r={r} first={i === 0} open={open.has(r.id)} onToggle={() => toggle(r.id)} detail={details[r.id]} agentId={agentId}
                readOnly={readOnly} agentName={agentName} onChanged={refresh} reloadRun={reloadRun} focusRun={focusRun} onSent={onSent} />
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

interface RowProps {
  r: WorkRun; first: boolean; open: boolean; onToggle: () => void; detail?: WorkRunDetail | 'loading' | 'error'; agentId: string;
  readOnly: boolean; agentName: string; onChanged: () => Promise<void> | void; reloadRun: (id: string) => void; focusRun: (id: string) => void; onSent: () => void;
}

function RunRow({ r, first, open, onToggle, detail, agentId, readOnly, agentName, onChanged, reloadRun, focusRun, onSent }: RowProps) {
  const app = useApp();
  const who = useWho();
  const running = r.outcome === 'running';
  const live = useLiveRun(r.sessionId, running && open, () => { void onChanged(); reloadRun(r.id); });
  // the stream cannot be watched from here (another instance): re-read the run
  useEffect(() => {
    if (!running || !open || live.mode !== 'poll') return;
    const t = setInterval(() => { reloadRun(r.id); void onChanged(); }, RUN_POLL_MS);
    return () => clearInterval(t);
  }, [running, open, live.mode, r.id, reloadRun, onChanged]);
  const [rerunning, setRerunning] = useState(false);
  const openTask = () => {
    if (!r.task) return;
    if (r.task.kind === 'org') { app.setMobileDetail(true); app.openOrgTask(r.task.id); } else app.openAgent(agentId, 'Work:Tasks');
  };
  const stop = () => {
    void api.stop(r.sessionId).then((res) => {
      app.showToast(res.stopped ? 'Stopped — the partial run is kept' : 'Nothing was running there any more');
      reloadRun(r.id);
      void onChanged();
    }).catch((e: unknown) => app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'Could not stop it'));
  };
  const decide = (callId: string, d: ApprovalDecision) => {
    void api.approve(r.sessionId, callId, d)
      .then((res) => { if (!res.resolved) app.showToast('That approval was already answered'); })
      .catch((e: unknown) => app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'Could not answer it'));
  };
  const rerun = () => {
    if (rerunning) return;
    setRerunning(true);
    void api.rerunWorkRun(agentId, r.id).then((res) => {
      if (res.started) {
        app.showToast(res.turnId ? `Rerunning ${r.label}` : `Rerun of ${r.label} started`);
        if (res.turnId) focusRun(res.turnId);
      } else {
        app.showToast(`The rerun did not start: ${res.error || res.status.replace(/^skipped:/, '').replace(/_/g, ' ')}`);
      }
      void onChanged();
    }).catch((e: unknown) => app.showToast(e instanceof Error ? e.message.replace(/^\d+\s*/, '').slice(0, 200) : 'Could not rerun it'))
      .finally(() => setRerunning(false));
  };
  const steps = running && live.items.length > 0 ? liveSteps(live.items) : r.steps;
  const person = r.source === 'person';
  return (
    <li data-testid="work-run" data-run={r.id} data-outcome={r.outcome} style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)' }}>
      <div role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', cursor: 'pointer', minWidth: 0 }}>
        <span title={r.outcome} aria-label={`outcome ${r.outcome}`} style={{ width: 8, height: 8, borderRadius: '50%', background: OUTCOME_COLOR[r.outcome], flex: 'none', animation: running ? 'pulse 1.2s ease-in-out infinite' : undefined }} />
        <span style={{ ...faint, flex: 'none', fontFamily: 'var(--mono)' }}>{timeOf(r.createdAt)}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 6, padding: '0 7px', flex: 'none', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
        {person && <span data-testid="from-person" style={{ fontSize: 10.5, fontWeight: 650, color: 'var(--accent-hi, var(--accent))', flex: 'none' }}>from {who(r.by)}</span>}
        {r.rerunOf && <span style={{ ...faint, flex: 'none' }}>rerun</span>}
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.outcome === 'error' ? 'var(--red)' : 'var(--text)' }}>
          {r.outcome === 'error' && r.error ? r.error : (person ? (r.input || '').replace(/\s+/g, ' ').slice(0, 160) : headline(r)) || '(no answer)'}
        </span>
        {running
          ? <span data-testid="run-live" style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flex: 'none' }}>running · step {Math.max(1, steps)}</span>
          : (
            <span style={{ ...faint, flex: 'none' }}>
              {r.steps > 0 ? `${r.steps} step${r.steps === 1 ? '' : 's'} · ` : ''}{fmtTokens(r.tokensIn + r.tokensOut)} tok{r.usd !== null ? ` · ${fmtUsd(r.usd)}` : ''}
            </span>
          )}
        <span style={{ fontSize: 10, fontWeight: 700, color: OUTCOME_COLOR[r.outcome], flex: 'none', textTransform: 'uppercase', letterSpacing: '.4px' }}>{r.outcome}</span>
      </div>
      {open && (
        <div style={{ padding: '2px 12px 12px 29px', display: 'flex', flexDirection: 'column', gap: 9 }} data-testid="work-run-detail">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', ...faint }}>
            <span>{TRIGGER_LABEL[r.trigger]}</span>
            <span>{r.tokensIn.toLocaleString()} in · {r.tokensOut.toLocaleString()} out{r.model ? ` · ${r.model}` : ''}</span>
            {r.usd !== null && <span>{fmtUsd(r.usd)}</span>}
            {r.task && <button onClick={openTask} style={linkBtn}>{[r.task.key, r.task.title].filter(Boolean).join(' ')} →</button>}
            {r.rerunOf && <button onClick={() => focusRun(r.rerunOf!)} style={linkBtn}>rerun of an earlier run →</button>}
            {r.archived && <span>archived session</span>}
          </div>
          {r.outcome === 'error' && r.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{r.error}</div>}
          {person && (
            <div data-testid="person-message" style={{ alignSelf: 'flex-start', maxWidth: '100%', background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 10, padding: '7px 11px' }}>
              <div style={{ ...faint, fontWeight: 650, marginBottom: 2 }}>Message from {who(r.by)}</div>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{r.input}</div>
            </div>
          )}
          {running && live.mode !== 'poll' ? (
            <LiveRunView r={r} items={live.items} mode={live.mode} readOnly={readOnly} agentId={agentId} onDecide={decide} />
          ) : detail === 'loading' || detail === undefined ? <div style={faint}>Loading the run…</div>
            : detail === 'error' ? <div style={{ ...faint, color: 'var(--red)' }}>Could not load this run.</div>
              : <RunDetail d={detail} agentId={agentId} hidePrompt={person} />}
          <div data-testid="run-actions" style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
            {running && !readOnly && <button onClick={stop} style={actionBtn('danger')}>Stop</button>}
            {r.rerunnable && !running && !readOnly && (
              <button onClick={rerun} disabled={rerunning} title="Run it again by the same trigger, in the same work session" style={{ ...actionBtn(), opacity: rerunning ? 0.55 : 1 }}>{rerunning ? 'Rerunning…' : 'Rerun'}</button>
            )}
            <button onClick={() => app.openInChat(r.sessionId)} style={actionBtn()}>Continue in chat</button>
          </div>
          {!readOnly && <SessionComposer sessionId={r.sessionId} agentName={agentName} running={running} onSent={onSent} />}
        </div>
      )}
    </li>
  );
}

type LiveMode = 'connecting' | 'live' | 'poll' | 'ended';

/** The live rows of a run in progress: thinking, tool calls (approvals
 *  inline, with the reviewer's details), answers — as they stream. */
function LiveRunView({ r, items, mode, readOnly, agentId, onDecide }: { r: WorkRun; items: LiveItem[]; mode: LiveMode; readOnly: boolean; agentId: string; onDecide: (callId: string, d: ApprovalDecision) => void }) {
  return (
    <div data-testid="work-live" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite' }} />
        {mode === 'connecting' ? 'Connecting to the run…' : `running · step ${Math.max(1, liveSteps(items))}`}
      </div>
      {r.source !== 'person' && (
        <details>
          <summary style={{ cursor: 'pointer', ...faint, fontWeight: 600 }}>Prompt</summary>
          <pre style={{ ...pre, marginTop: 5 }}>{r.input}</pre>
        </details>
      )}
      {items.map((item, i) => {
        if (item.kind === 'thinking') {
          return (
            <div key={`t${i}`} data-testid="work-thinking">
              <div style={{ ...faint, fontWeight: 600, marginBottom: 3 }}>Thinking{item.streaming ? ' …' : ''}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic', whiteSpace: 'pre-wrap', lineHeight: 1.55, borderLeft: '2px solid var(--border)', paddingLeft: 9 }}>{item.text}</div>
            </div>
          );
        }
        if (item.kind === 'answer') return <div key={`a${i}`} style={{ fontSize: 13, lineHeight: 1.6 }}><Markdown text={item.text} compact /></div>;
        if (item.kind === 'tool') return <ToolCard key={item.id} t={item} readOnly={readOnly} agentId={agentId} onDecide={(d) => onDecide(item.id, d)} />;
        return null;
      })}
    </div>
  );
}

/** Watch the turn running in a session (GET /api/chats/:id/live): its
 *  replay, then each event. `poll` when the turn cannot be watched from
 *  here (another instance, a dropped connection); `ended` when it is over. */
function useLiveRun(sessionId: string, on: boolean, onEnd: () => void): { items: LiveItem[]; mode: LiveMode } {
  const [items, setItems] = useState<LiveItem[]>([]);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    if (!on) return;
    const ctrl = new AbortController();
    setItems([]);
    setMode('connecting');
    let done = false;
    let pending: Array<Parameters<typeof applyWatchEvent>[1]> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const evs = pending;
      pending = [];
      if (evs.length) setItems((it) => evs.reduce(applyWatchEvent, it));
    };
    // the first verdict stands: an idle-but-busy answer polls even after the
    // stream closes; an end ends once
    const finish = (m: LiveMode) => {
      flush();
      if (done) return;
      done = true;
      setMode(m);
      if (m === 'ended') endRef.current();
    };
    void watchSession(sessionId, (ev) => {
      if (ev.type === 'live') { setMode('live'); return; }
      if (ev.type === 'idle') { finish(ev.busy ? 'poll' : 'ended'); return; }
      if (ev.type === 'end') { finish('ended'); return; }
      pending.push(ev);
      if (!timer) timer = setTimeout(flush, 40);
    }, ctrl.signal).then(() => { if (!ctrl.signal.aborted) finish('ended'); }, () => { if (!ctrl.signal.aborted) finish('poll'); });
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, on]);
  return { items, mode };
}

/** "Message <agent> in this work session": starts a turn there (origin
 *  user, so Ask-mode approvals apply), or queues it for the next turn while
 *  one runs. */
function SessionComposer({ sessionId, agentName, running, onSent }: { sessionId: string; agentName: string; running: boolean; onSent: () => void }) {
  const app = useApp();
  const [text, setText] = useState('');
  const queued = (app.queueAll ?? []).filter((q) => q.sessionId === sessionId);
  const busyHere = running || (app.streamingIds?.has(sessionId) ?? false);
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const res = await app.sendToSession(sessionId, t, { serverBusy: running });
    app.showToast(res === 'queued' ? `Queued — ${agentName} gets it on its next turn here` : `Sent — ${agentName} picks it up now`);
    onSent();
  };
  return (
    <div data-testid="session-composer" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {queued.length > 0 && (
        <ul aria-label="Queued messages" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {queued.map((q) => (
            <li key={q.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, background: 'var(--panel-2)', border: '1px dashed var(--border)', borderRadius: 8, padding: '4px 9px' }}>
              <span style={{ ...faint, flex: 'none' }}>queued for the next turn</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.text}</span>
              <button aria-label="Remove queued message" onClick={() => app.removeQueued(q.id)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0 }}>×</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} style={{ display: 'flex', gap: 6 }}>
        <input aria-label={`Message ${agentName} in this work session`} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={busyHere ? `Message ${agentName} — queued for its next turn here` : `Message ${agentName} in this work session`}
          style={{ ...input, flex: 1, fontSize: 12.5, padding: '6px 10px' }} />
        <button type="submit" disabled={!text.trim()} style={{ ...actionBtn('primary'), opacity: text.trim() ? 1 : 0.5 }}>{busyHere ? 'Queue' : 'Send'}</button>
      </form>
    </div>
  );
}

function RunDetail({ d, agentId, hidePrompt = false }: { d: WorkRunDetail; agentId: string; hidePrompt?: boolean }) {
  const app = useApp();
  const ws = app.agents.find((a) => a.id === agentId)?.workspaceId || app.workspaceId;
  const openPath = (path: string) => {
    if (path.startsWith('/')) app.openFile({ kind: 'workspace', id: ws }, path.slice(1));
    else app.openFile({ kind: 'agent', id: agentId }, path.replace(/^~\//, ''));
  };
  let call = 0;
  return (
    <>
      {!hidePrompt && (
        <details>
          <summary style={{ cursor: 'pointer', ...faint, fontWeight: 600 }}>Prompt</summary>
          <pre style={{ ...pre, marginTop: 5 }}>{d.input}</pre>
        </details>
      )}
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
