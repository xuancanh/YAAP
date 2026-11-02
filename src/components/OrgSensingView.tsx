/** Sensing on screen (docs/sensing.md, execution-plan item 27; SPA item 32):
 *  the pieces other panes borrow — the key result's "measured by" line with
 *  binding, the task drawer's checks list with "Run checks", and the check
 *  builder of the new-task form. Metric sources and their latest readings are
 *  mirrored to /org/metrics.md in Artifacts (docs/filesystem.md). */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type HumanRole, type MetricSource, type OrgIntentNode, type OrgTask, type TaskCheck, type TaskCheckKind, type TaskCheckResult } from '../lib/api';
import { buildCheck, CHECK_KIND_FIELDS, CHECK_STATUS_COLOR, checkSummary, CONNECTION_QUERIES, describeCheck, fmtNum, parseTaskChecks, SOURCE_KIND_LABEL, sourceStatus, verificationBadge } from '../lib/org3';
import { card, input, btn, pill, faint, label, linkBtn, ago } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 200) : 'failed');

/** The viewer's role in the organization (the server refuses writes regardless; the page says so instead). */
export function useOrgRole(wsId: string): HumanRole | null | undefined {
  const [role, setRole] = useState<HumanRole | null | undefined>(undefined);
  useEffect(() => { void api.orgHumans(wsId).then((h) => setRole(h.me.role)).catch(() => setRole(null)); }, [wsId]);
  return role;
}

/** "measured by <source>" with the last fetch, or a self-reported badge; the CEO binds or unbinds. */
export function KrSourceLine({ g, wsId, sources, isCeo, onChanged }: { g: OrgIntentNode; wsId: string; sources: MetricSource[]; isCeo: boolean | null; onChanged: () => Promise<void> | void }) {
  const app = useApp();
  const [binding, setBinding] = useState(false);
  const m = g.measuredBy ?? null;
  const live = sources.filter((s) => s.status === 'ok' || s.status === 'error' || s.status === 'stale');
  const bind = async (sourceId: string | null) => {
    try { await api.bindOrgGoalSource(wsId, g.id, sourceId); setBinding(false); await onChanged(); app.showToast(sourceId ? 'Bound — its value now comes from the source' : 'Unbound — self-reported again'); } catch (e) { app.showToast(errText(e)); }
  };
  const st = m ? sourceStatus(m.status) : null;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {m ? (
        <button style={{ ...pill('var(--panel-2)', 'var(--text)'), cursor: 'pointer', display: 'inline-flex', gap: 4, alignItems: 'center' }} title={`${SOURCE_KIND_LABEL[m.kind] ?? m.kind} · ${st?.label}${m.lastFetchedAt ? ` · fetched ${m.lastFetchedAt}` : ''}`}
          onClick={() => app.openFile({ kind: 'workspace', id: wsId }, app.fileList.some((f) => f.path === 'org/metrics.md') ? 'org/metrics.md' : null)}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: st?.color }} />measured by {m.name} · {m.lastFetchedAt ? ago(m.lastFetchedAt) : 'not fetched yet'}
        </button>
      ) : g.selfReported !== false ? <span style={pill('var(--amber)', '#fff')} title="No metric source: the value is whatever the owner typed">self-reported</span> : null}
      {isCeo && !binding && <button style={linkBtn} onClick={() => setBinding(true)}>{m ? 'change source' : 'bind a source'}</button>}
      {isCeo && binding && (
        <>
          <select aria-label={`Metric source for ${g.title}`} defaultValue={m?.sourceId ?? ''} onChange={(e) => void bind(e.target.value || null)} style={{ ...input, width: 'auto', padding: '2px 6px', fontSize: 11.5 }}>
            <option value="">{m ? 'Unbind (self-reported)' : 'Pick a live source…'}</option>
            {live.map((s) => <option key={s.id} value={s.id}>{s.name}{s.unit ? ` (${s.unit})` : ''} · {fmtNum(s.lastValue)}</option>)}
          </select>
          <button style={linkBtn} onClick={() => setBinding(false)}>cancel</button>
        </>
      )}
    </span>
  );
}

// ---- the task drawer's checks ----

export function TaskChecksPanel({ wsId, task, onRan }: { wsId: string; task: OrgTask; onRan?: () => void }) {
  const app = useApp();
  const [results, setResults] = useState<TaskCheckResult[] | null>(null);
  const [sources, setSources] = useState<MetricSource[]>([]);
  const [running, setRunning] = useState(false);
  const declared = parseTaskChecks(task.checks);
  const load = useCallback(async () => {
    const [r, s] = await Promise.all([api.orgTaskChecks(wsId, task.id).catch((): TaskCheckResult[] => []), api.orgMetricSources(wsId).catch((): MetricSource[] => [])]);
    setResults(r); setSources(s);
  }, [wsId, task.id]);
  useEffect(() => { void load(); }, [load, task.updatedAt]);
  const name = (id: string) => sources.find((s) => s.id === id || s.id.startsWith(id) || s.name === id)?.name;
  const badge = verificationBadge(task.verification ?? (task.status === 'done' ? (task.acceptedBy === 'check' ? 'check' : task.acceptedBy === 'review' ? 'review' : 'none') : null));
  const run = async () => {
    setRunning(true);
    try { const r = await api.runOrgTaskChecks(wsId, task.id); setResults(r.results); app.showToast(r.outcome === 'none' ? 'No checks on this task' : `Checks: ${r.outcome}`); onRan?.(); } catch (e) { app.showToast(errText(e)); } finally { setRunning(false); }
  };
  const list = results ?? [];
  if (declared.length === 0 && list.length === 0 && !badge) return null;
  const sum = checkSummary(list);
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Checks</span>
        {badge && <span style={pill(badge.color, '#fff')} title={badge.title}>{badge.label}</span>}
        <span style={{ ...faint, flex: 1, minWidth: 140 }}>{list.length ? sum.label : 'Model-free acceptance: none declared'}</span>
        {list.length > 0 && <button style={btn()} disabled={running} onClick={() => void run()} title="Run every check now (reads only; nothing on the task changes)">{running ? 'Running…' : 'Run checks'}</button>}
      </div>
      {list.map((r) => (
        <div key={r.index} style={{ display: 'flex', gap: 8, padding: '4px 0', borderTop: '1px solid var(--border-soft)', alignItems: 'flex-start' }}>
          <span style={{ ...pill(CHECK_STATUS_COLOR[r.status] ?? 'var(--panel-2)', r.status === 'pending' ? 'var(--text)' : '#fff'), flex: 'none' }}>{r.status}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{describeCheck(r.check, name)}</div>
            <div style={{ ...faint, fontSize: 11.5, overflowWrap: 'anywhere' }}>{r.detail}{r.ranAt ? ` · ${ago(r.ranAt)}` : ''}</div>
            {Object.keys(r.evidence ?? {}).length > 0 && (
              <details><summary style={{ cursor: 'pointer', ...faint, fontSize: 11 }}>evidence</summary><pre style={{ ...mono, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--panel-2)', padding: 6, borderRadius: 6, margin: '4px 0 0' }}>{JSON.stringify(r.evidence, null, 2)}</pre></details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- the check builder (new-task form) ----

export function ChecksBuilder({ wsId, value, onChange }: { wsId: string; value: TaskCheck[]; onChange: (v: TaskCheck[]) => void }) {
  const [sources, setSources] = useState<MetricSource[]>([]);
  const [kind, setKind] = useState<TaskCheckKind>('metric_at_least');
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void api.orgMetricSources(wsId).then(setSources).catch(() => setSources([])); }, [wsId]);
  const spec = CHECK_KIND_FIELDS[kind];
  const add = () => {
    const c = buildCheck(kind, fields);
    if (typeof c === 'string') { setErr(c); return; }
    if (value.length >= 10) { setErr('at most 10 checks'); return; }
    onChange([...value, c]); setFields({}); setErr(null);
  };
  const live = sources.filter((s) => s.status === 'ok' || s.status === 'error' || s.status === 'stale');
  const name = (id: string) => sources.find((s) => s.id === id)?.name;
  return (
    <div style={{ border: '1px dashed var(--border)', borderRadius: 9, padding: 8, display: 'grid', gap: 6 }}>
      <div style={{ ...label }}>Checks — run without a model before review; all pass accepts the task by check</div>
      {value.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{describeCheck(c, name)}</span>
          <button style={btn()} aria-label={`Remove check ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label="Check kind" value={kind} onChange={(e) => { setKind(e.target.value as TaskCheckKind); setFields({}); setErr(null); }} style={{ ...input, width: 'auto' }}>
          {(Object.keys(CHECK_KIND_FIELDS) as TaskCheckKind[]).map((k) => <option key={k} value={k}>{CHECK_KIND_FIELDS[k].label}</option>)}
        </select>
        {spec.fields.map((f) => {
          const v = fields[f.key];
          if (f.kind === 'source') return (
            <select key={f.key} aria-label={f.label} value={typeof v === 'string' ? v : ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={{ ...input, width: 'auto', flex: '1 1 140px' }}>
              <option value="">{live.length ? 'Source…' : 'No live source'}</option>{live.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          );
          if (f.kind === 'query') return (
            <select key={f.key} aria-label={f.label} value={typeof v === 'string' ? v : ''} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={{ ...input, width: 'auto', flex: '1 1 140px' }}>
              <option value="">Query…</option>{CONNECTION_QUERIES.map((q) => <option key={q.id} value={q.id}>{q.id}</option>)}
            </select>
          );
          if (f.kind === 'bool') return <label key={f.key} style={{ ...faint, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={v !== false} onChange={(e) => setFields({ ...fields, [f.key]: e.target.checked })} />{f.label}</label>;
          return <input key={f.key} aria-label={f.label} placeholder={`${f.label}${f.optional ? ' (optional)' : ''}`} value={typeof v === 'string' ? v : ''} inputMode={f.kind === 'number' ? 'decimal' : undefined} onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={{ ...input, width: 'auto', flex: f.kind === 'number' ? '0 1 90px' : '1 1 150px', minWidth: 0, ...(f.kind === 'number' ? mono : {}) }} />;
        })}
        <button style={btn()} onClick={add}>Add check</button>
      </div>
      {err && <div style={{ fontSize: 12, color: 'var(--amber)' }}>{err}</div>}
    </div>
  );
}
