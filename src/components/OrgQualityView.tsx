/** Quality control on screen (docs/quality.md §8): the Oversight › Quality
 *  page — one sentence and the figures (first-pass yield, rework, escapes,
 *  spot checks, violations, conformance), what waits on the CEO (proposed
 *  standards and rules, exceptions asked for, work that came back), the
 *  standards with their criteria (adopt one from the template library with
 *  a preview, retire), the policies with their rules, violations and
 *  exceptions, the Claims card, the latest QC results and the members by
 *  first-pass yield — and the task's QC panel: each review round with its
 *  criteria, scores, notes and evidence links. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgPolicy, type OrgTask, type QcResult, type QualityOverview, type QualityStandard } from '../lib/api';
import {
  criterionRows, ENFORCEMENT_WORD, evidenceTarget, evidenceWords, INDEPENDENCE_LABEL, makersByYield, OUTCOME_LABEL, OUTCOME_TONE, pct, qcRounds, qualityAttention,
  qualityLede, ruleLines, scopeWords, VIOLATION_STATUS_WORD, violationsByPolicy,
} from '../lib/quality';
import type { Tone } from '../lib/direction';
import { openFileInPanel } from '../lib/file-links';
import { I, P } from '../lib/icons';
import { ago, useAgentNames, useUnits } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { AttentionList, Avatar, Bar, Card, Empty, Metric, PageHeader, Pill, SkeletonRows } from './CompanyKit';
import { ClaimsPanel } from './OrgClaimsView';
import '../styles/quality-services.css';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 240) : 'failed');
const Chev = () => <span className="qx-chev" aria-hidden style={{ display: 'inline-flex', color: 'var(--text-faint)' }}><I d={P.chevD} size={12} /></span>;
/** A title with the chevron glued to its last word, so it never wraps alone. */
const ChevTitle = ({ text }: { text: string }) => { const i = text.lastIndexOf(' '); return <>{i > 0 ? text.slice(0, i + 1) : ''}<span style={{ whiteSpace: 'nowrap' }}>{i > 0 ? text.slice(i + 1) : text}<Chev /></span></>; };
const yieldTone = (v: number | null): Tone | undefined => (v === null ? undefined : v < 0.6 ? 'bad' : v < 0.8 ? 'warn' : 'ok');

/** One evidence reference: a file opens in the side panel, a page in a new tab. */
export function EvidenceLink({ raw }: { raw: string }) {
  const t = evidenceTarget(raw);
  if (t.kind === 'file') return <button className="co-link" style={{ fontSize: 12, fontWeight: 500, overflowWrap: 'anywhere' }} onClick={() => openFileInPanel(t.path)} title={`Open /${t.path}`}>/{t.path}</button>;
  if (t.kind === 'url') return <a href={t.href} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, color: 'var(--accent-hi)', wordBreak: 'break-all' }}>{t.href.replace(/^https?:\/\//, '')}</a>;
  return <code style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{raw}</code>;
}

export function QualityPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const { units } = useUnits();
  const unitName = useCallback((id: string) => units.find((u) => u.id === id)?.name, [units]);
  const [q, setQ] = useState<QualityOverview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState(false);
  const refresh = useCallback(async () => { setQ(await api.orgQuality(wsId).catch(() => null)); }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); app.showToast(done); await refresh(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  const byPolicy = useMemo(() => violationsByPolicy(q?.violations ?? []), [q]);
  const toInbox = () => { app.go('inbox'); app.setInboxFilter('approvals'); };
  const ok = q && q.metrics?.overall && Array.isArray(q.standards);
  const live = ok ? q.standards.filter((s) => s.status === 'active' || s.status === 'proposed') : [];
  const policies = ok ? q.policies.filter((p) => p.status !== 'retired' && p.status !== 'rejected') : [];
  const inUse = (id: string) => ok ? q.standards.some((s) => s.source === `template:${id}` && (s.status === 'active' || s.status === 'proposed')) : false;
  const attention = ok ? qualityAttention(q).map((a) => ({ id: a.id, tone: (a.kind === 'escape' ? 'bad' : 'warn') as Tone, title: a.title, why: a.why, go: a.taskId ? 'Open task' : 'Decide in Inbox', onOpen: a.taskId ? () => app.openOrgTask(a.taskId!) : toInbox })) : [];
  const spotCheck = () => { if (window.confirm('Run today\'s spot checks now? Accepted work from the last week is sampled and re-verified; some of it is handed to an independent member to grade.')) void act(() => api.runQualitySpotCheck(wsId), 'Spot checks run'); };
  const o = ok ? q.metrics.overall : null;
  const about = <>Whether finished work meets the bar, and whether anyone broke a rule on the way. <b>Standards</b> say what a deliverable must meet: criteria graded 1–5 by a verifier who is not the maker, against evidence the platform checks. <b>Policies</b> are rules checked before tool calls and at review. An <b>escape</b> is accepted work that came back.</>;
  return (
    <div className="co-page" data-testid="quality-page">
      <PageHeader title="Quality" purpose={about}
        actions={decider && ok ? <>
          <button className="co-btn" disabled={busy} onClick={spotCheck}>Run spot checks</button>
          {live.length > 0 && <button className="co-btn primary" onClick={() => setLibrary(!library)} aria-expanded={library}><I d={P.plus} size={13} />Add a standard</button>}
        </> : undefined} />
      {q === undefined && <div className="co-card"><SkeletonRows rows={4} label="Loading quality" /></div>}
      {q === null && <div className="co-alert" role="alert">Quality did not load. <button className="co-link" onClick={() => void refresh()}>Try again</button></div>}
      {ok && o && (
        <>
          <p data-testid="quality-lede" style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>{qualityLede(q)}</p>
          {(o.tasks > 0 || o.spotChecks > 0 || q.metrics.policies.violations > 0) && <div className="co-metrics" style={{ margin: '0 0 16px' }} data-testid="quality-metrics">
            <Metric n={pct(o.firstPassYield)} label="passed first time" title="Tasks accepted at their first review" tone={yieldTone(o.firstPassYield) === 'ok' ? undefined : yieldTone(o.firstPassYield)} />
            <Metric n={pct(o.reworkRate)} label="needed rework" title="Tasks sent back at least once" />
            <Metric n={o.escapes} label="came back" title="Escapes: accepted work later reopened, tied to an incident, or failing a spot check" tone={o.escapes ? 'bad' : undefined} />
            <Metric n={o.spotChecks} label="spot checks" title={`${o.spotCheckFails} failed`} tone={o.spotCheckFails ? 'warn' : undefined} />
            <Metric n={q.metrics.policies.violations} label="rule violations" tone={q.metrics.policies.violations ? 'warn' : undefined} />
            <Metric n={pct(q.metrics.policies.resultConformance)} label="results within the rules" title="Share of result-policy checks that were met" />
          </div>}
          {library && decider && live.length > 0 && (
            <StandardLibrary templates={q.templates} inUse={inUse} busy={busy} onClose={() => setLibrary(false)}
              onAdopt={(id, name) => void act(async () => { await api.createQualityStandard(wsId, { template: id }); }, `Adopted ${name}`)} />
          )}
          {attention.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <Card title="Needs you" aside={`${attention.length}`} flush><AttentionList items={attention} limit={5} testid="quality-attention" /></Card>
            </div>
          )}
          <div className="co-split">
            <div className="co-stack">
              <Card id="quality-standards" title="Standards" aside={live.length ? `${live.length}` : undefined}
                action={decider && live.length > 0 && !library ? <button className="co-btn small ghost" onClick={() => setLibrary(true)}>Templates</button> : undefined} flush>
                {live.length === 0 && (
                  <div style={{ padding: '0 10px 6px' }} data-testid="standards-empty">
                    <Empty compact title="No standards yet">Work is accepted on its done_when alone. {decider ? 'Adopt a template below — the chief can tune it after — or ask the chief of staff to write the standards your deliverables need.' : 'The chief of staff writes the standards your deliverables need.'}</Empty>
                    {decider && <TemplateGrid templates={q.templates} inUse={inUse} busy={busy} onAdopt={(id, name) => void act(async () => { await api.createQualityStandard(wsId, { template: id }); }, `Adopted ${name}`)} />}
                  </div>
                )}
                {live.map((s) => <StandardRow key={s.id} s={s} unitName={unitName} decider={decider} busy={busy} onInbox={toInbox}
                  onRetire={() => { if (window.confirm(`Retire "${s.name}"? Work it covers falls back to the next standard that applies, or its done_when alone.`)) void act(() => api.reviseQualityStandard(wsId, s.id, { action: 'retire' }), `Retired ${s.name}`); }} figures={q.metrics.byStandard[s.id]} />)}
              </Card>
              <Card id="quality-policies" title="Policies" aside={policies.length ? `${policies.length}` : undefined} flush>
                {policies.length === 0 && <div style={{ padding: '0 10px' }}><Empty compact title="No policies yet">Standing rules still live as prose. The chief of staff turns them into rules the platform checks — a price floor, a required disclaimer, no send without a draft.</Empty></div>}
                {policies.map((p) => (
                  <PolicyRow key={p.id} p={p} violations={byPolicy.get(p.id) ?? []} names={names} unitName={unitName} decider={decider} busy={busy} onInbox={toInbox} openTask={(id) => app.openOrgTask(id)}
                    onRetire={() => { if (window.confirm(`Retire the rule "${p.statement}"? It stops being checked.`)) void act(() => api.reviseOrgPolicy(wsId, p.id, { action: 'retire' }), 'Rule retired'); }} />
                ))}
              </Card>
              <ClaimsPanel org={org} />
            </div>
            <div className="co-stack">
              <Card id="quality-results" title="Latest QC results" flush>
                {q.recent.length === 0 && <div style={{ padding: '0 10px' }}><Empty compact title="No reviews graded yet">Each review round and spot check lands here with its score.</Empty></div>}
                <div className="co-rows">
                  {q.recent.slice(0, 10).map((r) => {
                    const verifier = r.verifier.startsWith('agent:') ? names.get(r.verifier.slice(6))?.name : r.verifier === 'check' ? 'its checks' : r.verifier ? 'a person' : undefined;
                    return (
                      <button key={r.id} className="co-row" onClick={() => app.openOrgTask(r.taskId)} data-testid="qc-result" style={{ alignItems: 'flex-start' }}>
                        <span className="co-row-main">
                          <span className="co-row-title wrap">{r.taskKey && <span className="co-key">{r.taskKey}</span>}{r.taskTitle}</span>
                          <span className="co-row-meta">{r.score !== null ? `${r.score}/5` : 'no score'}{verifier ? ` · by ${verifier}` : ''} · {ago(r.decidedAt ?? r.createdAt)}</span>
                        </span>
                        <span className="co-row-end" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                          <Pill tone={OUTCOME_TONE[r.outcome]}>{r.kind === 'spot_check' ? `spot check ${OUTCOME_LABEL[r.outcome]}` : OUTCOME_LABEL[r.outcome]}</Pill>
                          {r.escapedAt && <Pill tone="bad" plain title={r.escapeReason}>came back</Pill>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Card>
              <Card id="quality-members" title="By member" aside="passed first time" flush>
                {makersByYield(q).length === 0 && <div style={{ padding: '0 10px' }}><Empty compact title="Nothing graded yet" /></div>}
                {makersByYield(q).slice(0, 10).map((m) => (
                  <div key={m.agentId} className="qx-member" data-testid="quality-member">
                    <span className="qx-member-name"><Avatar a={names.get(m.agentId)} size={18} /><span>{names.get(m.agentId)?.name ?? 'A former member'}</span></span>
                    <Bar value={m.firstPassYield} tone={yieldTone(m.firstPassYield)} label={`${names.get(m.agentId)?.name ?? 'member'}: passed first time`} />
                    <span className="qx-member-end">
                      <b style={{ color: 'var(--text)', fontWeight: 650 }}>{pct(m.firstPassYield)}</b>
                      <span>of {m.tasks}</span>
                      {m.escapes > 0 && <Pill tone="bad" title="Accepted work that came back">{m.escapes} came back</Pill>}
                    </span>
                  </div>
                ))}
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StandardLibrary({ templates, inUse, busy, onAdopt, onClose }: { templates: QualityOverview['templates']; inUse: (id: string) => boolean; busy: boolean; onAdopt: (id: string, name: string) => void; onClose: () => void }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <Card title="Standard templates" aside="adopt one; the chief can tune it after" action={<button className="co-iconbtn" aria-label="Close the templates" onClick={onClose}><I d={P.x} size={14} /></button>}>
        <TemplateGrid templates={templates} inUse={inUse} busy={busy} onAdopt={onAdopt} />
      </Card>
    </div>
  );
}

function TemplateGrid({ templates, inUse, busy, onAdopt }: { templates: QualityOverview['templates']; inUse: (id: string) => boolean; busy: boolean; onAdopt: (id: string, name: string) => void }) {
  if (templates.length === 0) return <Empty compact title="No templates available" />;
  return (
        <div className="qx-lib" data-testid="quality-library">
          {templates.map((t) => (
            <div key={t.id} className="qx-lib-card" data-testid="quality-template">
              <h4>{t.name}</h4>
              <p>{t.summary}</p>
              <ul aria-label={`${t.name} criteria`}>{t.criteria.map((c) => <li key={c.id}>{c.text}{c.min ? <span className="co-faint"> (at least {c.min}/5)</span> : null}</li>)}</ul>
              <div className="qx-lib-foot">
                <span className="co-faint">{t.deliverable ? `For ${t.deliverable} deliverables` : 'The company default'}</span>
                {inUse(t.id) ? <Pill tone="ok" plain>in use</Pill> : <button className="co-btn small" disabled={busy} onClick={() => onAdopt(t.id, t.name)}>Adopt</button>}
              </div>
            </div>
          ))}
        </div>
  );
}

function StandardRow({ s, unitName, decider, busy, onRetire, onInbox, figures }: { s: QualityStandard; unitName: (id: string) => string | undefined; decider: boolean; busy: boolean; onRetire: () => void; onInbox: () => void; figures?: QualityOverview['metrics']['overall'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`qx-item${open ? ' open' : ''}`} data-testid="quality-standard">
      <div className="qx-head">
        <div className="qx-main">
          <button className="qx-title" onClick={() => setOpen(!open)} aria-expanded={open}><ChevTitle text={s.name} /></button>
          <div className="qx-meta qx-dots">
            <span>{scopeWords(s, unitName)}</span>
            <span>passes at {s.passScore}/5</span>
            <span>{s.criteria.length} criteri{s.criteria.length === 1 ? 'on' : 'a'}</span>
            {s.verifier === 'family' && <span>another model family verifies</span>}
          </div>
        </div>
        <div className="qx-end">
          {s.status === 'proposed' && <button className="co-pill warn" onClick={onInbox} title="Decide in the Inbox">waiting on you</button>}
          {s.pending && <Pill tone="warn" title="The current version stays until the card is decided">revision proposed</Pill>}
          {figures && figures.tasks > 0 && <span className="co-faint co-num" title="Passed review first time">{pct(figures.firstPassYield)} first time · {figures.tasks} task{figures.tasks === 1 ? '' : 's'}</span>}
        </div>
      </div>
      {open && (
        <div className="qx-body">
          {s.summary && <div className="qx-desc" style={{ marginTop: 0 }}>{s.summary}</div>}
          <div className="qx-crit" data-testid="standard-criteria">
            {s.criteria.map((c) => (
              <div key={c.id} className="qx-crit-row">
                <span className="qx-score none" title="Weight in the score">×{c.weight}</span>
                <span className="qx-crit-text">{c.text}<span className="qx-crit-note">{[c.min ? `must score at least ${c.min}` : '', evidenceWords(c.evidence)].filter(Boolean).join(' · ')}</span></span>
              </div>
            ))}
          </div>
          <div className="qx-meta">Version {s.version}{s.requireEvidence ? ' · evidence required per criterion' : ''}</div>
          {decider && s.status === 'active' && <div><button className="co-btn ghost small" disabled={busy} onClick={onRetire}>Retire standard</button></div>}
        </div>
      )}
    </div>
  );
}

function PolicyRow({ p, violations, names, unitName, decider, busy, onRetire, onInbox, openTask }: { p: OrgPolicy; violations: QualityOverview['violations']; names: ReturnType<typeof useAgentNames>; unitName: (id: string) => string | undefined; decider: boolean; busy: boolean; onRetire: () => void; onInbox: () => void; openTask: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const asked = violations.filter((v) => v.status === 'exception_requested').length;
  return (
    <div className={`qx-item${open ? ' open' : ''}`} data-testid="quality-policy">
      <div className="qx-head">
        <div className="qx-main">
          <button className="qx-title" onClick={() => setOpen(!open)} aria-expanded={open}><ChevTitle text={p.statement} /></button>
          <div className="qx-meta qx-dots">
            <span style={{ color: p.enforcement === 'block' ? 'var(--red-text)' : p.enforcement === 'warn' ? 'var(--warn-text)' : undefined, fontWeight: 600 }}>{ENFORCEMENT_WORD[p.enforcement]}</span>
            <span>{p.severity} severity</span>
            <span>{scopeWords(p, unitName)}</span>
            <span>{p.appliesAt === 'result' ? 'at review' : p.appliesAt === 'both' ? 'before calls and at review' : 'before calls'}</span>
          </div>
        </div>
        <div className="qx-end">
          {p.status === 'proposed' && <button className="co-pill warn" onClick={onInbox} title="Decide in the Inbox">waiting on you</button>}
          {asked > 0 && <button className="co-pill warn" onClick={onInbox} title="Decide in the Inbox">{asked} exception{asked === 1 ? '' : 's'} asked</button>}
          {violations.length > 0 && <Pill tone={p.enforcement === 'block' ? 'bad' : 'warn'} plain>{violations.length} violation{violations.length === 1 ? '' : 's'}</Pill>}
        </div>
      </div>
      {open && (
        <div className="qx-body">
          <dl className="co-dl">
            <dt>Rule</dt><dd>{ruleLines(p).join('\n')}</dd>
            {p.remediation && <><dt>Instead</dt><dd>{p.remediation}</dd></>}
            {p.rationale && <><dt>Why</dt><dd>{p.rationale}</dd></>}
          </dl>
          {violations.length > 0 && (
            <div>
              <div className="co-sub" style={{ marginTop: 0 }}>Violations</div>
              <div className="qx-crit">
                {violations.slice(0, 8).map((v) => (
                  <div key={v.id} className="qx-crit-row" data-testid="policy-violation">
                    <Pill tone={v.outcome === 'blocked' ? 'bad' : v.outcome === 'warned' ? 'warn' : undefined}>{v.outcome}</Pill>
                    <span className="qx-crit-text">
                      <b style={{ fontWeight: 600 }}>{names.get(v.agentId)?.name ?? 'A member'}</b> {v.tool ? `called ${v.tool}` : v.taskId ? 'submitted a deliverable' : `at ${v.stage}`}: {v.detail.slice(0, 200)}
                      <span className="qx-crit-note">{[VIOLATION_STATUS_WORD[v.status], ago(v.createdAt)].filter(Boolean).join(' · ')}</span>
                    </span>
                    {v.status === 'exception_requested' && <button className="co-btn small" onClick={onInbox}>Decide</button>}
                    {v.taskId && <button className="co-btn small ghost" onClick={() => openTask(v.taskId!)}>Task</button>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="qx-meta">{p.kind === 'judged' ? 'Judged by an independent checker' : 'Checked by the platform, no model'} · version {p.version} · <code style={{ fontSize: 11 }}>{p.key}</code></div>
          {decider && p.status === 'active' && <div><button className="co-btn ghost small" disabled={busy} onClick={onRetire}>Retire rule</button></div>}
        </div>
      )}
    </div>
  );
}

/** The task's QC panel: the standard it is held to and each round's grade; the latest round open. */
export function TaskQcPanel({ wsId, task }: { wsId: string; task: OrgTask }) {
  const names = useAgentNames();
  const [data, setData] = useState<{ standard: QualityStandard | null; results: QcResult[] } | null>(null);
  const [openIds, setOpenIds] = useState<Set<string> | null>(null);
  useEffect(() => { let live = true; void api.orgTaskQuality(wsId, task.id).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); }); return () => { live = false; }; }, [wsId, task.id, task.status, task.reviewRounds]);
  if (!data || !Array.isArray(data.results) || (!data.standard && data.results.length === 0)) return null;
  const rounds = qcRounds(data.results);
  const latest = rounds.filter((r) => r.kind === 'review').at(-1) ?? rounds.at(-1);
  const isOpen = (id: string) => (openIds ? openIds.has(id) : id === latest?.id);
  const toggle = (id: string) => { const next = new Set(openIds ?? (latest ? [latest.id] : [])); if (next.has(id)) next.delete(id); else next.add(id); setOpenIds(next); };
  return (
    <div data-testid="task-qc" className="qx-qc">
      <div className="qx-qc-head">
        <b>Quality</b>
        {data.standard ? <span className="co-faint">{data.standard.name} · passes at {data.standard.passScore}/5</span> : <span className="co-faint">No standard — accepted on its done_when</span>}
        {latest && <span style={{ marginLeft: 'auto' }}><Pill tone={OUTCOME_TONE[latest.outcome]}>{latest.score !== null ? `${latest.score}/5 · ` : ''}{OUTCOME_LABEL[latest.outcome]}</Pill></span>}
      </div>
      {rounds.length === 0 && <div className="qx-meta" style={{ marginTop: 6 }}>Not submitted yet. The maker cites evidence for each criterion; a verifier who is not the maker grades it.</div>}
      {rounds.map((r) => {
        const verifierId = r.verifier.startsWith('agent:') ? r.verifier.slice(6) : null;
        const who = verifierId ? names.get(verifierId)?.name ?? 'a member' : r.verifier === 'check' ? 'its checks' : r.verifier ? 'a person' : '';
        const rows = criterionRows(r);
        const expanded = isOpen(r.id);
        return (
          <div key={r.id} className="qx-round" data-testid="qc-round">
            <button className="qx-round-head" onClick={() => toggle(r.id)} aria-expanded={expanded}>
              <Pill tone={OUTCOME_TONE[r.outcome]}>{r.kind === 'spot_check' ? 'spot check' : `round ${r.round + 1}`}: {OUTCOME_LABEL[r.outcome]}</Pill>
              {r.score !== null && <span className="co-num"><b>{r.score}</b>/5</span>}
              {who && <span className="co-faint">by {who}{INDEPENDENCE_LABEL[r.independence] && verifierId ? ` (${INDEPENDENCE_LABEL[r.independence]})` : ''}</span>}
              <span className="co-faint" style={{ marginLeft: 'auto' }}>{ago(r.decidedAt ?? r.createdAt)}</span>
              <Chev />
            </button>
            {r.escapedAt && <div className="qx-warnline" style={{ color: 'var(--red-text)', marginTop: 4 }}>Came back: {r.escapeReason}</div>}
            {expanded && (
              <div style={{ marginTop: 4 }}>
                <div className="qx-crit">
                  {rows.map((c) => (
                    <div key={c.id} className="qx-crit-row">
                      <span className={`qx-score${c.score === null ? ' none' : c.below ? ' bad' : c.score >= 4 ? ' ok' : ''}`} title={c.min ? `must score at least ${c.min}` : undefined}>{c.score !== null ? c.score : '—'}</span>
                      <span className="qx-crit-text">{c.text}
                        {c.note && <span className="qx-crit-note">{c.note}</span>}
                        {c.refs.length > 0 && <span className="qx-crit-refs">{c.refs.slice(0, 4).map((x) => <EvidenceLink key={x} raw={x} />)}</span>}
                      </span>
                    </div>
                  ))}
                </div>
                {r.checks.filter((c) => !c.ok).map((c) => <div key={c.name} className="qx-warnline">Check failed — {c.name}: {c.detail}</div>)}
                {r.note && r.outcome !== 'pass' && <div className="qx-meta" style={{ marginTop: 4 }}>{r.note.slice(0, 400)}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
