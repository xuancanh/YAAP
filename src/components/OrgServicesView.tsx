/** People › Services (docs/services.md): what each department offers the
 *  rest of the company. The catalog groups services by department (a
 *  department's card on People › Teams opens it filtered), each with who
 *  answers, its accept and resolve SLAs, the fields a request needs and its
 *  metrics; the open requests carry their live SLA clock and thread. The
 *  CEO requests a service (or asks a department for something no service
 *  covers), answers a provider's counter-proposal, routes an ask that names
 *  no department and adopts starter services from the library. Breaches
 *  that climb to the CEO arrive in the Inbox as decision cards. Lib:
 *  src/lib/services.ts. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgServiceEntry, type OrgServiceRequestRow, type ServiceTemplate } from '../lib/api';
import { REQUEST_TONE, REQUEST_WORD, byDepartment, formProblems, inputKind, isOpenRequest, metricFigures, slaCountdown, threadWords } from '../lib/services';
import { ago, useAgentNames, useUnits } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Card, Empty, Metric, PageHeader, Pill, SkeletonRows } from './CompanyKit';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 800) : 'failed');

type Data = { services: OrgServiceEntry[]; requests: OrgServiceRequestRow[] };

export function ServicesPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const { units } = useUnits();
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<{ service: string } | null>(null);
  const [library, setLibrary] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const unitFilter = app.orgUnitId && units.find((u) => u.id === app.orgUnitId)?.parentUnitId !== null ? app.orgUnitId : null;
  const load = useCallback(async () => {
    try { setData(await api.orgServices(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);

  const active = (data?.services ?? []).filter((s) => s.status === 'active' && (!unitFilter || s.unitId === unitFilter));
  const serviceOf = useMemo(() => new Map((data?.services ?? []).map((s) => [s.id, s])), [data]);
  const unitName = (id: string | null) => (id ? units.find((u) => u.id === id)?.name ?? 'a department' : 'the company');
  const inScope = (r: OrgServiceRequestRow) => !unitFilter || r.providerUnitId === unitFilter;
  const open = (data?.requests ?? []).filter((r) => isOpenRequest(r) && inScope(r));
  const closed = (data?.requests ?? []).filter((r) => !isOpenRequest(r) && inScope(r));
  const breached = open.filter((r) => r.clock.breached).length;
  const triage = open.filter((r) => r.status === 'triage').length;
  const deptUnits = units.filter((u) => u.parentUnitId !== null);
  return (
    <div className="co-page" data-testid="services-page">
      <PageHeader title="Services" purpose="What each department offers the rest of the company: the fields a request needs, who answers, and how fast — the accept SLA (an answer: accepted with a date, declined with a reason, or a counter-proposal) and the resolve SLA (delivery). A request naming a service goes straight to its department; silence past the accept SLA climbs the provider's line to its head, the chief, then you. Heads keep their catalog; asks that keep coming without a service are flagged to them."
        actions={decider ? <>
          <button className="co-btn" onClick={() => setLibrary(!library)} aria-expanded={library}>{library ? 'Close library' : 'Add from library'}</button>
          <button className="co-btn primary" onClick={() => setForm(form ? null : { service: '' })} aria-expanded={Boolean(form)}>Request a service</button>
        </> : undefined} />
      {err && <div className="co-alert" role="alert">{err}</div>}
      {deptUnits.length > 0 && (
        <div className="co-chips" style={{ margin: '2px 0 12px' }} role="group" aria-label="Department">
          <button className={`co-chip${unitFilter ? '' : ' on'}`} aria-pressed={!unitFilter} onClick={() => app.setOrgUnitId(null)}>All departments</button>
          {deptUnits.map((u) => <button key={u.id} className={`co-chip${unitFilter === u.id ? ' on' : ''}`} aria-pressed={unitFilter === u.id} onClick={() => app.setOrgUnitId(u.id)}>{u.name}</button>)}
        </div>
      )}
      {data && (
        <div className="co-metrics" style={{ margin: '4px 0 14px' }} data-testid="service-counts">
          <Metric n={active.length} label="services" />
          <Metric n={open.length} label="open requests" tone={open.length ? 'info' : undefined} />
          <Metric n={breached} label="past their SLA" tone={breached ? 'bad' : undefined} title="Open requests past their accept SLA or delivery date" />
          <Metric n={triage} label="to route" tone={triage ? 'warn' : undefined} title="Asks that named no department: the chief routes them" />
        </div>
      )}
      {form && data && <RequestForm wsId={wsId} services={(data.services).filter((s) => s.status === 'active')} initial={form.service} units={deptUnits} onDone={async (note) => { setForm(null); if (note) app.showToast(note); await load(); }} />}
      {library && <Library wsId={wsId} onAdded={async () => { setLibrary(false); await load(); }} />}
      {!data && !err && <SkeletonRows rows={4} label="Loading services" />}
      {data && open.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Card title="Open requests" aside={`${open.length}`} flush>
            <div className="co-rows" data-testid="open-requests">
              {open.map((r) => <RequestRow key={r.id} r={r} svc={r.serviceId ? serviceOf.get(r.serviceId) : undefined} provider={unitName(r.providerUnitId)} wsId={wsId} decider={decider} units={deptUnits} onChanged={load} />)}
            </div>
          </Card>
        </div>
      )}
      {data && active.length === 0 && (
        <div className="co-card"><Empty title={unitFilter ? `${unitName(unitFilter)} offers no services yet` : 'No services yet'}>A department's head publishes what it offers; {decider ? 'you can add starters from the library, and ' : ''}asks for work still reach a department without one.</Empty></div>
      )}
      {byDepartment(active).map((g) => (
        <div key={g.unitId ?? 'company'} style={{ marginBottom: 14 }}>
          <Card title={g.unitName} aside={`${g.services.length} service${g.services.length === 1 ? '' : 's'}`} flush>
            <div className="co-rows" data-testid={`catalog-${g.unitId ?? 'company'}`}>
              {g.services.map((s) => <ServiceRow key={s.id} s={s} onRequest={decider ? () => setForm({ service: s.name }) : undefined} />)}
            </div>
          </Card>
        </div>
      ))}
      {closed.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button className="co-link" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>{showClosed ? 'Hide' : 'Show'} closed requests ({closed.length})</button>
          {showClosed && <div className="co-card" style={{ marginTop: 8 }}><div className="co-rows">{closed.slice(0, 40).map((r) => <RequestRow key={r.id} r={r} svc={r.serviceId ? serviceOf.get(r.serviceId) : undefined} provider={unitName(r.providerUnitId)} wsId={wsId} decider={false} units={deptUnits} onChanged={load} />)}</div></div>}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ s, onRequest }: { s: OrgServiceEntry; onRequest?: () => void }) {
  const names = useAgentNames();
  const owner = s.ownerAgentId ? names.get(s.ownerAgentId)?.name : undefined;
  return (
    <div className="co-row static" data-testid="service-row">
      <span className="co-row-main">
        <span className="co-row-title">{s.title} <span style={{ color: 'var(--text-faint)', fontWeight: 500 }}>v{s.version}</span></span>
        <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>
          answered by {owner ?? (s.ownerRole === 'head' ? 'the head' : s.ownerRole)} · answer within {s.acceptSlaHours}h · deliver within {s.resolveSlaHours}h · {s.processName === 'service-request' ? 'standard intake' : `process ${s.processName}`}
          {s.description ? ` · ${s.description}` : ''}
        </span>
        <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>needs: {s.fieldList.length ? s.fieldList.map((f) => `${f.label}${f.required ? '' : ' (optional)'}`).join(', ') : 'nothing beyond the ask'}</span>
        <span style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 12 }} data-testid="service-metrics">
          {metricFigures(s.metrics).map((m) => <span key={m.label} title={m.title} style={{ color: m.tone === 'bad' ? 'var(--red)' : m.tone === 'warn' ? 'var(--amber)' : 'var(--text-dim)' }}><b style={{ fontWeight: 650 }}>{m.value}</b> {m.label}</span>)}
        </span>
      </span>
      <span className="co-row-end">
        {s.pendingChange && <Pill tone="warn" plain title="A change waits for approval">change pending</Pill>}
        {onRequest && <button className="co-btn small" onClick={onRequest}>Request</button>}
      </span>
    </div>
  );
}

function RequestRow({ r, svc, provider, wsId, decider, units, onChanged }: { r: OrgServiceRequestRow; svc?: OrgServiceEntry; provider: string; wsId: string; decider: boolean; units: Array<{ id: string; name: string }>; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [openThread, setOpenThread] = useState(false);
  const [route, setRoute] = useState('');
  const clock = slaCountdown(r);
  const mine = !r.requesterAgentId;
  const requester = r.requesterAgentId ? names.get(r.requesterAgentId)?.name ?? 'a member' : 'you';
  const act = async (body: { answer: string; due?: string; unitId?: string; reason?: string }) => {
    try { const res = await api.respondOrgServiceRequest(wsId, r.id, body); app.showToast(res.note); await onChanged(); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div className="co-row static" data-testid="request-row" style={{ flexWrap: 'wrap' }}>
      <span className="co-row-main">
        <button className="co-link" style={{ textAlign: 'left' }} onClick={() => setOpenThread(!openThread)} aria-expanded={openThread}>
          <span className="co-row-title">{r.key} · {r.title}</span>
        </button>
        <span className="co-row-meta">{svc?.title ?? 'unlisted ask'} · {r.status === 'triage' ? 'not routed yet' : provider} · from {requester} · {ago(r.createdAt)}{r.committedDue ? ` · due ${r.committedDue.slice(0, 10)}` : ''}{r.breaches ? ` · ${r.breaches} breach${r.breaches === 1 ? '' : 'es'}` : ''}</span>
        {r.status === 'negotiating' && r.counter && <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>Counter-proposal: {[r.counter.due ? `by ${r.counter.due.slice(0, 10)}` : '', r.counter.scope ?? '', r.counter.note ?? ''].filter(Boolean).join(' · ')}</span>}
        {r.status === 'declined' && r.declineReason && <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>Declined: {r.declineReason}</span>}
        {openThread && (
          <ol style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)' }} data-testid="request-thread">
            <li>Why: {r.why}{Object.keys(r.fields).length ? ` — ${Object.entries(r.fields).map(([k, v]) => `${k}: ${v}`).join('; ')}` : ''}</li>
            {r.thread.map((e, i) => <li key={i}>{e.at.slice(0, 16).replace('T', ' ')} — {threadWords(e)}</li>)}
          </ol>
        )}
      </span>
      <span className="co-row-end" style={{ gap: 6, flexWrap: 'wrap' }}>
        {clock && <Pill tone={clock.tone} plain testid="sla-clock">{clock.label}</Pill>}
        <Pill tone={REQUEST_TONE[r.status]}>{REQUEST_WORD[r.status]}</Pill>
        {decider && mine && r.status === 'negotiating' && <button className="co-btn small primary" onClick={() => void act({ answer: 'agree' })}>Agree</button>}
        {decider && mine && isOpenRequest(r) && <button className="co-btn small ghost" onClick={() => void act({ answer: 'withdraw', reason: 'withdrawn by the CEO' })}>Withdraw</button>}
        {decider && r.status === 'triage' && (
          <>
            <select className="co-input" style={{ width: 'auto' }} aria-label={`Route ${r.key} to`} value={route} onChange={(e) => setRoute(e.target.value)}>
              <option value="">Route to…</option>
              {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="co-btn small" disabled={!route} onClick={() => void act({ answer: 'route', unitId: route })}>Route</button>
          </>
        )}
      </span>
    </div>
  );
}

function RequestForm({ wsId, services, initial, units, onDone }: { wsId: string; services: OrgServiceEntry[]; initial: string; units: Array<{ id: string; name: string }>; onDone: (note: string | null) => Promise<void> }) {
  const app = useApp();
  const [service, setService] = useState(initial);
  const [unit, setUnit] = useState('');
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [serves, setServes] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const svc = services.find((s) => s.name === service);
  const fields = svc?.fieldList ?? [];
  const send = async () => {
    const p = formProblems(fields, values, { title, why });
    setProblems(p);
    if (p.length) return;
    try {
      const r = await api.requestOrgService(wsId, { ...(svc ? { service: svc.name } : unit ? { unitId: unit } : {}), title: title.trim(), why: why.trim(), fields: values, ...(neededBy ? { neededBy } : {}), ...(serves.trim() ? { serves: serves.trim() } : {}) });
      await onDone(r.note);
    } catch (e) { setProblems([errText(e)]); app.showToast('The request was refused — see why'); }
  };
  return (
    <div className="co-card" style={{ padding: 14, marginBottom: 14 }} role="form" aria-label="Request a service">
      <div className="co-form">
        <div className="co-form-row">
          <label className="co-field"><span>Service</span>
            <select className="co-input" value={service} onChange={(e) => { setService(e.target.value); setValues({}); }} aria-label="Service">
              <option value="">No service fits — ask a department</option>
              {services.map((s) => <option key={s.id} value={s.name}>{s.title} ({s.unitName})</option>)}
            </select>
          </label>
          {!svc && (
            <label className="co-field"><span>Department</span>
              <select className="co-input" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Department">
                <option value="">Let the chief route it</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="co-form-row">
          <label className="co-field"><span>What you need</span><input className="co-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={svc ? `${svc.title}: …` : 'One line'} /></label>
          <label className="co-field"><span>Needed by</span><input className="co-input" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></label>
        </div>
        <label className="co-field"><span>Why</span><textarea className="co-input" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What it unblocks, or which goal it moves" /></label>
        {fields.map((f) => {
          const kind = inputKind(f);
          const v = values[f.name] ?? '';
          const set = (x: string) => setValues({ ...values, [f.name]: x });
          return (
            <label key={f.name} className="co-field"><span>{f.label}{f.required ? '' : ' (optional)'}</span>
              {kind === 'select' ? <select className="co-input" value={v} onChange={(e) => set(e.target.value)} aria-label={f.label}><option value="">Choose…</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                : kind === 'textarea' ? <textarea className="co-input" rows={2} value={v} onChange={(e) => set(e.target.value)} aria-label={f.label} />
                : kind === 'checkbox' ? <input type="checkbox" checked={v === 'yes'} onChange={(e) => set(e.target.checked ? 'yes' : 'no')} aria-label={f.label} />
                : <input className="co-input" type={kind} value={v} onChange={(e) => set(e.target.value)} aria-label={f.label} />}
              {f.description && <small>{f.description}</small>}
            </label>
          );
        })}
        <label className="co-field"><span>Serves (optional)</span><input className="co-input" value={serves} onChange={(e) => setServes(e.target.value)} placeholder="A project key (P-3) or a goal" /></label>
        {problems.length > 0 && <div className="co-alert" role="alert" data-testid="request-problems">{problems.map((p, i) => <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</div>)}</div>}
        <div className="co-form-foot">
          <button className="co-btn ghost" onClick={() => void onDone(null)}>Cancel</button>
          <button className="co-btn primary" onClick={() => void send()}>Send the request</button>
        </div>
      </div>
    </div>
  );
}

function Library({ wsId, onAdded }: { wsId: string; onAdded: () => Promise<void> }) {
  const app = useApp();
  const [list, setList] = useState<ServiceTemplate[] | null>(null);
  useEffect(() => { void api.orgServiceTemplates(wsId).then(setList).catch(() => setList([])); }, [wsId]);
  const add = async (t: ServiceTemplate) => {
    try { await api.createOrgService(wsId, { template: t.id, unitId: t.unitId, reason: 'added from the library by the CEO' }); app.showToast(`${t.title} added to ${t.unitName ?? 'the company'}`); await onAdded(); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title="Starter services" aside="adopt one; its SLAs start from the company's">
        {!list && <SkeletonRows rows={3} label="Loading the library" />}
        <div className="co-rows" data-testid="service-library">
          {(list ?? []).map((t) => (
            <div key={t.id} className="co-row static">
              <span className="co-row-main">
                <span className="co-row-title">{t.title}</span>
                <span className="co-row-meta" style={{ whiteSpace: 'normal' }}>{t.summary} · {t.unitName ? `for ${t.unitName}` : 'no matching department yet (the company answers)'} · needs {t.fields.filter((f) => f.required).map((f) => f.label).join(', ')}</span>
              </span>
              <span className="co-row-end">{t.adopted ? <Pill tone="ok" plain>added</Pill> : <button className="co-btn small" onClick={() => void add(t)}>Add</button>}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
