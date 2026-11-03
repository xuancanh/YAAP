/** Agent Market: registry cards + the capability-review hire modal (FR-11.7),
 *  in two layers — Personal (categories) and Business (job functions, a head
 *  and its team; docs/agent-catalog.md "Segments and functions") — the
 *  Connectors department (docs/integrations.md §4a), and the Community
 *  department — the publish/install registry (docs/registry.md). */
import { useEffect, useRef, useState, lazy, Suspense } from 'react';
import { I, P, CAP_ICON } from '../lib/icons';
import { api, type CompanyRegistryItem, type Connection, type ConnectorEntry, type MarketItem, type RegistryItem, type RegistryKind, type RegistryList } from '../lib/api';
import { useApp, gradPair } from '../store';
import {
  bizFunctions, bySegment, cadenceLine, defaultReportsTo, functionMeta, functionPage, marketCats, reportsToName, searchMarket, segmentOf,
  SEGMENT_LABEL, type MarketNav, type MarketSegment,
} from '../lib/market';
import { RegistryReviewModal } from './RegistryBits';
import { KIND_GLYPH, KIND_LABEL, flagCount, fmtInstalls, installSummary, ratingLabel } from '../lib/registry';

const CompanyInstallModal = lazy(() => import('./OrgBlueprintBits').then((m) => ({ default: m.CompanyInstallModal })));

type Dept = 'agents' | 'connectors' | 'community' | 'companies';
const DEPT_LABEL: Record<Dept, string> = { agents: 'Agents', connectors: 'Connectors', community: 'Community', companies: 'Companies' };
const DEPT_BLURB: Record<Dept, string> = {
  agents: 'Hire durable agents from the registry. Each install runs a capability review first — imported loops enable immediately.',
  connectors: 'Connect the services your agents work with. Connecting grants nothing to any agent — access stays a per-agent grant.',
  community: 'Agents, skills and mini apps published by people like you. Every install shows the scan and the real text first, and lands inert: loops off, skills as drafts, capabilities parked.',
  companies: 'Whole companies as blueprints (docs/blueprints.md): roles, charters, scopes, cadences, playbooks and a budget — never memory or credentials. Installing shows the review and the dry-run plan first; hires wait on one approval card in supervised mode.',
};

export function MarketView({ nav, setNav }: { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void }) {
  const app = useApp();
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState<Dept>('agents');
  const q = search.trim();
  const orgOn = app.companiesEnabled && !!app.wsOrg && app.wsOrg.mode !== 'off';

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: app.stacked ? '20px 16px 60px' : '30px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.4px', flex: 1 }}>Market</div>
          {dept === 'agents' && <SegmentSwitch nav={nav} setNav={setNav} />}
        </div>
        <div style={{ color: 'var(--text-dim)', fontSize: 13.5, marginTop: 4, maxWidth: 560 }}>{dept === 'agents' ? SEGMENT_BLURB[nav.segment] : DEPT_BLURB[dept]}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {(['agents', 'connectors', 'community', ...(app.companiesEnabled ? ['companies' as const] : [])] as Dept[]).map((d) => (
            <div key={d} onClick={() => setDept(d)} style={{ padding: '7px 18px', borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer', border: `1px solid ${d === dept ? 'var(--accent)' : 'var(--border)'}`, background: d === dept ? 'var(--accent-dim)' : 'var(--panel)', color: d === dept ? 'var(--accent-hi)' : 'var(--text-dim)' }}>
              {DEPT_LABEL[d]}
            </div>
          ))}
        </div>
        {dept === 'connectors' && <ConnectorsDept />}
        {dept === 'community' && <CommunityDept />}
        {dept === 'companies' && <CompaniesDept />}
        {dept === 'agents' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '8px 11px', marginTop: 18, minWidth: 0 }}>
            <I d={P.search} size={15} stroke="var(--text-faint)" />
            <input aria-label="Search the market" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search personal and business agents" style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }} />
            {search && <button aria-label="Clear search" onClick={() => setSearch('')} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', display: 'flex', padding: 0 }}><I d={P.x} size={14} /></button>}
          </div>
          {q ? <SearchResults q={q} />
            : nav.segment === 'personal' ? <PersonalSegment nav={nav} setNav={setNav} />
              : <BusinessSegment nav={nav} setNav={setNav} orgOn={orgOn} />}
        </>}
      </div>
    </div>
  );
}

const SEGMENT_BLURB: Record<MarketSegment, string> = {
  personal: 'Agents for your own life and practice. Each hire runs a capability review first — imported loops enable immediately.',
  business: 'A company of agents, by job function. Hire a function head and it hires its own team; every hire shows its playbooks and loops first.',
};

/** The Personal | Business switch in the header (the rail has its twin). */
function SegmentSwitch({ nav, setNav }: { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void }) {
  const app = useApp();
  return (
    <div role="tablist" aria-label="Market segment" style={{ display: 'flex', gap: 3, padding: 3, borderRadius: 11, background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}>
      {(['personal', 'business'] as MarketSegment[]).map((s) => (
        <button key={s} role="tab" aria-selected={nav.segment === s} onClick={() => setNav({ segment: s })}
          style={{ border: 'none', font: 'inherit', fontSize: 13, fontWeight: 700, padding: '6px 14px', borderRadius: 9, cursor: 'pointer', background: nav.segment === s ? 'var(--accent)' : 'none', color: nav.segment === s ? '#fff' : 'var(--text-dim)' }}>
          {SEGMENT_LABEL[s]} <span style={{ fontWeight: 500, opacity: .75 }}>{bySegment(app.market, s).length}</span>
        </button>
      ))}
    </div>
  );
}

const chip = (active: boolean): React.CSSProperties => ({
  font: 'inherit', padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--panel)', color: active ? '#fff' : 'var(--text-dim)',
});

function Grid({ children }: { children: React.ReactNode }) {
  const app = useApp();
  return <div data-cols={app.stacked ? 1 : 2} style={{ display: 'grid', gridTemplateColumns: app.stacked ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))', gap: 16, marginTop: 18 }}>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 18, border: '1px dashed var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 20, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>{children}</div>;
}

function PersonalSegment({ nav, setNav }: { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void }) {
  const app = useApp();
  const cats = marketCats(app.market);
  const cat = cats.includes(nav.cat) ? nav.cat : 'All';
  const items = bySegment(app.market, 'personal').filter((m) => cat === 'All' || m.cat === cat);
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {cats.map((c) => <button key={c} onClick={() => setNav({ cat: c })} aria-pressed={c === cat} style={chip(c === cat)}>{c}</button>)}
      </div>
      {items.length === 0 ? <Empty>{app.market.length === 0 ? 'Loading the catalog…' : 'No personal agent in this category yet.'}</Empty>
        : <Grid>{items.map((m) => <AgentCard key={m.id} m={m} />)}</Grid>}
    </>
  );
}

function BusinessSegment({ nav, setNav, orgOn }: { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void; orgOn: boolean }) {
  const app = useApp();
  const fns = bizFunctions(app.market);
  const fn = fns.find((f) => f.id === nav.fn) ?? null;
  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button onClick={() => setNav({ fn: '' })} aria-pressed={!fn} style={chip(!fn)}>All functions</button>
        {fns.map((f) => <button key={f.id} onClick={() => setNav({ fn: f.id })} aria-pressed={fn?.id === f.id} style={chip(fn?.id === f.id)}>{f.icon} {f.label}</button>)}
      </div>
      {!orgOn && (
        <div style={{ marginTop: 14, padding: '11px 14px', border: '1px solid var(--border-soft)', borderRadius: 12, background: 'var(--panel-2)', fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>This workspace does not run a company yet, so a business agent joins as a standalone agent. Start a company to hire heads that staff their own teams.</span>
          {app.companiesEnabled && <button onClick={() => app.go('workspace')} style={{ ...chip(false), padding: '5px 12px' }}>Start a company</button>}
        </div>
      )}
      {nav.fn && !fn && <Empty>No function called “{nav.fn}”. Pick one above.</Empty>}
      {!fn && !nav.fn && (fns.length === 0
        ? <Empty>{app.market.length === 0 ? 'Loading the catalog…' : 'No business agent in the catalog yet.'}</Empty>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,210px),1fr))', gap: 12, marginTop: 18 }}>
            {fns.map((f) => (
              <button key={f.id} onClick={() => setNav({ fn: f.id })} aria-label={`${f.label}: ${f.count} agents`}
                style={{ textAlign: 'left', font: 'inherit', color: 'var(--text)', cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 14, background: `linear-gradient(160deg, color-mix(in oklab, ${f.color} 14%, var(--panel)), var(--panel) 70%)`, padding: 14, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span aria-hidden style={{ width: 30, height: 30, borderRadius: 9, background: `color-mix(in oklab, ${f.color} 24%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flex: 'none' }}>{f.icon}</span>
                  <span style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 0 }}>{f.label}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{f.count}</span>
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{f.head ? `${f.head.name} + ${f.count - 1} on the team` : bySegment(app.market, 'business').filter((m) => m.function === f.id).map((m) => m.name).join(' · ')}</span>
              </button>
            ))}
          </div>
        ))}
      {fn && <FunctionPage fnId={fn.id} orgOn={orgOn} />}
    </>
  );
}

/** One function: the head first and prominent, then the team that reports to it. */
function FunctionPage({ fnId, orgOn }: { fnId: string; orgOn: boolean }) {
  const app = useApp();
  const meta = functionMeta(fnId);
  const { head, team, others } = functionPage(app.market, fnId);
  return (
    <section aria-label={`${meta.label} function`} style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ width: 36, height: 36, borderRadius: 10, background: `color-mix(in oklab, ${meta.color} 24%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>{meta.icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{meta.label}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{head ? `A head and ${team.length} specialist${team.length === 1 ? '' : 's'}` : `${others.length} agent${others.length === 1 ? '' : 's'}`}{others.length && head ? ` · ${others.length} more` : ''}</div>
        </div>
      </div>
      {head && (
        <div style={{ marginTop: 14, border: `1px solid color-mix(in oklab, ${meta.color} 45%, var(--border))`, borderRadius: 18, padding: 4, background: `linear-gradient(160deg, color-mix(in oklab, ${meta.color} 16%, var(--panel)), var(--panel) 60%)` }}>
          <div style={{ padding: '10px 14px 4px', fontSize: 13.5, fontWeight: 700 }}>Hire the {head.name} — it can hire its own team</div>
          <div style={{ padding: '0 14px 8px', fontSize: 12, color: 'var(--text-dim)' }}>{orgOn ? `In the company the head leads the ${meta.label} unit under the chief of staff and staffs it from the specialists below.` : 'Without a company it works as a standalone agent on files; start a company to give it a team.'}</div>
          <AgentCard m={head} featured />
        </div>
      )}
      {team.length > 0 && <>
        <div style={{ marginTop: 22, fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>The team · reports to {head?.name}</div>
        <Grid>{team.map((m) => <AgentCard key={m.id} m={m} />)}</Grid>
      </>}
      {others.length > 0 && <>
        <div style={{ marginTop: 22, fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{fnId === 'leadership' ? 'Company leadership' : head ? `Also in ${meta.label}` : meta.label}</div>
        <Grid>{others.map((m) => <AgentCard key={m.id} m={m} />)}</Grid>
      </>}
      {!head && team.length === 0 && others.length === 0 && <Empty>No agent in {meta.label} yet.</Empty>}
    </section>
  );
}

/** Search spans both segments; every result says which one it is in. */
function SearchResults({ q }: { q: string }) {
  const app = useApp();
  const items = searchMarket(app.market, q);
  const n = { personal: items.filter((m) => segmentOf(m) === 'personal').length, business: items.filter((m) => segmentOf(m) === 'business').length };
  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 12 }} aria-live="polite">{items.length} result{items.length === 1 ? '' : 's'} · {n.personal} personal · {n.business} business</div>
      {items.length === 0 ? <Empty>Nothing matches “{q}” in either segment. Try a role (“accountant”), a function (“finance”) or a task (“month-end”).</Empty>
        : <Grid>{items.map((m) => <AgentCard key={m.id} m={m} showSegment />)}</Grid>}
    </>
  );
}

const tag = (text: React.ReactNode, color: string, title?: string) => (
  <span title={title} style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color, border: `1px solid ${color}`, borderRadius: 5, padding: '1px 6px', flex: 'none', whiteSpace: 'nowrap' }}>{text}</span>
);
const mini: React.CSSProperties = { fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' };

function AgentCard({ m, featured, showSegment }: { m: MarketItem; featured?: boolean; showSegment?: boolean }) {
  const app = useApp();
  const biz = segmentOf(m) === 'business';
  const fn = biz ? functionMeta(m.function) : null;
  const boss = biz ? reportsToName(m, app.market) : null;
  const cadence = cadenceLine(m);
  const skills = m.skills?.length ?? 0;
  const kpis = m.kpis ?? [];
  return (
    <div data-testid={`market-card-${m.id}`} style={{ border: featured ? 'none' : '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: featured ? 20 : 18, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13, minWidth: 0 }}>
        <div style={{ width: featured ? 54 : 46, height: featured ? 54 : 46, borderRadius: 13, background: gradPair(m.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: featured ? 26 : 22 }}>{m.emoji}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <span style={{ fontSize: featured ? 17 : 16, fontWeight: 700, letterSpacing: '-.2px' }}>{m.name}</span>
            {m.verified && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="var(--blue)" aria-label="verified"><path d="M12 2l2.4 1.8 3 .2.2 3L19.4 9.6l-1.8 2.4 1.8 2.4-1.8 2.6-.2 3-3 .2L12 22l-2.4-1.8-3-.2-.2-3L4.6 14.4 6.4 12 4.6 9.6l1.8-2.4.2-3 3-.2z" /><path d="M9 12l2 2 4-4" stroke="#fff" strokeWidth="2" fill="none" /></svg>
            )}
            {showSegment && tag(SEGMENT_LABEL[segmentOf(m)], biz ? 'var(--accent-hi)' : 'var(--green)')}
            {biz && m.level === 'head' && tag('Head', 'var(--amber)', 'Leads the function and hires its own team')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fn ? <span style={{ color: 'var(--text-dim)' }}><span aria-hidden>{fn.icon}</span> {fn.label}</span> : m.cat}
            {boss ? ` · reports to ${boss}` : ''}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>{m.tagline}</div>
      {kpis.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          <span style={{ fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '.05em' }}>Owns </span>
          {kpis.slice(0, featured ? 6 : 3).join(' · ')}{kpis.length > (featured ? 6 : 3) ? ` · +${kpis.length - (featured ? 6 : 3)}` : ''}
        </div>
      )}
      {cadence && (
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5, ...(featured ? {} : { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }) }}>
          <span style={{ fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '.05em' }}>Cadence </span>{cadence}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {fn && <span style={{ ...mini, borderColor: `color-mix(in oklab, ${fn.color} 50%, var(--border-soft))`, background: `color-mix(in oklab, ${fn.color} 14%, var(--panel-2))` }}>{fn.icon} {fn.label}</span>}
        {skills > 0 && <span style={mini}>{skills} skill{skills === 1 ? '' : 's'}</span>}
        {m.loops.length > 0 && <span style={mini} title={m.loops.map((l) => `${l.name} (${l.cron})`).join('\n')}>{m.loops.length} loop{m.loops.length === 1 ? '' : 's'}</span>}
        {m.caps.filter((c) => !/skills$/.test(c)).map((cap) => <span key={cap} style={{ ...mini, fontFamily: 'var(--mono)' }}>{cap}</span>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 12, borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-faint)', minWidth: 0 }}>{m.author} · {m.price === 'free' ? 'Free' : 'Metered · tokens'}</span>
        {m.hired ? (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--green)', fontWeight: 600 }}>
            <I d={P.check} size={14} sw={2.4} />Hired
          </span>
        ) : (
          <button onClick={() => app.setHireId(m.id)} aria-label={`Hire ${m.name}`} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Hire</button>
        )}
      </div>
    </div>
  );
}

/** The Connectors department: curated directory of native integrations and
 *  vendor-run remote MCP servers, one-click connect, trust tiers shown. */
function ConnectorsDept() {
  const app = useApp();
  const [entries, setEntries] = useState<ConnectorEntry[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopPolling = () => {
    if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; }
    if (pollTimeoutRef.current !== null) { clearTimeout(pollTimeoutRef.current); pollTimeoutRef.current = null; }
  };
  // OAuth popup pollers must not outlive the component (dept switch / nav away)
  useEffect(() => stopPolling, []);
  const refresh = () => {
    void api.marketConnectors().then(setEntries).catch(() => setEntries([]));
    void api.connections().then(setConns).catch(() => setConns([]));
    void app.refreshMcp().catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, []);

  const google = conns.find((c) => c.provider === 'google');
  const nativeConnected = (e: ConnectorEntry): boolean => {
    if (!google) return false;
    if (e.nativeTier === 'gmail') return google.gmailCapable;
    if (e.nativeTier === 'drive') return google.driveCapable;
    return true; // calendar read comes with the base connect
  };
  const mcpFor = (e: ConnectorEntry) => app.mcp.find((s) => s.url === e.url);

  /** Native connect: same popup flow as Settings → Connections. */
  const connectNative = async (e: ConnectorEntry) => {
    setBusy(e.id);
    try {
      const { url } = await api.connectStart('google', e.nativeTier ?? 'read');
      const popup = window.open(url, 'yaam-connect', 'width=520,height=680');
      stopPolling();
      pollRef.current = setInterval(async () => {
        const now = await api.connections().catch(() => null);
        if (!now) return;
        const g = now.find((c) => c.provider === 'google');
        const done = g && (e.nativeTier === 'gmail' ? g.gmailCapable : e.nativeTier === 'drive' ? g.driveCapable : true);
        if (done || popup?.closed) {
          stopPolling();
          setConns(now);
          setBusy(null);
          if (done) app.showToast(`${e.name} connected — grant it per agent on their Skills & tools tab`);
        }
      }, 2500);
      pollTimeoutRef.current = setTimeout(() => { stopPolling(); setBusy(null); }, 180_000);
    } catch (err) {
      setBusy(null);
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'connect failed');
    }
  };

  /** MCP connect: add the server, discover; on auth challenge run OAuth. */
  const connectMcp = async (e: ConnectorEntry) => {
    setBusy(e.id);
    try {
      const server = mcpFor(e) ?? await api.createMcp(e.name, e.url!);
      await app.refreshMcp();
      try {
        await api.discoverMcp(server.id);
        await app.refreshMcp();
        app.showToast(`${e.name} connected`);
        setBusy(null);
        return;
      } catch { /* likely needs authorization */ }
      const { url } = await api.mcpOauthStart(server.id);
      const popup = window.open(url, 'yaam-connect', 'width=520,height=680');
      stopPolling();
      pollRef.current = setInterval(async () => {
        const done = await api.discoverMcp(server.id).then(() => true).catch(() => false);
        if (done || popup?.closed) {
          stopPolling();
          await app.refreshMcp();
          setBusy(null);
          if (done) app.showToast(`${e.name} connected`);
        }
      }, 3000);
      pollTimeoutRef.current = setTimeout(() => { stopPolling(); setBusy(null); }, 180_000);
    } catch (err) {
      setBusy(null);
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'connect failed');
    }
  };

  const card = (e: ConnectorEntry) => {
    const server = e.kind === 'mcp' ? mcpFor(e) : undefined;
    const liveTools = server ? (JSON.parse(server.tools || '[]') as Array<{ name: string }>).map((t) => t.name) : [];
    const connected = e.kind === 'native' ? nativeConnected(e) : !!server && (liveTools.length > 0 || server.authStatus === 'connected');
    const tools = liveTools.length > 0 ? liveTools : e.tools;
    return (
      <div key={e.id} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 21 }}>{e.emoji}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 15.5, fontWeight: 700 }}>{e.name}</span>
              <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: e.tier === 'verified' ? 'var(--blue)' : 'var(--amber)', border: `1px solid ${e.tier === 'verified' ? 'var(--blue)' : 'var(--amber)'}`, borderRadius: 5, padding: '1px 6px' }}>{e.tier}</span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{e.vendor}{e.kind === 'mcp' ? ' · remote MCP' : ' · native'}</div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>{e.desc}</div>
        {e.tier === 'community' && (
          <div style={{ fontSize: 11, color: 'var(--amber)' }}>Runs code by {e.vendor}, not by the service vendor — it sits in the token path.</div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tools.slice(0, 6).map((t) => <span key={t} style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)' }}>{t}</span>)}
          {tools.length > 6 && <span style={{ fontSize: 10.5, color: 'var(--text-faint)', padding: '2px 4px' }}>+{tools.length - 6} more</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 11, borderTop: '1px solid var(--border-soft)' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{e.kind === 'mcp' ? 'Tools always ask before running' : 'Per-agent grants, per-call approvals'}</span>
          {connected ? (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--green)', fontWeight: 600 }}>
              <I d={P.check} size={14} sw={2.4} />Connected
            </span>
          ) : (
            <button disabled={busy === e.id} onClick={() => void (e.kind === 'native' ? connectNative(e) : connectMcp(e))}
              style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', opacity: busy === e.id ? 0.6 : 1 }}>
              {busy === e.id ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 18 }}>
        {entries.map(card)}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 16, lineHeight: 1.6 }}>
        Something missing? Add any MCP server by URL under Settings → MCP servers — the directory is convenience, never gatekeeping.
      </div>
    </>
  );
}

/** The Community department (docs/registry.md): local + remote registry
 *  items with a kind badge, installs, rating, publisher, version and the
 *  scan-flag count; the detail/Install opens the review modal. */
function CommunityDept() {
  const app = useApp();
  const [data, setData] = useState<RegistryList | null>(null);
  const [failed, setFailed] = useState('');
  const [kind, setKind] = useState<RegistryKind | ''>('');
  const [q, setQ] = useState('');
  const [reviewing, setReviewing] = useState<RegistryItem | null>(null);
  const load = () => {
    setFailed('');
    void api.registry(kind, q.trim()).then(setData).catch((err) => { setData(null); setFailed(err instanceof Error ? err.message : 'failed'); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [kind, q]);

  const pill = (text: string, color: string) => (
    <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color, border: `1px solid ${color}`, borderRadius: 5, padding: '1px 6px', flex: 'none' }}>{text}</span>
  );

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '8px 11px', flex: 1, minWidth: 200 }}>
          <I d={P.search} size={15} stroke="var(--text-faint)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the community" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }} />
        </div>
        {(['', 'agent', 'skill', 'app'] as const).map((k) => (
          <div key={k || 'all'} onClick={() => setKind(k)} style={{ padding: '6px 14px', borderRadius: 20, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: `1px solid ${k === kind ? 'var(--accent)' : 'var(--border)'}`, background: k === kind ? 'var(--accent)' : 'var(--panel)', color: k === kind ? '#fff' : 'var(--text-dim)' }}>
            {k ? `${KIND_LABEL[k]}s` : 'All'}
          </div>
        ))}
      </div>
      {data && data.remote.url && (
        <div style={{ fontSize: 11.5, color: data.remote.ok ? 'var(--text-faint)' : 'var(--amber)', marginTop: 10 }}>
          {data.remote.ok
            ? `Includes ${data.remote.url.replace(/^https?:\/\//, '')} · refreshed ${data.remote.fetchedAt ? new Date(data.remote.fetchedAt).toLocaleTimeString() : ''}`
            : `Remote registry ${data.remote.url.replace(/^https?:\/\//, '')} unreachable: ${data.remote.error} — showing local items only`}
        </div>
      )}
      {failed && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 14 }}>Could not load the registry: {failed}</div>}
      {data && data.items.length === 0 && !failed && (
        <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 20, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Nothing published yet. Publish one of yours from an agent&apos;s home page, a skill row, or a mini-app card — the form scans it first and shows you what installers will see.
          {!data.remote.url && <> Set <span style={{ fontFamily: 'var(--mono)' }}>REGISTRY_URL</span> to browse a hosted registry as well (Settings → Market).</>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 18 }}>
        {(data?.items ?? []).map((it) => {
          const flags = flagCount(it.scanReport);
          const rating = ratingLabel(it.ratingUp, it.ratingDown);
          return (
            <div key={it.id} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 21 }}>{KIND_GLYPH[it.kind]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 15.5, fontWeight: 700 }}>{it.name}</span>
                    {pill(KIND_LABEL[it.kind], it.kind === 'agent' ? 'var(--blue)' : it.kind === 'skill' ? 'var(--accent-hi)' : 'var(--amber)')}
                    {it.source === 'remote' && pill('remote', 'var(--text-faint)')}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{it.publisherName || 'anonymous'} · v{it.version}</div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: rating ? 'var(--amber)' : 'var(--text-faint)' }}>{rating ?? 'unrated'}</div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{fmtInstalls(it.installs)} install{it.installs === 1 ? '' : 's'}</div>
                </div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, minHeight: 18 }}>{it.description || 'No description.'}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>{installSummary(it)}</span>
                {it.capabilities.tools.slice(0, 4).map((t) => <span key={t} style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)' }}>{t}</span>)}
                {it.capabilities.tools.length > 4 && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>+{it.capabilities.tools.length - 4}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 11, borderTop: '1px solid var(--border-soft)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: flags ? 'var(--amber)' : 'var(--text-faint)' }}>
                  {flags > 0 && <I d={P.warn} size={13} />}{flags ? `${flags} scan flag${flags === 1 ? '' : 's'}` : 'scan clean'}
                </span>
                {it.installed && <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--green)', fontWeight: 600 }}><I d={P.check} size={13} sw={2.4} />Installed</span>}
                <button onClick={() => setReviewing(it)} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                  {it.installed ? 'Review & install again' : 'Review & install'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {data && data.items.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 16, lineHeight: 1.6 }}>
          Ratings come from the 👍/👎 you give turns that used an installed agent or skill — the market has no star widget. Publishing is free and payments are deliberately not built.
        </div>
      )}
      {reviewing && <RegistryReviewModal item={reviewing} onClose={() => setReviewing(null)} onInstalled={load} />}
    </>
  );
}

/** The Companies department (docs/registry.md §8, item 24): published
 *  blueprints with their outcome counts; Install opens the two-step modal. */
function CompaniesDept() {
  const app = useApp();
  const [data, setData] = useState<{ items: CompanyRegistryItem[]; remote: RegistryList['remote'] } | null>(null);
  const [failed, setFailed] = useState('');
  const [q, setQ] = useState('');
  const [installing, setInstalling] = useState<CompanyRegistryItem | null>(null);
  const load = () => {
    setFailed('');
    void api.marketCompanies(q.trim()).then(setData).catch((err) => { setData(null); setFailed(err instanceof Error ? err.message : 'failed'); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [q]);
  const tag = (text: string, color: string) => <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color, border: `1px solid ${color}`, borderRadius: 5, padding: '1px 6px', flex: 'none' }}>{text}</span>;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '8px 11px', marginTop: 18 }}>
        <I d={P.search} size={15} stroke="var(--text-faint)" />
        <input aria-label="Search companies" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13 }} />
      </div>
      {data && data.remote.url && <div style={{ fontSize: 11.5, color: data.remote.ok ? 'var(--text-faint)' : 'var(--amber)', marginTop: 10 }}>{data.remote.ok ? `Includes ${data.remote.url.replace(/^https?:\/\//, '')}` : `Remote registry unreachable: ${data.remote.error} — local items only`}</div>}
      {failed && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 14 }}>Could not load the companies: {failed}</div>}
      {data && data.items.length === 0 && !failed && (
        <div style={{ marginTop: 18, border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 20, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          {q.trim() ? `No company matches “${q.trim()}”.` : 'No company published yet. Publish yours from Settings → Workspace → Organization → Blueprint; the export is scanned and shown to installers before any plan.'}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 18 }}>
        {(data?.items ?? []).map((it) => {
          const flags = flagCount(it.scanReport);
          const scopes = it.capabilities.tools.length;
          const co = it.capabilities.company;
          return (
            <div key={it.id} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 12, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 21 }}>🏢</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}><span style={{ fontSize: 15.5, fontWeight: 700 }}>{it.name}</span>{it.official && tag('Official', 'var(--green)')}{tag('company', 'var(--accent-hi)')}{it.source === 'remote' && tag('remote', 'var(--text-faint)')}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{it.official ? 'yaam · first-party starter' : `${it.publisherName || 'anonymous'} · v${it.version}`}</div>
                </div>
                <div style={{ textAlign: 'right', flex: 'none', fontSize: 10.5, color: 'var(--text-faint)' }}>{fmtInstalls(it.installs)} install{it.installs === 1 ? '' : 's'}</div>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, minHeight: 18 }}>{it.description || 'No description.'}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span title="Installs that reached a first key result" style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>◎ {it.outcomes.first_key_result} reached a key result</span>
                <span title="Installs that ran thirty days inside their envelope" style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>$ {it.outcomes.thirty_days_in_envelope} thirty days in envelope</span>
                {it.capabilities.skills.length > 0 && <span style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>{it.capabilities.skills.length} playbook(s)</span>}
                {co && <span style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>{co.roles} seat{co.roles === 1 ? '' : 's'} · ${co.monthlyUsd}/month</span>}
                {scopes > 0 && <span style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', fontFamily: 'var(--mono)' }}>{scopes} scope(s)</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 11, borderTop: '1px solid var(--border-soft)' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: flags ? 'var(--amber)' : 'var(--text-faint)' }}>{flags > 0 && <I d={P.warn} size={13} />}{flags ? `${flags} scan flag${flags === 1 ? '' : 's'}` : 'scan clean'}</span>
                <button onClick={() => setInstalling(it)} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '7px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Review & install</button>
              </div>
            </div>
          );
        })}
      </div>
      {installing && <Suspense fallback={null}><CompanyInstallModal item={installing} onClose={() => setInstalling(null)} onInstalled={load} /></Suspense>}
    </>
  );
}

export function HireModal() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  // The bundled skills become permanent instruction text inside this agent —
  // a persistent prompt-injection channel if unread. The review has to show
  // the real thing, so fetch the bodies when the modal opens.
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const hireId = app.hireId;
  // A business pack in a company: hire it into the company (a hire card via
  // the role catalog) or add it as a standalone agent (docs/agent-catalog.md).
  const [route, setRoute] = useState<'company' | 'standalone'>('company');
  const [reportsTo, setReportsTo] = useState('');
  const org = app.wsOrg?.org ?? null;
  const orgOn = app.companiesEnabled && !!app.wsOrg && app.wsOrg.mode !== 'off';
  useEffect(() => {
    setOpenSkill(null);
    setBodies({});
    setRoute('company');
    const it = app.market.find((m) => m.id === hireId);
    setReportsTo(it && org ? defaultReportsTo(it, app.market, org.members, app.wsOrg?.chiefOfStaffAgentId ?? null) ?? '' : '');
    if (!hireId) return;
    void api.marketPackSkills(hireId)
      .then((rows) => setBodies(Object.fromEntries(rows.map((r) => [r.name, r.instructions]))))
      .catch(() => setBodies({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hireId]);
  const item = app.market.find((m) => m.id === app.hireId);
  if (!item) return null;
  const biz = segmentOf(item) === 'business';
  const canCompany = biz && orgOn && !!item.orgHire && !!org;
  const viaCompany = canCompany && route === 'company';
  const agentName = (id: string) => app.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const hireIntoCompany = async () => {
    if (!app.wsOrg || !item.orgHire) return;
    try {
      await api.proposeOrgApproval(app.wsOrg.workspaceId, {
        kind: 'hire',
        payload: { templateOrPack: item.orgHire, name: item.name, ...(reportsTo ? { reportsToAgentId: reportsTo } : {}) },
        recommendation: `Hire ${item.name} from the Market${reportsTo ? `, reporting to ${agentName(reportsTo)}` : ''}.`,
      });
      app.setHireId(null);
      app.showToast(`Hire card for ${item.name} created — decide it in Inbox → Approvals`);
      await app.refreshWsOrg().catch(() => {});
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 200) : 'the hire could not be proposed');
    }
  };
  return (
    <div onClick={() => app.setHireId(null)} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '88vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '22px 24px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 13, background: gradPair(item.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 23 }}>{item.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>Review before hiring {item.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>{item.author} · {item.price === 'free' ? 'Free' : 'Metered'}</div>
          </div>
          <button onClick={() => app.setHireId(null)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, display: 'flex' }}><I d={P.x} size={18} /></button>
        </div>
        <div style={{ padding: '20px 24px' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 11 }}>Capabilities requested</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {item.capsFull.map((c) => (
              <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: 'var(--accent-hi)' }}>
                  <I d={CAP_ICON[c.icon] ?? CAP_ICON.file} size={15} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)' }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{c.desc}</div>
                </div>
              </div>
            ))}
          </div>
          {(item.skills?.length ?? 0) > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 11 }}>
                Bundled skills · {item.skills!.length}
              </div>
              <div style={{ maxHeight: 210, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel-2)' }}>
                {item.skills!.map((s) => (
                  <div key={s.name} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)', flex: 1, minWidth: 0 }}>/{s.name}</div>
                      <button onClick={() => setOpenSkill(openSkill === s.name ? null : s.name)}
                        style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: 0, flex: 'none' }}>
                        {openSkill === s.name ? 'Hide text' : 'Read text'}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1, ...(openSkill === s.name ? {} : { overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }) }}>{s.description}</div>
                    {openSkill === s.name && (
                      <pre style={{ margin: '7px 0 2px', padding: '9px 11px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 8, fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
                        {bodies[s.name] ?? 'Loading…'}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 7 }}>
                These become standing instructions inside {item.name} — read them before hiring. Skills install private to this agent; read, edit, or remove them any time in its Skills &amp; tools tab.
              </div>
            </div>
          )}
          {biz && (
            <div role="radiogroup" aria-label="How to hire" style={{ marginTop: 18, display: 'grid', gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>How to hire</div>
              {canCompany && (
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${route === 'company' ? 'var(--accent)' : 'var(--border-soft)'}`, background: route === 'company' ? 'var(--accent-dim)' : 'var(--panel-2)' }}>
                  <input type="radio" name="hire-route" checked={route === 'company'} onChange={() => setRoute('company')} style={{ marginTop: 3 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>Hire into the company</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                      {item.orgHire?.startsWith('role:') ? <>As the catalog role <code style={{ fontFamily: 'var(--mono)' }}>{item.orgHire}</code>: its charter, scopes and model tier, with this pack&apos;s playbooks. </> : 'With this pack’s charter and playbooks. '}
                      A hire card for you{app.wsOrg?.mode === 'autonomous' ? ' (or the boundary)' : ''} to decide under Inbox → Approvals; scopes never exceed the chief&apos;s.{item.level === 'head' ? ' Once seated, the head hires its own team.' : ''}
                    </span>
                    {route === 'company' && org && org.members.length > 0 && (
                      <select aria-label="Reports to" value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}
                        style={{ marginTop: 7, maxWidth: '100%', background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 8px', font: 'inherit', fontSize: 12 }}>
                        {org.members.filter((mm) => mm.status === 'active').map((mm) => <option key={mm.agentId} value={mm.agentId}>reports to {agentName(mm.agentId)}{mm.title ? ` (${mm.title})` : ''}</option>)}
                      </select>
                    )}
                  </span>
                </label>
              )}
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, cursor: canCompany ? 'pointer' : 'default', border: `1px solid ${!viaCompany ? 'var(--accent)' : 'var(--border-soft)'}`, background: !viaCompany ? 'var(--accent-dim)' : 'var(--panel-2)' }}>
                <input type="radio" name="hire-route" checked={!viaCompany} onChange={() => setRoute('standalone')} style={{ marginTop: 3 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>Add as a standalone agent</span>
                  <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>Its own agent in this workspace, outside any reporting line; it runs the same playbooks on files.</span>
                </span>
              </label>
              {!orgOn && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  This workspace does not run a company. {app.companiesEnabled
                    ? <><button onClick={() => { app.setHireId(null); app.go('workspace'); }} style={{ font: 'inherit', background: 'none', border: 'none', padding: 0, color: 'var(--accent-hi)', fontWeight: 600, cursor: 'pointer' }}>Start a company</button> to hire it into a team with a reporting line.</>
                    : 'Companies are not enabled on this server, so business agents join standalone.'}
                </div>
              )}
              {orgOn && !canCompany && item.id === 'pack-chief-of-staff' && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>The company already has its chief of staff seat (set in the company settings); this adds a standalone copy.</div>
              )}
            </div>
          )}
          {viaCompany && item.loops.length > 0 && (
            <div style={{ marginTop: 14, fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              A company hire starts without the pack&apos;s {item.loops.length} loop{item.loops.length === 1 ? '' : 's'}: the company&apos;s cadences run its rituals.
            </div>
          )}
          {!viaCompany && item.loops.length > 0 && (
            <div style={{ marginTop: 18, padding: '13px 15px', border: '1px solid var(--amber)', borderRadius: 11, background: 'color-mix(in oklab,var(--amber) 12%,transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>
                <I d={P.warn} size={15} />Scheduled loops enable immediately on install
              </div>
              {item.loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{l.cron}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{viaCompany ? 'Joins the company once the card is approved.' : 'Runs under your active workspace credentials.'}</span>
          <button onClick={() => app.setHireId(null)} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button disabled={busy} onClick={async () => {
            if (busy) return;
            setBusy(true);
            try { await (viaCompany ? hireIntoCompany() : app.confirmHire()); } finally { setBusy(false); }
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? (viaCompany ? 'Proposing…' : 'Hiring…') : viaCompany ? 'Propose the hire' : 'Approve & hire'}</button>
        </div>
      </div>
    </div>
  );
}
