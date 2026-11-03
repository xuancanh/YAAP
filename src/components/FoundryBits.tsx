/** Foundry's new shelves (docs/foundry.md §8): the Plugins shelf — a parts
 *  list of interfaces, providers and consumers with tier badges, role,
 *  interface and tier filters and search — the plugin detail page (the
 *  contract sheet: every operation with the class yaam will treat it as,
 *  egress, data sharing, secrets, conformance per interface version,
 *  versions with their pins and recalls, the publisher) whose Install opens
 *  the Phase 1 review, and the Kits shelf of previews. */
import { useCallback, useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import {
  api, type FoundryOperation, type FoundryPlugin, type FoundryPluginDetail, type FoundryPluginList, type KitPreview, type PluginReview,
} from '../lib/api';
import { functionMeta, type MarketNav, type PluginFilter } from '../lib/market';
import { CLASS_LABEL, ReviewPanel } from './PluginsPane';
import { CLASS_ORDER, TIER_BLURB, TIER_LABEL, TIER_TONE, classMix, errorText, pluginKindLabel, recallSentence, roleLabel } from '../lib/foundry';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const CLASS_TONE: Record<string, string> = {
  read: 'var(--green)', internal_write: 'var(--text-dim)', external_reversible: 'var(--accent-hi)', external_irreversible: 'var(--red, #e5484d)', money: 'var(--red, #e5484d)',
};

export function TierBadge({ tier }: { tier: string }) {
  const tone = TIER_TONE[tier] ?? 'var(--text-dim)';
  return (
    <span data-testid={`tier-${tier}`} title={TIER_BLURB[tier]} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: tone, whiteSpace: 'nowrap' }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: tier === 'first_party' ? 2 : tier === 'verified' ? 7 : 1, background: tier === 'local' ? 'transparent' : tone, border: `1.5px solid ${tone}`, transform: tier === 'community' ? 'rotate(45deg)' : undefined }} />
      {TIER_LABEL[tier] ?? tier}
    </span>
  );
}

/** How an interface's operations split across the action classes: one strip, read on the left, money on the right. */
export function ClassStrip({ ops, height = 6 }: { ops: Array<Pick<FoundryOperation, 'effectiveClass'>>; height?: number }) {
  const mix = classMix(ops);
  if (mix.length === 0) return null;
  return (
    <div role="img" aria-label={mix.map((m) => `${m.count} ${CLASS_LABEL[m.cls] ?? m.cls}`).join(', ')} style={{ display: 'flex', height, borderRadius: height, overflow: 'hidden', gap: 2, minWidth: 60 }}>
      {mix.map((m) => <span key={m.cls} style={{ flex: m.count, background: CLASS_TONE[m.cls] ?? 'var(--border)', opacity: m.cls === 'internal_write' ? 0.5 : 0.85 }} />)}
    </div>
  );
}

const chip = (active: boolean): React.CSSProperties => ({
  font: 'inherit', padding: '5px 12px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text-dim)',
});
const ifaceTag = (name: string, how: string) => (
  <span key={`${how}-${name}`} title={how} style={{ ...mono, fontSize: 11, padding: '1px 7px', borderRadius: 5, border: '1px solid var(--border-soft)', background: 'var(--panel-2)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
    {how === 'provides' ? '↳ ' : how === 'requires' ? '← ' : ''}{name}
  </span>
);

/** The kind filter row of the Plugins shelf; Connectors and Skills & apps render the existing departments. */
export function PluginFilters({ nav, setNav, counts }: { nav: MarketNav; setNav: (p: Partial<MarketNav>) => void; counts?: FoundryPluginList['facets']['roles'] }) {
  return (
    <div role="group" aria-label="Plugin kind" style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 16 }}>
      {(['', 'interface', 'provider', 'consumer', 'connectors', 'skills'] as PluginFilter[]).map((f) => (
        <button key={f || 'all'} aria-pressed={(nav.pf ?? '') === f} onClick={() => setNav({ pf: f, plugin: '' })} style={chip((nav.pf ?? '') === f)}>
          {pluginKindLabel(f)}{counts && (f === 'interface' || f === 'provider' || f === 'consumer') ? <span style={{ fontWeight: 500, opacity: 0.7 }}> {counts[f]}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** The parts list: interfaces, providers and consumers. */
export function PluginsShelf({ nav, setNav }: { nav: MarketNav; setNav: (p: Partial<MarketNav>) => void }) {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [q, setQ] = useState('');
  const [data, setData] = useState<FoundryPluginList | null>(null);
  const [failed, setFailed] = useState('');
  const role = nav.pf === 'interface' || nav.pf === 'provider' || nav.pf === 'consumer' ? nav.pf : '';
  useEffect(() => {
    if (!ws) return;
    let live = true;
    setFailed('');
    void api.foundryPlugins(ws, { q: q.trim(), role, iface: nav.iface ?? '', tier: nav.tier ?? '' })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) { setData(null); setFailed(errorText(e)); } });
    return () => { live = false; };
  }, [ws, q, role, nav.iface, nav.tier]);
  const facets = data?.facets;
  return (
    <>
      <PluginFilters nav={nav} setNav={setNav} counts={facets?.roles} />
      <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '7px 11px', flex: 1, minWidth: 200 }}>
          <I d={P.search} size={15} stroke="var(--text-faint)" />
          <input aria-label="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, publisher or interface" style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }} />
        </div>
        <select aria-label="Interface" value={nav.iface ?? ''} onChange={(e) => setNav({ iface: e.target.value })} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px', font: 'inherit', fontSize: 12.5 }}>
          <option value="">Any interface</option>
          {(facets?.interfaces ?? []).map((f) => <option key={f.name} value={f.name}>{f.name} · {f.providers} provider{f.providers === 1 ? '' : 's'}</option>)}
        </select>
        <select aria-label="Tier" value={nav.tier ?? ''} onChange={(e) => setNav({ tier: e.target.value })} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px', font: 'inherit', fontSize: 12.5 }}>
          <option value="">Every tier</option>
          {(['first_party', 'verified', 'community', 'local'] as const).map((t) => <option key={t} value={t}>{TIER_LABEL[t]}{facets ? ` (${facets.tiers[t] ?? 0})` : ''}</option>)}
        </select>
      </div>
      {failed && <div role="alert" style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 14 }}>Could not load the plugins: {failed}</div>}
      {data && data.items.length === 0 && !failed && (
        <div style={{ marginTop: 18, border: '1px dashed var(--border)', borderRadius: 12, padding: 18, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Nothing on this shelf matches. Clear the filters, or load your own plugin folder in Settings › Plugins — it stays in this workspace.
        </div>
      )}
      {data && data.items.length > 0 && (
        <ul aria-label="Plugins" style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)', overflow: 'hidden' }}>
          {data.items.map((p, i) => <PluginRow key={p.id} p={p} first={i === 0} onOpen={() => setNav({ plugin: p.id })} />)}
        </ul>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 12, lineHeight: 1.6 }}>
        An interface decides what a domain&apos;s operations mean and how risky each one is; a provider implements it for one vendor; a consumer works through it. Installing grants nothing to any agent.
      </div>
    </>
  );
}

function PluginRow({ p, first, onOpen }: { p: FoundryPlugin; first: boolean; onOpen: () => void }) {
  const confOk = p.conformance.length > 0 && p.conformance.every((c) => c.result === 'pass');
  return (
    <li data-testid={`plugin-row-${p.id}`} style={{ borderTop: first ? 'none' : '1px solid var(--border-soft)' }}>
      <button onClick={onOpen} aria-label={`${p.name} (${p.id})`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '4px 14px', width: '100%', textAlign: 'left', font: 'inherit', color: 'var(--text)', background: 'none', border: 'none', padding: '13px 16px', cursor: 'pointer' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 650 }}>{p.name}</span>
          <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-faint)' }}>{p.id}{p.version ? `@${p.version}` : ''}</span>
        </span>
        <span style={{ display: 'flex', gap: 10, alignItems: 'center', justifySelf: 'end' }}>
          {p.installed?.status === 'frozen' && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--red, #e5484d)' }}>Frozen</span>}
          {p.installed && p.installed.status !== 'frozen' && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--green)', display: 'inline-flex', gap: 4, alignItems: 'center' }}><I d={P.check} size={12} sw={2.4} />Installed</span>}
          {p.updateAvailable && <span style={{ fontSize: 11.5, color: 'var(--accent-hi)' }}>Update</span>}
          {p.recalled && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--red, #e5484d)' }}>Recalled</span>}
          <TierBadge tier={p.tier} />
        </span>
        <span style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, gridColumn: '1 / -1', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{p.description || 'No description.'}</span>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', gridColumn: '1 / -1', marginTop: 2 }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', marginRight: 2 }}>{p.roles.map(roleLabel).join(' + ')}</span>
          {p.defines.map((n) => ifaceTag(n, 'defines'))}
          {p.provides.map((n) => ifaceTag(n, 'provides'))}
          {p.requires.filter((n) => !p.provides.includes(n)).map((n) => ifaceTag(n, 'requires'))}
          {p.conformance.length > 0 && <span style={{ fontSize: 11.5, color: confOk ? 'var(--green)' : 'var(--amber)' }}>{confOk ? 'conformance passed' : 'conformance not passed'}</span>}
          {p.noEgress && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>no egress</span>}
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', marginLeft: 'auto' }}>{p.publisher.name}</span>
        </span>
      </button>
    </li>
  );
}

function Section({ title, children, testid }: { title: string; children: React.ReactNode; testid?: string }) {
  return (
    <section aria-label={title} data-testid={testid} style={{ marginTop: 22 }}>
      <h3 style={{ fontSize: 14, fontWeight: 650, margin: '0 0 8px' }}>{title}</h3>
      {children}
    </section>
  );
}

function OpsTable({ ops }: { ops: FoundryOperation[] }) {
  const th: React.CSSProperties = { textAlign: 'left', fontWeight: 600, color: 'var(--text-faint)', fontSize: 11, padding: '6px 8px', borderBottom: '1px solid var(--border)' };
  const td: React.CSSProperties = { padding: '6px 8px', fontSize: 12, verticalAlign: 'top', borderBottom: '1px solid var(--border-soft)' };
  const sorted = [...ops].sort((a, b) => CLASS_ORDER.indexOf(a.effectiveClass) - CLASS_ORDER.indexOf(b.effectiveClass));
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}>
        <thead><tr><th style={th}>Operation</th><th style={th}>Treated as</th><th style={th}>What it does</th></tr></thead>
        <tbody>
          {sorted.map((o) => (
            <tr key={o.canonical} data-testid={`op-${o.canonical}`}>
              <td style={{ ...td, ...mono, borderLeft: `3px solid ${CLASS_TONE[o.effectiveClass] ?? 'var(--border)'}`, whiteSpace: 'nowrap' }}>{o.canonical}</td>
              <td style={{ ...td, color: CLASS_TONE[o.effectiveClass], whiteSpace: 'nowrap' }}>
                {CLASS_LABEL[o.effectiveClass] ?? o.effectiveClass}{o.twoKey ? ', two-key' : ''}
                {o.declaredClass && o.declaredClass !== o.effectiveClass && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>declared {CLASS_LABEL[o.declaredClass] ?? o.declaredClass}</div>}
              </td>
              <td style={{ ...td, color: 'var(--text-dim)' }}>
                {o.semantics}
                {(o.outbound || o.movesMoney || o.floorReasons.length > 0) && (
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                    {[o.outbound ? 'sends data out' : '', o.movesMoney ? 'moves money' : '', ...o.floorReasons].filter(Boolean).join('; ')}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const fact = (label: string, value: React.ReactNode) => (
  <div style={{ minWidth: 0 }}>
    <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{label}</div>
    <div style={{ fontSize: 12.5, color: 'var(--text)', marginTop: 2, overflowWrap: 'anywhere' }}>{value}</div>
  </div>
);

/** The plugin detail page; Install runs the Phase 1 review screen, then installs. */
export function PluginDetailPage({ id, onBack, onOpen, onManage }: { id: string; onBack: () => void; onOpen: (id: string) => void; onManage: () => void }) {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [d, setD] = useState<FoundryPluginDetail | null>(null);
  const [failed, setFailed] = useState('');
  const [review, setReview] = useState<PluginReview | null>(null);
  const [optIn, setOptIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setD(await api.foundryPlugin(ws, id)); setFailed(''); } catch (e) { setD(null); setFailed(errorText(e)); }
  }, [ws, id]);
  useEffect(() => { setReview(null); setOptIn(false); setError(''); void load(); }, [load]);

  const startReview = async () => {
    if (!d?.installSource) return;
    setBusy(true); setError('');
    try { setReview(await api.reviewPlugin(ws, d.installSource)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const install = async () => {
    if (!d?.installSource || !review) return;
    setBusy(true); setError('');
    try {
      await api.installPlugin(ws, d.installSource, { acceptCommunity: optIn });
      app.showToast?.(`${d.name} installed`);
      setReview(null);
      await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  const back = <button onClick={onBack} style={{ font: 'inherit', fontSize: 12.5, background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer', marginTop: 16 }}>Back to plugins</button>;
  if (failed) return <>{back}<div role="alert" style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not load {id}: {failed}</div></>;
  if (!d) return <>{back}<div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading {id}…</div></>;
  const caps = d.capabilities;
  const latest = d.versions.find((v) => !v.recalled);
  const conformance = d.versions.find((v) => v.version === d.version)?.conformance ?? [];
  return (
    <article aria-label={`${d.name} plugin`} data-testid="plugin-detail-page">
      {back}
      <header style={{ marginTop: 12, display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-.3px', margin: 0 }}>{d.name}</h2>
            <TierBadge tier={d.tier} />
          </div>
          <div style={{ ...mono, fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>{d.id}{d.version ? `@${d.version}` : ''}</div>
          <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6, margin: '10px 0 0', maxWidth: 620 }}>{d.description}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          {d.installed ? (
            <>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: d.installed.status === 'frozen' ? 'var(--red, #e5484d)' : 'var(--green)' }}>
                {d.installed.status === 'frozen' ? 'Installed, frozen' : `Installed ${d.installed.version}`}
              </span>
              <button onClick={onManage} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Manage in Settings › Plugins</button>
            </>
          ) : d.installSource && d.installable ? (
            <button disabled={busy} onClick={() => void startReview()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>Install</button>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-faint)', maxWidth: 220, textAlign: 'right' }}>{d.recalled ? 'Every version is recalled; it cannot be installed.' : !d.compatible ? `Needs yaam core ${d.coreRange}.` : 'Load it from its folder in Settings › Plugins.'}</span>
          )}
        </div>
      </header>

      {d.installed?.status === 'frozen' && <RecallNotice notice={d.installed.notice} onManage={onManage} />}
      {error && <div role="alert" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--red, #e5484d)' }}>{error}</div>}
      {review && (
        <div style={{ marginTop: 16 }}>
          {review.communityOptIn && (
            <label data-testid="community-opt-in" style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', marginBottom: 10, border: '1px solid var(--amber)', borderRadius: 10, fontSize: 12.5, lineHeight: 1.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} style={{ marginTop: 3 }} />
              <span>Install a community plugin. The registry scanned and reviewed it; no verified publisher signed it. {review.interfaces.length > 0 ? 'Its interface classifies operations, so it also needs the community-interface setting in Settings › Plugins.' : ''}</span>
            </label>
          )}
          <ReviewPanel review={review} busy={busy || (Boolean(review.communityOptIn) && !optIn)} onInstall={() => void install()} onCancel={() => setReview(null)} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, marginTop: 20, padding: '14px 16px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)' }}>
        {fact('Publisher', <>{d.publisher.name}{d.publisher.verifiedDomain ? <span style={{ color: 'var(--text-faint)' }}> ({d.publisher.verifiedDomain})</span> : null}</>)}
        {fact('Role', d.roles.map(roleLabel).join(' + '))}
        {fact('Core API', <span style={mono}>{d.coreRange ?? '—'}{d.compatible ? '' : ' (not this server)'}</span>)}
        {fact('Installs', String(d.installs))}
        {fact('Digest', <span style={mono} title={d.digest ?? ''}>{d.digest ? `${d.digest.slice(0, 12)}…` : '—'}</span>)}
        {d.license && fact('License', d.license)}
      </div>

      {caps && caps.defines.map((i) => (
        <Section key={i.name} title={`Defines ${i.name}@${i.version}`} testid={`defines-${i.name}`}>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 8 }}>{i.semantics}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ flex: '0 1 240px' }}><ClassStrip ops={i.operations} /></div>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{classMix(i.operations).map((m) => `${m.count} ${CLASS_LABEL[m.cls] ?? m.cls}`).join(', ')}</span>
          </div>
          <OpsTable ops={i.operations} />
          {i.changeKinds.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 6 }}>Change records: {i.changeKinds.map((k) => <span key={k} style={mono}>{k} </span>)}</div>}
        </Section>
      ))}
      {caps && caps.provides.map((p) => (
        <Section key={p.interface} title={`Provides ${p.interface}@${p.range}`} testid={`provides-${p.interface}`}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            For {p.resources.map((r) => <span key={r} style={mono}>{r} </span>)}
            {p.resolvedWith ? <> · classes from {p.resolvedWith}</> : <> · the interface is not on the shelf, so classes show once it is</>}
            {p.missingRequired.length > 0 && <span style={{ color: 'var(--red, #e5484d)' }}> · missing required: {p.missingRequired.join(', ')}</span>}
          </div>
          {p.operations.length > 0 && <OpsTable ops={p.operations} />}
        </Section>
      ))}
      {caps && caps.requires.length > 0 && (
        <Section title="Requires">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{caps.requires.map((r) => ifaceTag(r, 'requires'))}</div>
        </Section>
      )}

      {caps && (
        <Section title="What it can reach" testid="reach">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {fact('Egress hosts', caps.egress.length ? caps.egress.map((e) => <div key={e.host} style={mono}>{e.host} <span style={{ color: 'var(--text-faint)' }}>({e.category})</span></div>) : 'None: it reaches no network.')}
            {fact('Data sharing', caps.dataSharing.length ? caps.dataSharing.map((x) => <div key={`${x.category}-${x.to}`}>{x.category} to {x.to}, {x.when === 'ambient' ? 'in the background' : 'per operation'}</div>) : 'None declared.')}
            {fact('Secret slots', caps.secrets.length ? caps.secrets.map((x) => <div key={x.slot} style={{ color: x.inject === 'env' ? 'var(--red, #e5484d)' : undefined }}><span style={mono}>{x.slot}</span> ({x.inject === 'env' ? 'handed to code' : 'through the proxy'})</div>) : 'None.')}
            {fact('Requested policies', caps.requestedPolicies.length ? caps.requestedPolicies.map((x, i) => <div key={i}>{x.require.replace('_', '-')} on <span style={mono}>{x.operation ?? x.changeKind}</span></div>) : 'None.')}
          </div>
        </Section>
      )}

      <Section title="Conformance" testid="conformance">
        {conformance.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Only providers run conformance. Yours runs again locally at install; the registry&apos;s run is shown for comparison.</div>
          : conformance.map((c) => (
            <div key={c.interface} style={{ fontSize: 12.5, marginTop: 4 }}>
              <span style={{ fontWeight: 600, color: c.result === 'pass' ? 'var(--green)' : 'var(--amber)' }}>{c.result === 'pass' ? 'Passed' : c.result === 'unverified' ? 'Unverified' : 'Not passed'}</span>{' '}
              <span style={mono}>{c.interface}{c.interfaceVersion ? `@${c.interfaceVersion}` : `@${c.range}`}</span> in {c.mode} mode, {c.passed} case{c.passed === 1 ? '' : 's'} passed{c.failed ? `, ${c.failed} failed` : ''}
              {c.failures.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.failures.join('; ')}</div>}
            </div>
          ))}
      </Section>

      <Section title="Versions" testid="versions">
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {d.versions.map((v) => (
            <li key={v.version} data-testid={`version-${v.version}`} style={{ padding: '8px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ ...mono, fontWeight: 600, textDecoration: v.recalled ? 'line-through' : undefined }}>{v.version}</span>
                {v === latest && <span style={{ fontSize: 11.5, color: 'var(--accent-hi)' }}>latest</span>}
                {v.installed && <span style={{ fontSize: 11.5, color: 'var(--green)' }}>installed here</span>}
                {v.recalled && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--red, #e5484d)' }}>Recalled{v.recallReason ? `: ${v.recallReason}` : ''}</span>}
                <span style={{ fontSize: 11.5, color: 'var(--text-faint)', marginLeft: 'auto' }}>{v.publishedAt.slice(0, 10)}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>
                <span style={mono} title={v.digest}>sha256 {v.digest.slice(0, 16)}…</span>{v.commitSha ? <> · source <span style={mono}>{v.commitSha.slice(0, 12)}</span></> : null} · core {v.coreRange}
              </div>
              {v.changelog && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{v.changelog}</div>}
            </li>
          ))}
        </ol>
      </Section>

      {d.related.length > 0 && (
        <Section title="Others on these interfaces">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {d.related.map((r) => (
              <button key={r.id} onClick={() => onOpen(r.id)} style={{ font: 'inherit', fontSize: 12.5, display: 'inline-flex', gap: 8, alignItems: 'center', padding: '6px 11px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', cursor: 'pointer' }}>
                {r.name} <TierBadge tier={r.tier} />
              </button>
            ))}
          </div>
        </Section>
      )}
    </article>
  );
}

/** Shown wherever a frozen install appears: why it stopped and what fixes it. */
export function RecallNotice({ notice, onManage }: { notice: string; onManage?: () => void }) {
  return (
    <div role="alert" data-testid="recall-notice" style={{ marginTop: 14, padding: '11px 14px', border: '1px solid var(--red, #e5484d)', borderRadius: 11, background: 'color-mix(in oklab, var(--red, #e5484d) 9%, transparent)', fontSize: 12.5, lineHeight: 1.55 }}>
      <div style={{ fontWeight: 650, color: 'var(--red, #e5484d)' }}>This plugin is frozen</div>
      <div style={{ color: 'var(--text-dim)' }}>{recallSentence(notice)} Its tools are gone and what depends on it is suspended. Move it to a version that is not recalled, or uninstall it.</div>
      {onManage && <button onClick={onManage} style={{ marginTop: 7, font: 'inherit', fontSize: 12.5, fontWeight: 600, background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer' }}>Open Settings › Plugins</button>}
    </div>
  );
}

/** The Kits shelf: the starter catalog as previews, nothing installs yet. */
export function KitsShelf({ nav }: { nav: MarketNav }) {
  const [kits, setKits] = useState<KitPreview[] | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => { void api.foundryKits().then(setKits).catch((e) => setFailed(errorText(e))); }, []);
  const shown = (kits ?? []).filter((k) => !nav.fn || k.functions.includes(nav.fn));
  return (
    <>
      <div data-testid="kits-coming" style={{ marginTop: 18, padding: '14px 16px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--panel-2)', fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 650 }}>Kits are coming — bundles of interfaces, providers and roles for a use case</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>These are the designed starter kits. You can read what each will bring; none can be installed yet. Hire the people from Agents and add the parts from Plugins meanwhile.</div>
      </div>
      {failed && <div role="alert" style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 14 }}>Could not load the kits: {failed}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 14, marginTop: 16 }}>
        {shown.map((k) => (
          <div key={k.id} data-testid={`kit-${k.id}`} style={{ border: '1px dashed var(--border)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0, background: 'var(--panel)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{k.name}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amber)', whiteSpace: 'nowrap' }}>Coming soon</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{k.blurb}</div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {k.interfaces.map((i) => (
                <span key={i.name} title={i.planned ? 'Not written yet' : i.optional ? 'Optional' : 'Required'} style={{ ...mono, fontSize: 11, padding: '1px 7px', borderRadius: 5, border: `1px ${i.optional ? 'dashed' : 'solid'} var(--border-soft)`, color: i.planned ? 'var(--text-faint)' : 'var(--text-dim)' }}>{i.name}</span>
              ))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              <div><span style={{ color: 'var(--text-dim)' }}>People:</span> {k.seats.join(', ')}</div>
              <div><span style={{ color: 'var(--text-dim)' }}>Rhythm:</span> {k.cadences.slice(0, 4).join(', ')}{k.cadences.length > 4 ? ` and ${k.cadences.length - 4} more` : ''}</div>
              <div><span style={{ color: 'var(--text-dim)' }}>Measures:</span> {k.metrics.join(', ')}</div>
              <div><span style={{ color: 'var(--text-dim)' }}>Works with:</span> {k.providers.slice(0, 5).join(', ')}{k.providers.length > 5 ? '…' : ''}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border-soft)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{k.functions.map((f) => functionMeta(f).label).join(', ')}</span>
              <button disabled aria-disabled="true" title="Kits are not installable yet" style={{ font: 'inherit', fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-faint)', cursor: 'not-allowed' }}>Not installable yet</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
