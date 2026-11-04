/** Foundry's new shelves (docs/foundry.md §8): the Plugins shelf — a parts
 *  list of interfaces, providers and consumers with tier badges, role,
 *  interface and tier filters and search — the plugin detail page (the
 *  contract sheet: every operation with the class yaam will treat it as,
 *  egress, data sharing, secrets, conformance per interface version,
 *  versions with their pins and recalls, the publisher) whose Install opens
 *  the Phase 1 review, and the Kits shelf: the shipped kits with their
 *  review (the plan), install, upgrade, rollback and uninstall, and the
 *  designed ones still to come. */
import { useCallback, useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import {
  api, type FoundryOperation, type FoundryPlugin, type FoundryPluginDetail, type FoundryPluginList, type KitChoices, type KitDetail, type KitPlan, type KitPreview, type PluginReview,
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

/** The Kits shelf (docs/foundry.md §8): the shipped kits — installable, with
 *  their state here — and the designed ones still to come. */
export function KitsShelf({ nav, setNav }: { nav: MarketNav; setNav: (p: Partial<MarketNav>) => void }) {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [kits, setKits] = useState<KitPreview[] | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => { void api.foundryKits(ws || undefined).then(setKits).catch((e) => setFailed(errorText(e))); }, [ws]);
  const shown = (kits ?? []).filter((k) => !nav.fn || k.functions.includes(nav.fn));
  const shipped = shown.filter((k) => k.installable);
  const soon = shown.filter((k) => !k.installable);
  return (
    <>
      {failed && <div role="alert" style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 14 }}>Could not load the kits: {failed}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 14, marginTop: 16 }}>
        {shipped.map((k) => <KitCard key={k.id} k={k} onOpen={() => setNav({ kit: k.id })} />)}
      </div>
      {soon.length > 0 && <>
        <h3 data-testid="kits-coming" style={{ fontSize: 13.5, fontWeight: 650, margin: '26px 0 2px' }}>Coming next</h3>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Designed, waiting on the interfaces they need. You can read what each will bring.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 290px), 1fr))', gap: 14, marginTop: 12 }}>
          {soon.map((k) => <KitCard key={k.id} k={k} />)}
        </div>
      </>}
    </>
  );
}

function KitCard({ k, onOpen }: { k: KitPreview; onOpen?: () => void }) {
  const slug = k.id.split('@')[0];
  const inst = k.installed ?? null;
  return (
    <div data-testid={`kit-${slug}`} style={{ border: `1px ${k.installable ? 'solid' : 'dashed'} var(--border)`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0, background: 'var(--panel)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700, flex: 1, minWidth: 0 }}>{k.name}</span>
        {k.installable
          ? (inst ? <span data-testid={`kit-state-${slug}`} style={{ fontSize: 11.5, fontWeight: 600, color: inst.status === 'active' ? 'var(--green)' : 'var(--amber)', whiteSpace: 'nowrap' }}>Installed · {inst.status}{inst.updateAvailable ? ' · update' : ''}</span>
            : <TierBadge tier="first_party" />)
          : <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--amber)', whiteSpace: 'nowrap' }}>Coming soon</span>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>{k.summary ?? k.blurb}</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {k.interfaces.map((i) => (
          <span key={i.name} title={i.planned ? 'Not written yet' : i.optional ? 'Optional' : 'Required'} style={{ ...mono, fontSize: 11, padding: '1px 7px', borderRadius: 5, border: `1px ${i.optional ? 'dashed' : 'solid'} var(--border-soft)`, color: i.planned ? 'var(--text-faint)' : 'var(--text-dim)' }}>{i.name}</span>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        <div><span style={{ color: 'var(--text-dim)' }}>People:</span> {k.seats.join(', ') || '—'}</div>
        {k.playbooks && k.playbooks.length > 0 && <div><span style={{ color: 'var(--text-dim)' }}>Playbooks:</span> {k.playbooks.join(', ')}</div>}
        <div><span style={{ color: 'var(--text-dim)' }}>Rhythm:</span> {k.cadences.slice(0, 3).join(', ')}{k.cadences.length > 3 ? ` and ${k.cadences.length - 3} more` : ''}</div>
        <div><span style={{ color: 'var(--text-dim)' }}>Measures:</span> {k.metrics.join(', ')}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border-soft)' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>{k.functions.map((f) => functionMeta(f).label).join(', ')}</span>
        {k.installable
          ? <button onClick={onOpen} style={{ font: 'inherit', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: inst ? 'transparent' : 'var(--accent)', color: inst ? 'var(--accent-hi)' : '#fff', cursor: 'pointer' }}>{inst ? 'Manage' : 'Review and add'}</button>
          : <button disabled aria-disabled="true" title="This kit's interfaces are not written yet" style={{ font: 'inherit', fontSize: 12, padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-faint)', cursor: 'not-allowed' }}>Not installable yet</button>}
      </div>
    </div>
  );
}

const pill = (on: boolean): React.CSSProperties => ({ font: 'inherit', fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent)' : 'var(--panel)', color: on ? '#fff' : 'var(--text)' });

/** A kit's page: what it brings, the review (the plan) with the owner's choices, then install; or, once installed, its health, updates, rollback and uninstall. */
export function KitDetailPage({ id, onBack }: { id: string; onBack: () => void }) {
  const app = useApp();
  const ws = app.workspaceId ?? '';
  const [detail, setDetail] = useState<KitDetail | null>(null);
  const [plan, setPlan] = useState<KitPlan | null>(null);
  const [choices, setChoices] = useState<KitChoices>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState('');
  const [removal, setRemoval] = useState<Array<{ kind: string; key: string; outcome: string }> | null>(null);
  const load = useCallback(async () => {
    setFailed('');
    try { setDetail(await api.foundryKit(id, ws || undefined)); } catch (e) { setFailed(errorText(e)); }
  }, [id, ws]);
  useEffect(() => { void load(); }, [load]);
  const installed = detail?.install ?? null;
  useEffect(() => {
    if (!ws || installed) return;
    let live = true;
    api.kitPlan(ws, id, choices).then((p) => { if (live) setPlan(p); }).catch((e) => { if (live) setMsg(errorText(e)); });
    return () => { live = false; };
  }, [ws, id, choices, installed]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setMsg('');
    try { await fn(); if (done) setMsg(done); setRemoval(null); await load(); } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
  };
  if (failed) return <div role="alert" style={{ marginTop: 18, fontSize: 13 }}>Could not load the kit: {failed} <button onClick={onBack} style={{ ...pill(false), marginLeft: 8 }}>Back</button></div>;
  if (!detail) return <div style={{ marginTop: 18, fontSize: 13, color: 'var(--text-dim)' }}>Loading…</div>;
  return (
    <article data-testid="kit-detail" style={{ marginTop: 16 }}>
      <button onClick={onBack} style={{ font: 'inherit', fontSize: 12.5, background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', cursor: 'pointer' }}>← All kits</button>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{detail.name}</h2>
        <span style={{ ...mono, fontSize: 12, color: 'var(--text-faint)' }}>{detail.id} {detail.version}</span>
        <TierBadge tier="first_party" />
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.55, maxWidth: 680 }}>{detail.summary}{detail.description ? ` ${detail.description}` : ''}</p>
      {msg && <div role="status" data-testid="kit-message" style={{ fontSize: 12.5, padding: '8px 11px', borderRadius: 9, background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}>{msg}</div>}

      {installed ? (
        <Section title="Installed here" testid="kit-installed">
          <div style={{ fontSize: 13 }}>Version <span style={mono}>{installed.version}</span> · <b style={{ color: installed.status === 'active' ? 'var(--green)' : 'var(--amber)' }}>{installed.status}</b>{installed.statusReason ? ` — ${installed.statusReason}` : ''}</div>
          <ul style={{ margin: '8px 0', paddingLeft: 18, fontSize: 12.5 }}>
            {installed.health.map((h) => <li key={h.interface}><span style={mono}>{h.interface}</span>: {h.healthy ? `bound to ${h.boundTo}` : <span style={{ color: 'var(--amber)' }}>no healthy provider bound</span>}</li>)}
          </ul>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{installed.members.filter((m) => m.state === 'live').length} parts: {[...new Set(installed.members.filter((m) => m.state === 'live').map((m) => m.kind))].join(', ')}. Parts that were here before the kit are reused, never removed by it.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {installed.update && <button disabled={busy} style={pill(true)} onClick={() => void act(() => api.kitUpgrade(ws, detail.id), `Upgraded to ${installed.update!.version}.`)}>Upgrade to {installed.update.version}</button>}
            {installed.revisions.some((r) => !r.rolledBackAt) && <button disabled={busy} style={pill(false)} onClick={() => void act(() => api.kitRollback(ws, detail.id), 'Rolled back.')}>Roll back to {installed.revisions.find((r) => !r.rolledBackAt)!.from}</button>}
            <button disabled={busy} style={pill(false)} onClick={() => void api.kitUninstallPlan(ws, detail.id).then((p) => setRemoval(p.items)).catch((e) => setMsg(errorText(e)))}>Uninstall…</button>
          </div>
          {installed.update?.changelog && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{installed.update.changelog}</div>}
          {removal && (
            <div data-testid="kit-uninstall-plan" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', fontSize: 12.5 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>What uninstall does</div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{removal.map((r) => <li key={`${r.kind}:${r.key}`}><span style={mono}>{r.kind} {r.key}</span>: {r.outcome}</li>)}</ul>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button disabled={busy} style={{ ...pill(true), background: 'var(--red, #e5484d)', borderColor: 'var(--red, #e5484d)' }} onClick={() => void act(() => api.kitUninstall(ws, detail.id), 'Uninstalled. Seats and data stay.')}>Uninstall</button>
                <button style={pill(false)} onClick={() => setRemoval(null)}>Cancel</button>
              </div>
            </div>
          )}
        </Section>
      ) : plan && <KitReview plan={plan} choices={choices} setChoices={setChoices} busy={busy}
        onInstall={() => void act(async () => { const r = await api.kitInstall(ws, detail.id, choices); setMsg(`Installed: ${r.install.status}${r.install.statusReason ? ` — ${r.install.statusReason}` : ''}.`); }, '')} />}

      <Section title="Playbooks">
        {detail.playbookList.map((p) => <div key={p.name} style={{ fontSize: 12.5, padding: '4px 0' }}><b>{p.name}</b> — {p.description}</div>)}
      </Section>
      <Section title="Guidance for agents">
        {detail.guidanceNotes.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>None.</div> : detail.guidanceNotes.map((g) => <div key={g.id} style={{ fontSize: 12.5, padding: '4px 0' }}><b>{g.title}</b> <span style={{ color: 'var(--text-faint)' }}>for {g.audience.join(', ')}</span><div style={{ color: 'var(--text-dim)' }}>{g.text}</div></div>)}
      </Section>
      {detail.changelog && <Section title="Changelog"><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{detail.changelog}</div></Section>}
    </article>
  );
}

/** The review screen (docs/foundry.md §4.2): every choice and every consent on one page; Install writes exactly what it shows. */
function KitReview({ plan, choices, setChoices, busy, onInstall }: { plan: KitPlan; choices: KitChoices; setChoices: (c: KitChoices) => void; busy: boolean; onInstall: () => void }) {
  const newPlugins = plan.plugins.filter((p) => p.state === 'new');
  return (
    <div data-testid="kit-review">
      <Section title="Providers" testid="kit-providers">
        {plan.interfaces.map((i) => (
          <div key={i.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
            <span style={{ ...mono, fontSize: 12.5, minWidth: 110 }}>{i.name}{i.optional ? ' (optional)' : ''}</span>
            <select aria-label={`Provider for ${i.name}`} value={i.choice} onChange={(e) => setChoices({ ...choices, providers: { ...(choices.providers ?? {}), [i.name]: e.target.value } })} style={{ font: 'inherit', fontSize: 12.5, padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--panel-2)', color: 'var(--text)' }}>
              {i.options.map((o) => <option key={o.id} value={o.id} disabled={!o.available}>{o.name}{o.trial ? ' — trial' : ''}{o.available ? '' : ' — not available yet'}</option>)}
              <option value="later">Decide later</option>
            </select>
            {i.note && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{i.note}</span>}
            {i.options.find((o) => o.id === i.choice)?.trial && <span style={{ fontSize: 11.5, color: 'var(--amber)' }}>Trial: fixtures, no vendor account</span>}
          </div>
        ))}
      </Section>
      <Section title={`Plugins it adds (${newPlugins.length})`} testid="kit-plugins">
        {plan.plugins.map((p) => (
          <details key={p.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border-soft)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5 }}><span style={mono}>{p.id}</span> <span style={{ color: 'var(--text-faint)' }}>{p.role}{p.interface ? ` of ${p.interface}` : ''} · {p.state}</span></summary>
            {p.review && <div style={{ fontSize: 12, color: 'var(--text-dim)', margin: '6px 0 0 14px' }}>
              <div>{p.review.description}</div>
              {p.review.operations.length > 0 && <div style={{ marginTop: 4 }}><ClassStrip ops={p.review.operations} /> {p.review.operations.map((o) => `${o.op} ${CLASS_LABEL[o.effectiveClass] ?? o.effectiveClass}${o.twoKey ? ' (two-key)' : ''}`).join('; ')}</div>}
              {p.review.contributions && <div style={{ marginTop: 4 }}>Adds {p.review.contributions.skills.length} skill(s), {p.review.contributions.guidance.length} guidance note(s), {Object.values(p.review.contributions.ui).flat().length} UI element(s){Object.values(p.review.contributions.ui).flat().length ? `: ${Object.values(p.review.contributions.ui).flat().map((u) => `${u.title ?? u.id}${u.placement ? ` on ${u.placement}` : ''}`).join(', ')}` : ''}.</div>}
              <div style={{ marginTop: 2 }}>{p.review.egress.length ? `Reaches ${p.review.egress.map((e) => e.host).join(', ')}` : 'Reaches no host outside yaam.'}</div>
            </div>}
          </details>
        ))}
      </Section>
      <Section title="Policies (only ever stricter)">
        {plan.policies.length === 0 ? <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>None.</div> : plan.policies.map((p) => <div key={p.id} style={{ fontSize: 12.5, padding: '3px 0' }}><span style={mono}>{p.match.operation ?? p.match.changeKind}</span> → {p.require.replace('_', ' ')} <span style={{ color: 'var(--text-faint)' }}>({p.status})</span> — {p.why}</div>)}
      </Section>
      <Section title="People" testid="kit-seats">
        {!plan.company && <div style={{ fontSize: 12.5, color: 'var(--amber)', marginBottom: 6 }}>This workspace has no company yet: seats are listed, not hired. Start a company to staff them.</div>}
        {plan.seats.map((s) => (
          <label key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '4px 0' }}>
            <input type="checkbox" aria-label={`Seat ${s.title}`} checked={s.on} disabled={s.hire === 'required' || !plan.company} onChange={(e) => setChoices({ ...choices, seats: { ...(choices.seats ?? {}), [s.key]: e.target.checked } })} />
            <span><b>{s.title}</b> <span style={{ color: 'var(--text-faint)' }}>role:{s.role} · {s.hire}{s.filledBy ? ` · uses ${s.filledBy.name}` : ''}{Object.keys(s.grants).length ? ` · grants ${Object.entries(s.grants).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}</span></span>
          </label>
        ))}
      </Section>
      <Section title="Playbooks and guidance, in full">
        {plan.playbooks.map((p) => <details key={p.name} style={{ fontSize: 12.5, padding: '3px 0' }}><summary style={{ cursor: 'pointer' }}><b>{p.name}</b> — {p.description}</summary><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-dim)', margin: '6px 0 0 14px' }}>{p.text}</pre></details>)}
        {plan.guidance.map((g) => <div key={g.id} style={{ fontSize: 12.5, padding: '3px 0' }}><b>{g.title}</b> <span style={{ color: 'var(--text-faint)' }}>for {g.audience.join(', ')}</span>: {g.text}</div>)}
      </Section>
      {(plan.rhythm.length > 0 || plan.measures.length > 0) && <Section title="Rhythm and measures (described)"><div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{plan.rhythm.join('; ')}{plan.measures.length ? `. Measured by ${plan.measures.join(', ')}.` : ''}</div></Section>}
      <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button data-testid="kit-install" disabled={busy || plan.blockers.length > 0} onClick={onInstall} style={{ ...pill(true), padding: '7px 16px', opacity: plan.blockers.length ? 0.5 : 1 }}>Add to my company</button>
        <span style={{ fontSize: 12.5, color: plan.outcome === 'active' ? 'var(--text-dim)' : 'var(--amber)' }}>{plan.outcome === 'active' ? 'Everything it needs is chosen.' : plan.outcome}</span>
      </div>
      {plan.blockers.length > 0 && <ul role="alert" style={{ fontSize: 12.5, color: 'var(--red, #e5484d)', paddingLeft: 18 }}>{plan.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
    </div>
  );
}
