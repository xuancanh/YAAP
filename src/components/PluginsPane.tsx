/** Settings › Plugins (docs/plugins.md, Phase 1): the installed plugins with
 *  their status and why one is suspended, the install review screen (the
 *  permission and classification diff against nothing: every operation's
 *  class as yaam will treat it, with the floor that raised it), interfaces
 *  with their providers, conformance and the owner's bindings, and per
 *  install the inventory of what it added, its conformance runs and the
 *  agents granted access; the recall notice on a frozen install, updates
 *  from the plugin registry with their permission diff, and loading your
 *  own plugin folder as `name@local` (docs/plugins.md §7). */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import {
  api, type InterfaceView, type PluginCatalogEntry, type PluginDetail, type PluginReview, type PluginSource, type PluginSummary, type PluginUpdates,
} from '../lib/api';
import { folderFiles } from '../lib/foundry';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '15px 17px' };
const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const btn: React.CSSProperties = { background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-dim)', fontSize: 11.5, padding: '3px 10px', cursor: 'pointer' };
const primary: React.CSSProperties = { background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 12.5, fontWeight: 600, padding: '6px 14px', cursor: 'pointer' };
const th: React.CSSProperties = { textAlign: 'left', fontWeight: 600, color: 'var(--text-faint)', fontSize: 10.5, padding: '4px 6px', borderBottom: '1px solid var(--border)' };
const td: React.CSSProperties = { padding: '4px 6px', fontSize: 11.5, verticalAlign: 'top', borderBottom: '1px solid var(--border)' };
const h: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 8 };

export const CLASS_LABEL: Record<string, string> = {
  read: 'read', internal_write: 'internal write', external_reversible: 'external, reversible', external_irreversible: 'external, irreversible', money: 'money',
};
const CLASS_TONE: Record<string, string> = { read: 'var(--green)', internal_write: 'var(--text-dim)', external_reversible: 'var(--accent-hi)', external_irreversible: 'var(--red, #e5484d)', money: 'var(--red, #e5484d)' };

function Pill({ text, tone }: { text: string; tone?: string }) {
  return <span style={{ fontSize: 10, color: tone ?? 'var(--text-dim)', border: `1px solid ${tone ?? 'var(--border)'}`, borderRadius: 5, padding: '1px 6px', whiteSpace: 'nowrap' }}>{text}</span>;
}

export function statusText(p: Pick<PluginSummary, 'status' | 'suspendedReason'>): string {
  if (p.status === 'suspended') return `suspended: ${p.suspendedReason}`;
  if (p.status === 'frozen') return `frozen: ${p.suspendedReason}`;
  if (p.status === 'installed' && p.suspendedReason) return `not ready: ${p.suspendedReason}`;
  return p.status;
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /"message":"([^"]+)"/.exec(msg);
  const b = /"blockers":\[([^\]]*)\]/.exec(msg);
  return [m?.[1] ?? msg.slice(0, 200), b?.[1]].filter(Boolean).join(' — ');
}

/** The review screen: real declarations, never paraphrases (docs/plugins.md §6.1). */
export function ReviewPanel({ review, onInstall, onCancel, busy }: { review: PluginReview; onInstall: () => void; onCancel: () => void; busy: boolean }) {
  return (
    <div style={{ ...card, borderColor: 'var(--accent)' }} data-testid="plugin-review">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Review {review.name}</span>
        <Pill text={`${review.id}@${review.version}`} />
        <Pill text={review.tier.replace('_', '-')} />
        {review.roles.map((r) => <Pill key={r} text={r} />)}
        {review.noEgress && <Pill text="no egress" tone="var(--green)" />}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
        {review.publisher.name}{review.publisher.verifiedDomain ? ` (${review.publisher.verifiedDomain})` : ''} · digest <span style={mono}>{review.digest.slice(0, 16)}…</span> · requires yaam core {review.requires.yaamCore}
        {review.requires.interfaces?.length ? ` and ${review.requires.interfaces.join(', ')}` : ''}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8, lineHeight: 1.5 }}>
        Each operation shows the class yaam will treat it as, from the interface, the provider, yaam&apos;s own floors and your policies, whichever is strictest. A plugin can ask for more caution, never for less.
      </div>
      {review.interfaces.map((i) => (
        <div key={i.name} style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Interface <span style={mono}>{i.name}@{i.version}</span> — {i.semantics}</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
            <thead><tr><th style={th}>Operation</th><th style={th}>Declared</th><th style={th}>Treated as</th><th style={th}>Why</th><th style={th}>Change</th></tr></thead>
            <tbody>
              {i.operations.map((o) => (
                <tr key={o.op} data-testid={`review-op-${o.canonical}`}>
                  <td style={{ ...td, ...mono }}>{o.canonical}{o.outbound ? ' ↗' : ''}</td>
                  <td style={td}>{o.declaredClass ? CLASS_LABEL[o.declaredClass] ?? o.declaredClass : 'undeclared'}</td>
                  <td style={{ ...td, color: CLASS_TONE[o.effectiveClass], fontWeight: o.raisedByFloor ? 600 : 400 }}>{CLASS_LABEL[o.effectiveClass] ?? o.effectiveClass}{o.twoKeyByFloor ? ' · two-key' : ''}</td>
                  <td style={{ ...td, color: 'var(--text-faint)' }}>{o.raisedByFloor ? `raised by yaam's floor: ${o.floorReasons.join('; ')}` : o.floorReasons.length ? o.floorReasons.join('; ') : '—'}</td>
                  <td style={td}>{o.change ? `${o.change.role} ${i.name}.${o.change.kind}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {i.changeKinds.map((k) => (
            <div key={k.kind} style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 6 }}>
              Change kind <span style={mono}>{k.kind}</span> ({k.reversibility}): requirement <b>{k.effectiveRequirement.replace('_', '-')}</b>
              {k.raisedByFloor ? ` (declared ${k.declaredRequirement}; raised by yaam's floor for ${k.reversibility} changes)` : ''} · {k.roles.map((r) => `${r.op} ${r.role}`).join(', ')}
            </div>
          ))}
          {i.suiteCases.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>Conformance suite: {i.suiteCases.join(', ')}</div>}
        </div>
      ))}
      {review.provides.map((p) => (
        <div key={p.interface} style={{ fontSize: 12, marginTop: 10 }}>
          Provides <span style={mono}>{p.interface}</span> for {p.resources.map((r) => <span key={r} style={mono}>{r} </span>)}· conformance {p.conformanceMode}
          {!p.installed && <span style={{ color: 'var(--text-faint)' }}> · the interface is not installed yet (the provider will wait)</span>}
          {p.missingRequired.length > 0 && <span style={{ color: 'var(--red, #e5484d)' }}> · missing required: {p.missingRequired.join(', ')}</span>}
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, marginTop: 10, fontSize: 11.5, color: 'var(--text-dim)' }}>
        <div><b>Egress</b>: {review.egress.length ? review.egress.map((e) => e.host).join(', ') : 'none'}</div>
        <div><b>Secrets</b>: {review.secrets.length ? review.secrets.map((x) => <span key={x.slot} style={{ color: x.redLine ? 'var(--red, #e5484d)' : undefined }}>{x.slot} ({x.inject}) </span>) : 'none'}</div>
        <div><b>Data sharing</b>: {review.dataSharing.length ? review.dataSharing.map((d) => `${d.category} → ${d.to} (${d.when})`).join('; ') : 'none'}</div>
        <div><b>Identity sent</b>: {review.identity.length ? review.identity.map((x) => `${x.header}: ${x.value}`).join('; ') : 'none'}</div>
        {Object.keys(review.budgets).length > 0 && <div><b>Budgets</b>: {Object.entries(review.budgets).map(([k, v]) => `${k} ${v}`).join(', ')}</div>}
        {review.requestedPolicies.length > 0 && <div><b>Requested policies</b>: {review.requestedPolicies.map((p) => `${p.require} (${p.status}): ${p.why}`).join('; ')}</div>}
      </div>
      {review.deferred.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>Declared but not active yet: {review.deferred.join(', ')}</div>}
      {review.warnings.length > 0 && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>Warnings: {review.warnings.join('; ')}</div>}
      {review.blockers.length > 0 && <div role="alert" style={{ fontSize: 12, color: 'var(--red, #e5484d)', marginTop: 8 }}>{review.blockers.map((b) => <div key={b}>{b}</div>)}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={{ ...primary, opacity: review.blockers.length || busy ? 0.5 : 1 }} disabled={review.blockers.length > 0 || busy} onClick={onInstall}>Approve and install</button>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function InstallDetail({ ws, p, onChanged }: { ws: string; p: PluginSummary; onChanged: () => void }) {
  const app = useApp();
  const [d, setD] = useState<PluginDetail | null>(null);
  const load = useCallback(async () => { try { setD(await api.plugin(ws, p.id)); } catch { setD(null); } }, [ws, p.id]);
  useEffect(() => { void load(); }, [load]);
  if (!d) return <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 8 }}>Loading…</div>;
  const isProvider = d.roles.includes('provider');
  const grantOf = (agentId: string) => d.grants.find((g) => g.agentId === agentId)?.level ?? '';
  const setGrant = async (agentId: string, level: string) => {
    try { await api.setPluginGrant(ws, p.id, agentId, level === 'read' || level === 'write' ? level : null); await load(); onChanged(); } catch (e) { app.showToast?.(errText(e)); }
  };
  return (
    <div style={{ marginTop: 10 }} data-testid={`plugin-detail-${p.id}`}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>What this plugin added</div>
      {d.effects.length === 0 ? <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Nothing yet.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
          <tbody>
            {d.effects.map((e) => (
              <tr key={e.id}><td style={{ ...td, ...mono, width: 28 }}>{e.seq}</td><td style={td}>{e.kind}</td><td style={{ ...td, ...mono }}>{e.ref}</td><td style={{ ...td, color: e.state === 'live' ? 'var(--green)' : 'var(--text-faint)' }}>{e.state}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {d.conformance.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Conformance</div>
          {d.conformance.slice(0, 4).map((r) => (
            <div key={r.id} style={{ fontSize: 11.5, marginTop: 3 }} data-testid="conformance-run">
              <Pill text={`${r.result}${r.candidate ? ' (candidate)' : ''}`} tone={r.result === 'pass' ? 'var(--green)' : 'var(--red, #e5484d)'} /> {r.mode} · {r.startedAt.slice(0, 16).replace('T', ' ')}
              {r.cases.filter((c) => !c.ok).map((c) => <div key={c.id} style={{ color: 'var(--red, #e5484d)', marginLeft: 8 }}>{c.id}: {c.detail}</div>)}
            </div>
          ))}
        </div>
      )}
      {isProvider && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Agents with access</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Off by default. Read offers the read operations; write offers every operation through the current bindings.</div>
          {(app.agents ?? []).map((a) => (
            <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 4 }}>
              <span style={{ flex: 1 }}>{a.name}</span>
              <select aria-label={`Access for ${a.name}`} value={grantOf(a.id)} onChange={(e) => void setGrant(a.id, e.target.value)} style={{ fontSize: 11.5 }}>
                <option value="">none</option><option value="read">read</option><option value="write">write</option>
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Versions an install can move to, each with its permission diff (§6.5). */
function UpdatesPanel({ ws, p, onChanged }: { ws: string; p: PluginSummary; onChanged: () => void }) {
  const app = useApp();
  const [u, setU] = useState<PluginUpdates | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => api.pluginUpdates(ws, p.id)).then(setU).catch(() => setU(null)); }, [ws, p.id, p.version, p.status]);
  if (!u) return null;
  if (u.updates.length === 0) return <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }} data-testid={`updates-${p.id}`}>No other version to move to.</div>;
  const go = async (source: PluginSource, version: string) => {
    setBusy(true);
    try {
      const r = await api.updatePlugin(ws, p.id, source);
      app.showToast?.(r.applied ? `${p.name} moved to ${version}` : `${p.name} ${version} waits for your approval: it widens what the plugin may do`);
      onChanged();
    } catch (e) { app.showToast?.(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 8 }} data-testid={`updates-${p.id}`}>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{p.status === 'frozen' ? 'Versions that are not recalled' : 'Updates'}</div>
      {u.updates.map((x) => (
        <div key={x.version} style={{ fontSize: 11.5, marginTop: 4, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ ...mono, fontWeight: 600 }}>{x.version}</span>
          <Pill text={x.widening ? 'widens access' : 'no new access'} tone={x.widening ? 'var(--amber)' : 'var(--green)'} />
          <span style={{ color: 'var(--text-dim)', flex: 1, minWidth: 160 }}>{x.diff.filter((d) => d.widening).map((d) => `${d.path}: ${d.detail}`).join('; ') || x.changelog || 'No permission change.'}</span>
          <button type="button" style={btn} disabled={busy || !x.compatible} onClick={() => void go(x.source, x.version)}>{x.newer ? 'Update' : 'Move'} to {x.version}</button>
        </div>
      ))}
    </div>
  );
}

function InterfaceCard({ ws, i, onChanged }: { ws: string; i: InterfaceView; onChanged: () => void }) {
  const app = useApp();
  const def = i.bindings.find((b) => b.scopeKind === 'workspace');
  const bindable = i.providers.filter((p) => p.status === 'conformant');
  const setDefault = async (providerId: string) => {
    try { await api.setBinding(ws, i.name, { major: i.major, scopeKind: 'workspace', providerId: providerId || null }); onChanged(); } catch (e) { app.showToast?.(errText(e)); }
  };
  return (
    <div style={card} data-testid={`interface-${i.name}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, ...mono }}>{i.name}@{i.version}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{i.semantics}</span>
        <label style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center' }}>Workspace default
          <select aria-label={`Default provider for ${i.name}`} value={def?.providerId ?? ''} onChange={(e) => void setDefault(e.target.value)} style={{ fontSize: 11.5 }}>
            <option value="">unbound</option>
            {bindable.map((p) => <option key={p.id} value={p.id}>{p.pluginId}</option>)}
          </select>
        </label>
      </div>
      {!def && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>Unbound: agents see none of its operations, and calls are refused with the candidates named.</div>}
      {i.bindings.filter((b) => b.scopeKind !== 'workspace').map((b) => (
        <div key={b.id} style={{ fontSize: 11.5, marginTop: 4 }}>{b.scopeKind} <span style={mono}>{b.scopeRef}</span> → {b.pluginId}</div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {i.providers.map((p) => <Pill key={p.id} text={`${p.pluginId}: ${p.status}${p.healthy ? '' : ' (not healthy)'}`} tone={p.status === 'conformant' ? 'var(--green)' : 'var(--red, #e5484d)'} />)}
        {i.providers.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>No provider installed.</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {i.operations.map((o) => <span key={o.op} title={o.floorReasons.join('; ')} style={{ fontSize: 10.5, ...mono, color: CLASS_TONE[o.effectiveClass] }}>{o.tool}</span>)}
      </div>
    </div>
  );
}

export function PluginsPane() {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<PluginSummary[]>([]);
  const [ifaces, setIfaces] = useState<InterfaceView[]>([]);
  const [review, setReview] = useState<{ source: PluginSource; r: PluginReview } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const [c, p, i] = await Promise.all([api.pluginCatalog(ws), api.plugins(ws), api.interfaces(ws)]);
      setCatalog(c); setInstalled(p); setIfaces(i); setError('');
    } catch (e) { setError(errText(e)); }
  }, [ws]);
  useEffect(() => { void load(); }, [load]);

  const startReview = async (id: string) => {
    setBusy(true);
    try { setReview({ source: { firstParty: id }, r: await api.reviewPlugin(ws, { firstParty: id }) }); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  /** Your own plugin folder, uploaded as text through the loader's rules: it installs as name@local, in this workspace only. */
  const loadFolder = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      const files = await folderFiles(Array.from(list));
      const source: PluginSource = { files };
      setReview({ source, r: await api.reviewPlugin(ws, source) });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const install = async () => {
    if (!review) return;
    setBusy(true);
    try { await api.installPlugin(ws, review.source); app.showToast?.(`${review.r.name} installed`); setReview(null); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  const act = async (id: string, what: 'disable' | 'enable' | 'conformance' | 'uninstall' | 'approve' | 'decline') => {
    setBusy(true);
    try {
      if (what === 'uninstall') await api.uninstallPlugin(ws, id);
      else if (what === 'approve' || what === 'decline') await api.decidePluginUpdate(ws, id, what === 'approve');
      else await api.pluginAction(ws, id, what);
      await load();
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <div role="alert" style={{ ...card, fontSize: 12.5, color: 'var(--red, #e5484d)' }}>{error}</div>}
      {review && <ReviewPanel review={review.r} busy={busy} onInstall={() => void install()} onCancel={() => setReview(null)} />}

      <div style={card}>
        <div style={h}>Installed</div>
        {installed.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>No plugins yet. Install an interface, then a provider of it, then bind it.</div>}
        {installed.map((p) => (
          <div key={p.id} style={{ borderTop: '1px solid var(--border)', padding: '9px 0' }} data-testid={`plugin-${p.id}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>{p.id}@{p.version}</span>
              {p.roles.map((r) => <Pill key={r} text={r} />)}
              <span data-testid={`plugin-status-${p.id}`}><Pill text={statusText(p)} tone={p.status === 'active' ? 'var(--green)' : p.status === 'disabled' ? undefined : 'var(--red, #e5484d)'} /></span>
              <span style={{ flex: 1 }} />
              <button type="button" style={btn} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide' : 'Details'}</button>
              {p.roles.includes('provider') && <button type="button" style={btn} disabled={busy} onClick={() => void act(p.id, 'conformance')}>Run conformance</button>}
              {p.status === 'disabled'
                ? <button type="button" style={btn} disabled={busy} onClick={() => void act(p.id, 'enable')}>Enable</button>
                : <button type="button" style={btn} disabled={busy} onClick={() => void act(p.id, 'disable')}>Disable</button>}
              <button type="button" style={btn} disabled={busy} onClick={() => void act(p.id, 'uninstall')}>Uninstall</button>
            </div>
            {p.providers.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 }}>
                {p.providers.map((pr) => <span key={pr.id} style={{ marginRight: 10 }}>{pr.interface}@{pr.range}: conformance <b>{pr.status}</b></span>)}
              </div>
            )}
            {p.pendingUpdate && (
              <div style={{ fontSize: 11.5, marginTop: 6 }} data-testid={`pending-${p.id}`}>
                Update to {p.pendingUpdate.version} waits for you{p.pendingUpdate.failures?.length ? ` — it fails conformance: ${p.pendingUpdate.failures.join('; ')}` : ''}.
                {' '}{(p.pendingUpdate.diff ?? []).filter((d) => d.widening).map((d) => `${d.path}: ${d.detail}`).join('; ')}
                {' '}<button type="button" style={btn} disabled={busy || Boolean(p.pendingUpdate.failures?.length)} onClick={() => void act(p.id, 'approve')}>Approve</button>
                {' '}<button type="button" style={btn} disabled={busy} onClick={() => void act(p.id, 'decline')}>Decline</button>
              </div>
            )}
            {p.status === 'frozen' && (
              <div role="alert" data-testid={`recall-${p.id}`} style={{ fontSize: 11.5, marginTop: 6, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--red, #e5484d)', color: 'var(--text-dim)' }}>
                <b style={{ color: 'var(--red, #e5484d)' }}>Frozen.</b> {p.recall?.notice ?? p.suspendedReason}. Its tools are gone and its dependants are suspended; move it to a version that is not recalled, or uninstall it.
              </div>
            )}
            {(open === p.id || p.status === 'frozen') && <UpdatesPanel ws={ws} p={p} onChanged={() => void load()} />}
            {open === p.id && <InstallDetail ws={ws} p={p} onChanged={() => void load()} />}
          </div>
        ))}
      </div>

      {ifaces.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ ...h, marginBottom: 0 }}>Interfaces and bindings</div>
          {ifaces.map((i) => <InterfaceCard key={i.name} ws={ws} i={i} onChanged={() => void load()} />)}
        </div>
      )}

      <div style={card}>
        <div style={h}>Load your own plugin</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          Pick a folder with a <span style={mono}>plugin.json</span> whose id ends in <span style={mono}>@local</span>. It is read as text and checked like any package: no scripts, no binaries, no package scripts, nothing runs at install. It installs in this workspace only, after the same review. More plugins are on Foundry&apos;s Plugins shelf.
        </div>
        <label style={{ ...btn, display: 'inline-block', marginTop: 8 }}>
          Choose a folder…
          <input type="file" aria-label="Plugin folder" multiple {...({ webkitdirectory: '' } as Record<string, string>)} style={{ display: 'none' }} onChange={(e) => { void loadFolder(e.target.files); e.target.value = ''; }} />
        </label>
      </div>

      <div style={card}>
        <div style={h}>First-party plugins</div>
        {catalog.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border)', padding: '8px 0' }} data-testid={`catalog-${c.id}`}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.name} <span style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>{c.id}@{c.version}</span></div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{c.description}</div>
            </div>
            {c.installed
              ? <Pill text={c.updateAvailable ? 'update available' : 'installed'} />
              : <button type="button" style={btn} disabled={busy} onClick={() => void startReview(c.id)}>Review</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
