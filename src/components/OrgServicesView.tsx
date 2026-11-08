/** People › Services (docs/services.md): what each department offers the
 *  rest of the company. The catalog groups services by department (a
 *  department's card on People › Teams opens it filtered), each with who
 *  answers, its accept and resolve SLAs, its metrics and — behind Details —
 *  the fields a request needs and the process it runs. The open requests
 *  come first, what waits on the CEO on top (a counter-proposal to answer,
 *  an ask nobody routed), each with its live SLA clock and its thread. The
 *  CEO requests a service (or asks a department for something no service
 *  covers) in a form generated from the service's fields, and adopts
 *  starter services from the library — shown in place when the catalog is
 *  empty. Breaches that climb to the CEO arrive in the Inbox as decision
 *  cards. Lib: src/lib/services.ts. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgServiceEntry, type OrgServiceRequestRow, type ServiceTemplate } from '../lib/api';
import {
  answererWords, byDepartment, FIELD_TYPE_WORD, formProblems, inputKind, isOpenRequest, metricFigures, needsCeo, REQUEST_TONE, REQUEST_WORD, shortDate, slaCountdown, slaWords,
  sortOpenRequests, threadActor, threadWords,
} from '../lib/services';
import { navigate, parseRoute } from '../lib/routes';
import { I, P } from '../lib/icons';
import { ago, useAgentNames, useUnits } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Avatar, Card, Empty, Metric, PageHeader, Pill, SkeletonRows } from './CompanyKit';
import '../styles/quality-services.css';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 800) : 'failed');

/** The expander's chevron; it turns when its button is expanded (quality-services.css). */
const Chev = () => <span className="qx-chev" aria-hidden style={{ display: 'inline-flex', color: 'var(--text-faint)' }}><I d={P.chevD} size={12} /></span>;
/** A title with the chevron glued to its last word, so it never wraps alone. */
const ChevTitle = ({ text }: { text: string }) => { const i = text.lastIndexOf(' '); return <>{i > 0 ? text.slice(0, i + 1) : ''}<span style={{ whiteSpace: 'nowrap' }}>{i > 0 ? text.slice(i + 1) : text}<Chev /></span></>; };

type Data = { services: OrgServiceEntry[]; requests: OrgServiceRequestRow[] };
type Unit = { id: string; name: string };

/** The process page of a service's linked process, in this company. */
function openProcess(id: string) {
  const company = parseRoute(window.location.pathname)?.company;
  if (company) navigate(`/${company}/processes/${id}`);
}

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
  const formRef = useRef<HTMLDivElement>(null);
  const unitFilter = app.orgUnitId && units.find((u) => u.id === app.orgUnitId)?.parentUnitId !== null ? app.orgUnitId : null;
  const load = useCallback(async () => {
    try { setData(await api.orgServices(wsId)); setErr(null); } catch (e) { setErr(errText(e)); }
  }, [wsId]);
  useEffect(() => { void load(); const t = setInterval(() => { void load(); }, 30_000); return () => clearInterval(t); }, [load]);
  // A form opened from a service row scrolls into view and takes focus.
  useEffect(() => { if (form) requestAnimationFrame(() => { formRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); formRef.current?.querySelector<HTMLElement>(form.service ? 'input' : 'select')?.focus(); }); }, [form]);

  const allActive = (data?.services ?? []).filter((s) => s.status === 'active');
  const active = allActive.filter((s) => !unitFilter || s.unitId === unitFilter);
  const serviceOf = useMemo(() => new Map((data?.services ?? []).map((s) => [s.id, s])), [data]);
  const unitName = (id: string | null) => (id ? units.find((u) => u.id === id)?.name ?? 'a department' : 'the company');
  const inScope = (r: OrgServiceRequestRow) => !unitFilter || r.providerUnitId === unitFilter;
  const open = sortOpenRequests((data?.requests ?? []).filter((r) => isOpenRequest(r) && inScope(r)));
  const closed = (data?.requests ?? []).filter((r) => !isOpenRequest(r) && inScope(r));
  const breached = open.filter((r) => r.clock.breached).length;
  const waiting = open.filter(needsCeo).length;
  const deptUnits = units.filter((u) => u.parentUnitId !== null);
  const countOf = (id: string) => allActive.filter((s) => s.unitId === id).length;
  const empty = data && allActive.length === 0;
  const about = <>What each department offers the rest of the company: the fields a request needs, who answers and how fast. The <b>accept SLA</b> is the time to an answer — accepted with a date, declined with a reason, or a counter-proposal; the <b>resolve SLA</b> is the time to delivery. A request naming a service goes straight to its department; silence past the accept SLA climbs to the department's head, the chief, then you (a card in the Inbox).</>;
  return (
    <div className="co-page" data-testid="services-page">
      <PageHeader title="Services" purpose={about}
        actions={decider ? <>
          {!empty && <button className="co-btn" onClick={() => setLibrary(!library)} aria-expanded={library}>{library ? 'Close library' : 'Add from library'}</button>}
          <button className="co-btn primary" onClick={() => setForm(form ? null : { service: '' })} aria-expanded={Boolean(form)}><I d={P.plus} size={13} />New request</button>
        </> : undefined} />
      {err && <div className="co-alert" role="alert" style={{ marginBottom: 12 }}>{err} <button className="co-link" onClick={() => void load()}>Try again</button></div>}
      {deptUnits.length > 0 && !empty && (
        <div className="co-chips" style={{ margin: '0 0 14px' }} role="group" aria-label="Department">
          <button className={`co-chip${unitFilter ? '' : ' on'}`} aria-pressed={!unitFilter} onClick={() => app.setOrgUnitId(null)}>All departments</button>
          {deptUnits.map((u) => <button key={u.id} className={`co-chip${unitFilter === u.id ? ' on' : ''}`} aria-pressed={unitFilter === u.id} onClick={() => app.setOrgUnitId(u.id)}>{u.name}{data && <span className="co-chip-n">{countOf(u.id)}</span>}</button>)}
        </div>
      )}
      {data && !empty && (
        <div className="co-metrics" style={{ margin: '0 0 16px' }} data-testid="service-counts">
          <Metric n={active.length} label={active.length === 1 ? 'service' : 'services'} />
          <Metric n={open.length} label="open requests" />
          <Metric n={waiting} label="wait on you" tone={waiting ? 'warn' : undefined} title="A counter-proposal on your request, or an ask that named no department" />
          <Metric n={breached} label="past their SLA" tone={breached ? 'bad' : undefined} title="Open requests past their accept SLA or delivery date" />
        </div>
      )}
      {form && data && (
        <div ref={formRef}>
          <RequestForm wsId={wsId} services={allActive} initial={form.service} units={deptUnits} onDone={async (note) => { setForm(null); if (note) app.showToast(note); await load(); }} />
        </div>
      )}
      {!data && !err && <div className="co-card"><SkeletonRows rows={4} label="Loading services" /></div>}
      {data && open.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <Card title="Open requests" aside={waiting ? `${open.length} · ${waiting} wait on you` : `${open.length}`} flush>
            <div data-testid="open-requests">
              {open.map((r) => <RequestRow key={r.id} r={r} svc={r.serviceId ? serviceOf.get(r.serviceId) : undefined} provider={unitName(r.providerUnitId)} wsId={wsId} decider={decider} units={deptUnits} services={allActive} onChanged={load} />)}
            </div>
          </Card>
        </div>
      )}
      {empty && (
        <div className="co-card" style={{ marginBottom: 14 }}>
          <Empty title="No services yet" testid="services-empty">
            A service is a department's promise to the rest of the company: what to ask for, who answers and how fast. {decider ? 'Add a starter below, or let each head publish their own.' : 'Each department\'s head publishes their own.'} Until then, asks still reach a department{decider ? ' with New request' : ''}.
          </Empty>
        </div>
      )}
      {decider && (library || empty) && <Library wsId={wsId} inline={Boolean(empty)} onClose={empty ? undefined : () => setLibrary(false)} onAdded={load} />}
      {data && !empty && active.length === 0 && (
        <div className="co-card" style={{ marginBottom: 14 }}><Empty compact title={`${unitName(unitFilter)} offers no services yet`}>Its head can publish one{decider ? ', or add a starter from the library' : ''}. Asks still reach it with New request.</Empty></div>
      )}
      {byDepartment(active).map((g) => (
        <div key={g.unitId ?? 'company'} style={{ marginBottom: 14 }}>
          <Card title={g.unitName} aside={`${g.services.length} service${g.services.length === 1 ? '' : 's'}`} flush>
            <div data-testid={`catalog-${g.unitId ?? 'company'}`}>
              {g.services.map((s) => <ServiceRow key={s.id} s={s} onRequest={decider ? () => setForm({ service: s.name }) : undefined} />)}
            </div>
          </Card>
        </div>
      ))}
      {closed.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <button className="co-btn ghost small" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>
            <Chev />{showClosed ? 'Hide' : 'Show'} closed requests ({closed.length})
          </button>
          {showClosed && <div className="co-card" style={{ marginTop: 8, padding: '4px 6px' }}>{closed.slice(0, 40).map((r) => <RequestRow key={r.id} r={r} svc={r.serviceId ? serviceOf.get(r.serviceId) : undefined} provider={unitName(r.providerUnitId)} wsId={wsId} decider={false} units={deptUnits} services={allActive} onChanged={load} />)}</div>}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ s, onRequest }: { s: OrgServiceEntry; onRequest?: () => void }) {
  const names = useAgentNames();
  const [open, setOpen] = useState(false);
  const owner = s.ownerAgentId ? names.get(s.ownerAgentId) : undefined;
  const figs = metricFigures(s.metrics);
  return (
    <div className={`qx-item${open ? ' open' : ''}`} data-testid="service-row">
      <div className="qx-head">
        <div className="qx-main">
          <button className="qx-title" onClick={() => setOpen(!open)} aria-expanded={open}><ChevTitle text={s.title} /></button>
          {s.description && <div className="qx-desc">{s.description}</div>}
          <div className="qx-meta qx-dots" data-testid="service-sla">
            {owner ? <span className="co-owner"><Avatar a={owner} size={16} /><b>{owner.name}</b>&nbsp;answers</span> : <span>{answererWords(s)} answers</span>}
            <span>replies within <b>{slaWords(s.acceptSlaHours)}</b></span>
            <span>delivers within <b>{slaWords(s.resolveSlaHours)}</b></span>
          </div>
          {s.metrics.requests > 0
            ? <div className="qx-figs" data-testid="service-metrics">{figs.map((m) => <span key={m.label} title={m.title} className={m.tone ?? ''}><b>{m.value}</b> {m.label}</span>)}</div>
            : <div className="qx-figs" data-testid="service-metrics">No requests yet</div>}
        </div>
        <div className="qx-end">
          {s.pendingChange && <Pill tone="warn" title="A change to this service waits for approval">change pending</Pill>}
          {onRequest && <button className="co-btn small" onClick={onRequest}>Request</button>}
        </div>
      </div>
      {open && (
        <div className="qx-body" data-testid="service-detail">
          <div>
            <div className="co-sub" style={{ marginTop: 0 }}>A request needs</div>
            {s.fieldList.length === 0 ? <div className="qx-meta">Nothing beyond a title and why.</div> : (
              <div className="qx-crit">
                {s.fieldList.map((f) => (
                  <div key={f.name} className="qx-crit-row">
                    <span className="qx-crit-text"><b style={{ fontWeight: 600 }}>{f.label}</b>{f.description && <span className="qx-crit-note">{f.description}</span>}</span>
                    <span className="qx-tags"><span className="qx-tag">{f.type === 'choice' && f.options?.length ? f.options.join(' / ') : FIELD_TYPE_WORD[f.type]}</span>{!f.required && <span className="qx-tag opt">optional</span>}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <dl className="co-dl">
            <dt>Runs</dt>
            <dd>{s.processId && s.processName !== 'service-request' ? <button className="co-link" onClick={() => openProcess(s.processId!)}>{s.processName}</button> : 'The standard intake: accept, do, deliver'}</dd>
            <dt>Answered by</dt><dd>{owner ? `${owner.name} (${s.ownerRole === 'head' ? `head of ${s.unitName}` : s.ownerRole})` : answererWords(s)}</dd>
            {s.metrics.requests > 0 && <><dt>So far</dt><dd>{s.metrics.requests} requests: {s.metrics.open} open, {s.metrics.delivered} delivered, {s.metrics.declined} declined</dd></>}
            <dt>Version</dt><dd>v{s.version}{s.pendingChange ? ' — a change waits for approval' : ''}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}

function RequestRow({ r, svc, provider, wsId, decider, units, services, onChanged }: { r: OrgServiceRequestRow; svc?: OrgServiceEntry; provider: string; wsId: string; decider: boolean; units: Unit[]; services: OrgServiceEntry[]; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [openThread, setOpenThread] = useState(false);
  const [route, setRoute] = useState('');
  const [busy, setBusy] = useState(false);
  const clock = r.status === 'negotiating' || r.status === 'triage' ? null : slaCountdown(r);
  const mine = !r.requesterAgentId;
  const requester = r.requesterAgentId ? names.get(r.requesterAgentId)?.name ?? 'a member' : 'you';
  const act = async (body: { answer: string; due?: string; unitId?: string; service?: string; reason?: string }) => {
    setBusy(true);
    try { const res = await api.respondOrgServiceRequest(wsId, r.id, body); app.showToast(res.note); await onChanged(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  const withdraw = () => { if (window.confirm(`Withdraw ${r.key} (${r.title})? Its run and open steps are cancelled.`)) void act({ answer: 'withdraw', reason: 'withdrawn by the CEO' }); };
  const doRoute = () => { if (!route) return; void act(route.startsWith('svc:') ? { answer: 'route', service: route.slice(4) } : { answer: 'route', unitId: route }); };
  const fields = Object.entries(r.fields);
  const label = (k: string) => svc?.fieldList.find((f) => f.name === k)?.label ?? k.replace(/_/g, ' ');
  return (
    <div className={`qx-item${openThread ? ' open' : ''}`} data-testid="request-row">
      <div className="qx-head">
        <div className="qx-main">
          <button className="qx-title" onClick={() => setOpenThread(!openThread)} aria-expanded={openThread}>
            <span className="co-key">{r.key}</span><ChevTitle text={r.title} />
          </button>
          <div className="qx-meta">
            {svc?.title ?? 'Unlisted ask'} · {r.status === 'triage' ? 'not routed yet' : provider} · from {requester} · {ago(r.createdAt)}
            {r.committedDue ? ` · due ${shortDate(r.committedDue)}` : ''}{r.breaches ? ` · ${r.breaches} breach${r.breaches === 1 ? '' : 'es'}` : ''}
          </div>
        </div>
        <div className="qx-end">
          {clock && <Pill tone={clock.tone} plain testid="sla-clock">{clock.label}</Pill>}
          <Pill tone={REQUEST_TONE[r.status]}>{REQUEST_WORD[r.status]}</Pill>
        </div>
      </div>
      {r.status === 'negotiating' && r.counter && (
        <div className="qx-callout" data-testid="request-counter">
          <span><b>{provider} proposes:</b> {[r.counter.due ? `by ${shortDate(r.counter.due)}` : '', r.counter.scope ?? '', r.counter.note ?? ''].filter(Boolean).join(' · ')}</span>
          {decider && mine && <span className="qx-callout-acts"><button className="co-btn small primary" disabled={busy} onClick={() => void act({ answer: 'agree' })}>Agree</button><button className="co-btn small ghost" disabled={busy} onClick={withdraw}>Withdraw</button></span>}
          {!mine && <span className="co-faint" style={{ flex: 'none' }}>waiting on {requester}</span>}
        </div>
      )}
      {decider && r.status === 'triage' && (
        <div className="qx-callout info" data-testid="request-route">
          <span>Nobody has picked this up. The chief routes it, or you can now.</span>
          <select className="co-input" aria-label={`Route ${r.key} to`} value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">Route to…</option>
            <optgroup label="A department">{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</optgroup>
            {services.length > 0 && <optgroup label="A service">{services.map((s) => <option key={s.id} value={`svc:${s.name}`}>{s.title} ({s.unitName})</option>)}</optgroup>}
          </select>
          <span className="qx-callout-acts"><button className="co-btn small" disabled={!route || busy} onClick={doRoute}>Route</button></span>
        </div>
      )}
      {r.status === 'declined' && r.declineReason && <div className="qx-meta" style={{ marginTop: 4 }}>Declined: {r.declineReason}</div>}
      {openThread && (
        <div className="qx-body">
          <dl className="co-dl">
            {r.why && <><dt>Why</dt><dd>{r.why}</dd></>}
            {fields.map(([k, v]) => <FieldDef key={k} k={label(k)} v={v} />)}
            {r.neededBy && <><dt>Needed by</dt><dd>{shortDate(r.neededBy)}</dd></>}
            {r.servesLabel && <><dt>Serves</dt><dd>{r.servesLabel}</dd></>}
          </dl>
          {r.thread.length > 0 && (
            <ol className="qx-thread" data-testid="request-thread" aria-label="Thread">
              {r.thread.map((e, i) => (
                <li key={i} className={/breach/.test(e.action) ? 'bad' : e.action === 'accepted' || e.action === 'agreed' ? 'ok' : ''}>
                  <b style={{ fontWeight: 600 }}>{threadActor(e.by, (id) => names.get(id)?.name)}</b> {threadWords(e)}<time dateTime={e.at}>{ago(e.at)}</time>
                </li>
              ))}
            </ol>
          )}
          {decider && mine && isOpenRequest(r) && r.status !== 'negotiating' && <div><button className="co-btn small ghost" disabled={busy} onClick={withdraw}>Withdraw request</button></div>}
        </div>
      )}
    </div>
  );
}

function FieldDef({ k, v }: { k: string; v: string }) {
  return <><dt>{k}</dt><dd>{/^https?:\/\/\S+$/i.test(v) ? <a href={v} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent-hi)' }}>{v}</a> : v}</dd></>;
}

function RequestForm({ wsId, services, initial, units, onDone }: { wsId: string; services: OrgServiceEntry[]; initial: string; units: Unit[]; onDone: (note: string | null) => Promise<void> }) {
  const app = useApp();
  const [service, setService] = useState(initial);
  const [unit, setUnit] = useState('');
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [serves, setServes] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const svc = services.find((s) => s.name === service);
  const fields = svc?.fieldList ?? [];
  const groups = byDepartment(services);
  const send = async () => {
    const p = formProblems(fields, values, { title, why });
    setProblems(p);
    if (p.length) return;
    setSending(true);
    try {
      const r = await api.requestOrgService(wsId, { ...(svc ? { service: svc.name } : unit ? { unitId: unit } : {}), title: title.trim(), why: why.trim(), fields: values, ...(neededBy ? { neededBy } : {}), ...(serves.trim() ? { serves: serves.trim() } : {}) });
      await onDone(r.note);
    } catch (e) { setProblems([errText(e)]); app.showToast('The request was refused — see why'); } finally { setSending(false); }
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title="New request" action={<button className="co-iconbtn" aria-label="Close the form" onClick={() => void onDone(null)}><I d={P.x} size={14} /></button>}>
        <div className="co-form" role="form" aria-label="Request a service" onKeyDown={(e) => { if (e.key === 'Escape') void onDone(null); }}>
          <div className="co-form-row">
            <label className="co-field"><span>Service</span>
              <select className="co-input" value={service} onChange={(e) => { setService(e.target.value); setValues({}); setProblems([]); }} aria-label="Service">
                <option value="">No service fits — ask a department</option>
                {groups.map((g) => <optgroup key={g.unitId ?? 'company'} label={g.unitName}>{g.services.map((s) => <option key={s.id} value={s.name}>{s.title}</option>)}</optgroup>)}
              </select>
              {svc && <small data-testid="request-sla">{svc.unitName} answers within {slaWords(svc.acceptSlaHours)} and delivers within {slaWords(svc.resolveSlaHours)}.</small>}
            </label>
            {!svc && (
              <label className="co-field"><span>Department</span>
                <select className="co-input" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Department">
                  <option value="">Not sure — the chief routes it</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="co-form-row">
            <label className="co-field"><span>What you need</span><input className="co-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={svc ? `${svc.title}: …` : 'One line'} /></label>
            <label className="co-field" style={{ maxWidth: 220 }}><span>Needed by (optional)</span><input className="co-input" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></label>
          </div>
          <label className="co-field"><span>Why</span><textarea className="co-input" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What it unblocks, or which goal it moves" /></label>
          {fields.length > 0 && <div className="co-sub" style={{ margin: '2px 0 -4px' }}>{svc!.title} asks for</div>}
          {fields.map((f) => {
            const kind = inputKind(f);
            const v = values[f.name] ?? '';
            const set = (x: string) => setValues({ ...values, [f.name]: x });
            if (kind === 'checkbox') return (
              <label key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={v === 'yes'} onChange={(e) => set(e.target.checked ? 'yes' : 'no')} aria-label={f.label} />
                <span>{f.label}{f.required ? '' : <span className="co-faint"> (optional)</span>}</span>
              </label>
            );
            return (
              <label key={f.name} className="co-field"><span>{f.label}{f.required ? '' : ' (optional)'}</span>
                {kind === 'select' ? <select className="co-input" value={v} onChange={(e) => set(e.target.value)} aria-label={f.label}><option value="">Choose…</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                  : kind === 'textarea' ? <textarea className="co-input" rows={2} value={v} onChange={(e) => set(e.target.value)} aria-label={f.label} />
                  : <input className="co-input" type={kind} value={v} onChange={(e) => set(e.target.value)} aria-label={f.label} placeholder={kind === 'url' ? 'https://…' : undefined} />}
                {f.description && <small>{f.description}</small>}
              </label>
            );
          })}
          <label className="co-field"><span>Serves (optional)</span><input className="co-input" value={serves} onChange={(e) => setServes(e.target.value)} placeholder="A project key (P-3) or a goal" /></label>
          {problems.length > 0 && <div className="co-alert" role="alert" data-testid="request-problems">{problems.map((p, i) => <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</div>)}</div>}
          <div className="co-form-foot">
            <button className="co-btn ghost" onClick={() => void onDone(null)}>Cancel</button>
            <button className="co-btn primary" disabled={sending} onClick={() => void send()}>{sending ? 'Sending…' : 'Send the request'}</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Library({ wsId, inline, onClose, onAdded }: { wsId: string; inline: boolean; onClose?: () => void; onAdded: () => Promise<void> }) {
  const app = useApp();
  const [list, setList] = useState<ServiceTemplate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const fetchList = useCallback(() => { setFailed(false); void api.orgServiceTemplates(wsId).then(setList).catch(() => { setList([]); setFailed(true); }); }, [wsId]);
  useEffect(() => { fetchList(); }, [fetchList]);
  const add = async (t: ServiceTemplate) => {
    setAdding(t.id);
    try {
      await api.createOrgService(wsId, { template: t.id, unitId: t.unitId, reason: 'added from the library by the CEO' });
      app.showToast(`${t.title} added to ${t.unitName ?? 'the company'}`);
      setList((l) => l?.map((x) => (x.id === t.id ? { ...x, adopted: true } : x)) ?? l);
      await onAdded();
    } catch (e) { app.showToast(errText(e)); } finally { setAdding(null); }
  };
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title={inline ? 'Starter services' : 'Add from library'} aside="each goes to the department it fits; its SLAs start from the company's"
        action={onClose ? <button className="co-iconbtn" aria-label="Close the library" onClick={onClose}><I d={P.x} size={14} /></button> : undefined}>
        {!list && <SkeletonRows rows={3} label="Loading the library" />}
        {failed && <div className="co-alert" role="alert">The library did not load. <button className="co-link" onClick={fetchList}>Try again</button></div>}
        {list && list.length === 0 && !failed && <Empty compact title="No starters to add">Every starter is in the catalog already.</Empty>}
        <div className="qx-lib" data-testid="service-library">
          {(list ?? []).map((t) => (
            <div key={t.id} className="qx-lib-card" data-testid="library-item">
              <h4>{t.title}</h4>
              <p>{t.summary}</p>
              <div className="qx-tags" aria-label="A request asks for">
                {t.fields.map((f) => <span key={f.name} className={`qx-tag${f.required ? '' : ' opt'}`}>{f.label}</span>)}
              </div>
              <div className="qx-lib-foot">
                <span className="co-faint">{t.unitName ? `For ${t.unitName}` : 'No matching department — the company answers'}</span>
                {t.adopted ? <Pill tone="ok" plain>in the catalog</Pill> : <button className="co-btn small" disabled={adding !== null} onClick={() => void add(t)}>{adding === t.id ? 'Adding…' : 'Add'}</button>}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
