/** Sensing on screen (docs/sensing.md, execution-plan item 27; SPA item 32):
 *  the Metrics pane — every metric source with its status, last value
 *  (provenance on hover), last fetch, a samples sparkline, the CEO's add /
 *  edit form (HTTP JSON with a selector tester, a webhook's ingest URL and a
 *  token shown once, the fixed connection-query menu, attested values), and
 *  "Attest a value" for people with standing. Also the pieces other panes
 *  borrow: the key result's "measured by" line with binding, the task
 *  drawer's checks list with "Run checks", and the check builder of the
 *  new-task form. */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type HumanRole, type MetricSample, type MetricSource, type MetricSourceInput, type MetricSourceKind, type OrgDetail, type OrgIntentNode, type OrgTask, type TaskCheck, type TaskCheckKind, type TaskCheckResult } from '../lib/api';
import { sparkPath } from '../lib/org';
import {
  buildCheck, CHECK_KIND_FIELDS, CHECK_STATUS_COLOR, checkSummary, CONNECTION_QUERIES, describeCheck, fmtNum, headerError, ingestUrl, normalizeSeries, parseTaskChecks, provenanceLabel, secretRefs, SOURCE_KIND_LABEL, sourceStatus,
  sourceTarget, testSelector, verificationBadge,
} from '../lib/org3';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 200) : 'failed');

/** The viewer's role in the organization (the server refuses writes regardless; the page says so instead). */
export function useOrgRole(wsId: string): HumanRole | null | undefined {
  const [role, setRole] = useState<HumanRole | null | undefined>(undefined);
  useEffect(() => { void api.orgHumans(wsId).then((h) => setRole(h.me.role)).catch(() => setRole(null)); }, [wsId]);
  return role;
}

export function MetricsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const isCeo = role === 'ceo';
  const [sources, setSources] = useState<MetricSource[] | null>(null);
  const [editing, setEditing] = useState<MetricSource | 'new' | null>(null);
  const [reveal, setReveal] = useState<{ sourceId: string; name: string; token: string; url: string } | null>(null);
  const refresh = useCallback(async () => { setSources(await api.orgMetricSources(wsId).catch((): MetricSource[] => [])); }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'source' || !sources) return;
    const el = document.getElementById(`source-${app.orgFocus.id}`) ?? document.querySelector<HTMLElement>(`[id^="source-${app.orgFocus.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--accent)'; setTimeout(() => { el.style.outline = ''; }, 2400); app.setOrgFocus(null); }
  }, [sources, app]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); if (done) app.showToast(done); } catch (e) { app.showToast(errText(e)); }
  };
  const live = (sources ?? []).filter((s) => s.status !== 'rejected');
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Metrics</h2>
          <div style={faint}>Numbers read from where they happen, with provenance. A key result bound to a source takes its value only from samples; agents read and propose sources but never write a value.</div>
        </div>
        {isCeo && <button style={btn(true)} onClick={() => setEditing('new')}>Add a source</button>}
      </div>
      {role !== undefined && !isCeo && <div style={{ ...faint, marginBottom: 10 }}>Only the CEO adds, edits or polls sources{role === 'board' || role === 'employee' ? '; you can attest a value on an attested source' : ''}.</div>}
      {reveal && <TokenReveal {...reveal} onClose={() => setReveal(null)} />}
      {editing && <SourceForm wsId={wsId} source={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (r) => { setEditing(null); if (r?.token && r.source) setReveal({ sourceId: r.source.id, name: r.source.name, token: r.token, url: ingestUrl(window.location.origin, r.source.id) }); await refresh(); }} />}
      {sources === null && <div style={faint}>Loading…</div>}
      {sources !== null && live.length === 0 && <div style={{ ...card, ...faint }}>No metric sources yet. {isCeo ? 'Add one, or approve a source the chief proposes (a metric_source card).' : 'The CEO adds them; the chief and unit leads can propose one.'} Key results stay self-reported until bound to a source.</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        {live.map((s) => (
          <SourceCard key={s.id} s={s} wsId={wsId} role={role ?? null} onEdit={() => setEditing(s)} act={act}
            onRotate={() => void act(async () => { if (!confirm(`Rotate the webhook token of "${s.name}"? The old token stops working at once.`)) return; const r = await api.rotateOrgMetricToken(wsId, s.id); setReveal({ sourceId: s.id, name: s.name, token: r.token, url: r.url || ingestUrl(window.location.origin, s.id) }); })} />
        ))}
      </div>
      {(sources ?? []).some((s) => s.status === 'rejected') && <div style={{ ...faint, marginTop: 10 }}>{(sources ?? []).filter((s) => s.status === 'rejected').length} rejected proposal(s) hidden.</div>}
    </div>
  );
}

/** The token is returned once; the page shows it once with the URL to post to. */
function TokenReveal({ name, token, url, onClose }: { sourceId: string; name: string; token: string; url: string; onClose: () => void }) {
  const app = useApp();
  const copy = (v: string) => { void navigator.clipboard?.writeText(v).then(() => app.showToast('Copied')).catch(() => undefined); };
  return (
    <div role="alert" style={{ ...card, borderLeft: '3px solid var(--amber)', marginBottom: 10, display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>Webhook token for "{name}" — shown once</div>
      <div style={faint}>Only its hash is kept. Post <code>{'{"value": 123}'}</code> with <code>?token=</code> or <code>Authorization: Bearer</code>; 30 posts a minute, 64 KB.</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span style={label}>URL</span><code style={{ ...mono, fontSize: 11.5, wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{url}</code><button style={btn()} onClick={() => copy(url)}>Copy</button></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><span style={label}>Token</span><code style={{ ...mono, fontSize: 11.5, wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{token}</code><button style={btn()} onClick={() => copy(token)}>Copy</button></div>
      <div><button style={btn(true)} onClick={onClose}>I have stored it</button></div>
    </div>
  );
}

function Sparkline({ samples, color }: { samples: MetricSample[]; color: string }) {
  const values = samples.map((s) => s.value);
  const path = sparkPath(normalizeSeries(values), 100, 28);
  if (values.length < 2) return <div style={{ ...faint, fontSize: 11 }}>{values.length === 0 ? 'no samples yet' : 'one sample so far'}</div>;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label={`${values.length} samples from ${fmtNum(Math.min(...values))} to ${fmtNum(Math.max(...values))}`} style={{ width: '100%', height: 30, display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function SourceCard({ s, wsId, role, onEdit, onRotate, act }: { s: MetricSource; wsId: string; role: HumanRole | null; onEdit: () => void; onRotate: () => void; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const st = sourceStatus(s.status);
  const isCeo = role === 'ceo';
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [attesting, setAttesting] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const load = useCallback(async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    setSamples(await api.orgMetricSamples(wsId, s.id, since).catch((): MetricSample[] => []));
  }, [wsId, s.id]);
  useEffect(() => { void load(); }, [load, s.lastFetchedAt]);
  const latest = samples.at(-1);
  const polled = s.kind === 'http_json' || s.kind === 'connection';
  const mayAttest = s.kind === 'manual_attested' && (role === 'ceo' || role === 'board' || role === 'employee') && s.status !== 'pending_approval';
  return (
    <div id={`source-${s.id}`} style={{ ...card, borderLeft: `3px solid ${st.color}` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
            <span style={pill()}>{SOURCE_KIND_LABEL[s.kind] ?? s.kind}</span>
            <span style={pill(st.color, '#fff')} title={st.title}>{st.label}</span>
          </div>
          <div style={{ ...faint, ...mono, fontSize: 11, marginTop: 3, overflowWrap: 'anywhere' }}>{sourceTarget(s)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ ...mono, fontSize: 20, fontWeight: 700, lineHeight: 1.1 }} title={latest ? `${provenanceLabel(latest.provenance)} · observed ${latest.observedAt}` : 'no sample yet'}>{fmtNum(s.lastValue)}{s.unit ? <span style={{ ...faint, fontSize: 12, marginLeft: 4 }}>{s.unit}</span> : null}</div>
          <div style={{ ...faint, fontSize: 11 }} title={s.lastFetchedAt ?? 'never'}>fetched {s.lastFetchedAt ? ago(s.lastFetchedAt) : 'never'} · every {s.pollMinutes >= 1440 ? `${Math.round(s.pollMinutes / 1440)}d` : s.pollMinutes >= 60 ? `${Math.round(s.pollMinutes / 60)}h` : `${s.pollMinutes}m`}</div>
        </div>
      </div>
      {s.lastError && s.status !== 'ok' && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 6, overflowWrap: 'anywhere' }}>{s.lastError}</div>}
      <div style={{ marginTop: 8 }}><Sparkline samples={samples} color={st.color === 'var(--text-faint)' ? 'var(--accent)' : st.color} /></div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 6, ...faint }}>
        {s.boundKeyResults.length > 0 ? <span>measures {s.boundKeyResults.map((k) => k.title).join(', ')}</span> : <span>no key result reads it yet</span>}
        {s.secretNames.length > 0 && <span title="Sealed; never shown">secrets: {s.secretNames.join(', ')}</span>}
        {s.kind === 'webhook' && <span>{s.hasToken ? 'token set' : 'no token yet — rotate one'}</span>}
        <button style={linkBtn} onClick={() => setShowSamples(!showSamples)}>{showSamples ? 'hide samples' : `samples (${samples.length})`}</button>
        {mayAttest && <button style={linkBtn} onClick={() => setAttesting(!attesting)}>{attesting ? 'close' : 'Attest a value'}</button>}
        {isCeo && polled && s.status !== 'pending_approval' && <button style={linkBtn} onClick={() => void act(async () => { const r = await api.pollOrgMetricSource(wsId, s.id); if (!r.ok) throw new Error(r.error ?? 'poll failed'); await load(); }, 'Polled')}>Poll now</button>}
        {isCeo && s.kind === 'webhook' && <button style={linkBtn} onClick={onRotate}>Rotate token</button>}
        {isCeo && <button style={linkBtn} onClick={onEdit}>Edit</button>}
        {isCeo && <button style={{ ...linkBtn, color: 'var(--red)' }} onClick={() => void act(async () => { if (!confirm(`Delete "${s.name}" and its samples? Key results it measures become self-reported.`)) return; await api.deleteOrgMetricSource(wsId, s.id); }, 'Source deleted')}>Delete</button>}
      </div>
      {s.status === 'pending_approval' && <div style={{ ...faint, marginTop: 6 }}>Proposed by {s.createdBy}. It goes live when the CEO approves its metric_source card in Approvals.</div>}
      {attesting && <AttestForm wsId={wsId} s={s} onDone={async () => { setAttesting(false); await load(); }} act={act} />}
      {showSamples && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 6, maxHeight: 220, overflowY: 'auto' }}>
          {samples.length === 0 && <div style={faint}>No samples in the last 30 days.</div>}
          {samples.slice().reverse().slice(0, 50).map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0', flexWrap: 'wrap' }} title={provenanceLabel(x.provenance)}>
              <span style={{ ...mono, minWidth: 70 }}>{fmtNum(x.value)}</span>
              <span style={faint}>{x.observedAt.slice(0, 16).replace('T', ' ')}</span>
              <span style={{ ...faint, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provenanceLabel(x.provenance)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttestForm({ wsId, s, onDone, act }: { wsId: string; s: MetricSource; onDone: () => Promise<void>; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const ok = value.trim() !== '' && Number.isFinite(Number(value)) && note.trim().length > 0;
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', alignItems: 'end' }}>
      <div><label style={label} htmlFor={`at-v-${s.id}`}>Value{s.unit ? ` (${s.unit})` : ''}</label><input id={`at-v-${s.id}`} value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.-]/g, ''))} inputMode="decimal" style={{ ...input, ...mono }} /></div>
      <div style={{ gridColumn: 'span 2', minWidth: 0 }}><label style={label} htmlFor={`at-n-${s.id}`}>Where it comes from (required)</label><input id={`at-n-${s.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Stripe dashboard, 2 Nov" style={input} /></div>
      <div><label style={label} htmlFor={`at-w-${s.id}`}>Observed (optional)</label><input id={`at-w-${s.id}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={input} /></div>
      <button style={btn(true)} disabled={!ok} onClick={() => void act(async () => { await api.attestOrgMetric(wsId, s.id, { value: Number(value), note: note.trim(), ...(when ? { observedAt: new Date(when).toISOString() } : {}) }); await onDone(); }, 'Value attested — recorded with your name')}>Attest</button>
    </div>
  );
}

/** The CEO's add / edit form. Secrets are write-only: names show, values never come back. */
function SourceForm({ wsId, source, onClose, onSaved }: { wsId: string; source: MetricSource | null; onClose: () => void; onSaved: (r: { source?: MetricSource; token?: string } | null) => Promise<void> }) {
  const app = useApp();
  const c = source?.config ?? {};
  const [kind, setKind] = useState<MetricSourceKind>((source?.kind as MetricSourceKind) ?? 'http_json');
  const [name, setName] = useState(source?.name ?? '');
  const [unit, setUnit] = useState(source?.unit ?? '');
  const [poll, setPoll] = useState(source ? String(source.pollMinutes) : '');
  const [url, setUrl] = useState(String(c.url ?? ''));
  const [selector, setSelector] = useState(String(c.selector ?? ''));
  const [headers, setHeaders] = useState<Array<{ name: string; value: string }>>(Object.entries((c.headers ?? {}) as Record<string, string>).map(([n, v]) => ({ name: n, value: String(v) })));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(String(c.query ?? 'gmail_unread'));
  const [q, setQ] = useState(String(c.q ?? ''));
  const [days, setDays] = useState(String(c.days ?? 7));
  const [sample, setSample] = useState('');
  const [busy, setBusy] = useState(false);
  const hdrErrors = headers.filter((h) => h.name.trim()).map((h) => headerError(h.name.trim(), h.value)).filter((x): x is string => Boolean(x));
  const refs = secretRefs(Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])));
  const missingSecrets = refs.filter((r) => !secrets[r] && !(source?.secretNames ?? []).includes(r));
  const tested = sample.trim() && selector.trim() ? testSelector(sample, selector) : null;
  const hasDays = CONNECTION_QUERIES.find((x) => x.id === query)?.hasDays ?? false;
  const problems = [
    !name.trim() ? 'a name' : '',
    kind === 'http_json' && !/^https?:\/\//.test(url.trim()) ? 'an https URL' : '',
    kind === 'http_json' && !selector.trim() ? 'a selector' : '',
    ...hdrErrors, ...missingSecrets.map((r) => `the value of secret ${r}`),
  ].filter(Boolean);
  const save = async () => {
    setBusy(true);
    try {
      const config: Record<string, unknown> | undefined = kind === 'http_json'
        ? { url: url.trim(), selector: selector.trim(), ...(headers.some((h) => h.name.trim()) ? { headers: Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value])) } : {}) }
        : kind === 'connection' ? { query, q, ...(hasDays ? { days: Number(days) || 7 } : {}) } : undefined;
      const body: MetricSourceInput = { name: name.trim(), unit: unit.trim(), ...(poll.trim() ? { pollMinutes: Number(poll) } : {}), ...(config ? { config } : {}), ...(Object.keys(secrets).length ? { secrets } : {}) };
      if (source) { await api.updateOrgMetricSource(wsId, source.id, body); await onSaved(null); app.showToast('Source saved'); }
      else { const r = await api.createOrgMetricSource(wsId, { ...body, kind }); await onSaved(r); app.showToast(kind === 'webhook' ? 'Webhook created — store the token now' : 'Source created'); }
    } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ ...card, marginBottom: 12, display: 'grid', gap: 10 }} role="form" aria-label={source ? `Edit ${source.name}` : 'Add a metric source'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{source ? `Edit "${source.name}"` : 'Add a metric source'}</span><button style={btn()} onClick={onClose}>Cancel</button></div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div><label style={label} htmlFor="src-kind">Kind</label>
          <select id="src-kind" value={kind} disabled={Boolean(source)} onChange={(e) => setKind(e.target.value as MetricSourceKind)} style={input}>
            {(['http_json', 'webhook', 'connection', 'manual_attested'] as const).map((k) => <option key={k} value={k}>{SOURCE_KIND_LABEL[k]}</option>)}
          </select></div>
        <div><label style={label} htmlFor="src-name">Name</label><input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Newsletter subscribers" style={input} /></div>
        <div><label style={label} htmlFor="src-unit">Unit</label><input id="src-unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="subscribers" style={input} /></div>
        <div><label style={label} htmlFor="src-poll">{kind === 'http_json' || kind === 'connection' ? 'Poll every (min)' : 'Expected every (min)'}</label><input id="src-poll" value={poll} onChange={(e) => setPoll(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder={kind === 'webhook' ? '1440' : kind === 'manual_attested' ? '10080' : '60'} style={{ ...input, ...mono }} /></div>
      </div>
      {kind === 'http_json' && (
        <>
          <div><label style={label} htmlFor="src-url">URL (https)</label><input id="src-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/stats" style={{ ...input, ...mono }} /></div>
          <div><label style={label} htmlFor="src-sel">Selector</label><input id="src-sel" value={selector} onChange={(e) => setSelector(e.target.value)} placeholder="data.subscribers · items.length · rows.sum(amount)" style={{ ...input, ...mono }} /></div>
          <details>
            <summary style={{ cursor: 'pointer', ...faint }}>Test the selector on a sample response</summary>
            <textarea aria-label="Sample JSON response" value={sample} onChange={(e) => setSample(e.target.value)} rows={4} placeholder='{"data": {"subscribers": 450}}' style={{ ...input, ...mono, resize: 'vertical', marginTop: 6 }} />
            {tested && <div role="status" style={{ fontSize: 12, marginTop: 4, color: tested.ok ? 'var(--green)' : 'var(--red)' }}>{tested.ok ? `→ ${fmtNum(tested.value)} would be stored` : tested.error}</div>}
          </details>
          <div>
            <div style={{ ...label, marginBottom: 4 }}>Headers</div>
            {headers.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                <input aria-label={`Header ${i + 1} name`} value={h.name} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Authorization" style={{ ...input, ...mono, flex: '1 1 120px', width: 'auto' }} />
                <input aria-label={`Header ${i + 1} value`} value={h.value} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="Bearer {{secret:API}}" style={{ ...input, ...mono, flex: '2 1 180px', width: 'auto' }} />
                <button style={btn()} aria-label="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button style={linkBtn} onClick={() => setHeaders([...headers, { name: '', value: '' }])}>+ header</button>
            <div style={{ ...faint, fontSize: 11 }}>Credentials only as <code>{'{{secret:NAME}}'}</code>; the value goes below, sealed and never shown again.</div>
          </div>
          {refs.length > 0 && (
            <div style={{ display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              {refs.map((r) => (
                <div key={r}><label style={label} htmlFor={`sec-${r}`}>Secret {r}{(source?.secretNames ?? []).includes(r) ? ' (set — leave empty to keep)' : ''}</label>
                  <input id={`sec-${r}`} type="password" autoComplete="off" value={secrets[r] ?? ''} onChange={(e) => setSecrets({ ...secrets, [r]: e.target.value })} style={{ ...input, ...mono }} /></div>
              ))}
            </div>
          )}
        </>
      )}
      {kind === 'connection' && (
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div><label style={label} htmlFor="src-q">Query</label>
            <select id="src-q" value={query} onChange={(e) => setQuery(e.target.value)} style={input}>{CONNECTION_QUERIES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
          <div><label style={label} htmlFor="src-qs">q (provider search)</label><input id="src-qs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="label:signups" style={{ ...input, ...mono }} /></div>
          {hasDays && <div><label style={label} htmlFor="src-days">Days</label><input id="src-days" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} inputMode="numeric" style={{ ...input, ...mono }} /></div>}
          <div style={{ ...faint, gridColumn: '1 / -1' }}>Read-only, Google connections only. A workspace agent must hold a grant on that service.</div>
        </div>
      )}
      {kind === 'webhook' && <div style={faint}>{source ? 'Rotate the token from the card; the old one stops working at once.' : 'The token is generated on save and shown once, with the URL to post to.'}</div>}
      {kind === 'manual_attested' && <div style={faint}>The CEO, board members and employees post the value with a note; each sample records who attested.</div>}
      {problems.length > 0 && <div style={{ fontSize: 12, color: 'var(--amber)' }}>Needs: {problems.join(' · ')}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={busy || problems.length > 0} onClick={() => void save()}>{source ? 'Save' : 'Create'}</button></div>
    </div>
  );
}

// ---- the key result's source (Vision pane) ----

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
          onClick={() => { app.setOrgFocus({ kind: 'source', id: m.sourceId }); app.setOrgPane('metrics'); }}>
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
