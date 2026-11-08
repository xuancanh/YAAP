/** Quality control on screen (docs/quality.md §8): the Oversight › Quality
 *  page — the quality figures (first-pass yield, rework, escapes, policy
 *  conformance), the standards with their criteria (adopt a template,
 *  retire), the policies with their rules and violations, who needs
 *  coaching, and the latest QC results — and the task's QC panel: each
 *  review round with its criteria, scores, notes and evidence links. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgDetail, type OrgPolicy, type OrgTask, type QcResult, type QualityOverview, type QualityStandard } from '../lib/api';
import {
  criterionRows, ENFORCEMENT_TONE, evidenceTarget, INDEPENDENCE_LABEL, makersByYield, OUTCOME_LABEL, OUTCOME_TONE, pct, qcRounds, qualityLede, ruleLines,
  scopeLabel, violationsByPolicy,
} from '../lib/quality';
import { openFileInPanel } from '../lib/file-links';
import { ago, faint, input, linkBtn, useAgentNames, useUnits, Avatar } from './org-ui';
import { useOrgRole } from './OrgSensingView';
import { Card, Empty, Metric, PageHeader, Pill, SkeletonRows } from './CompanyKit';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 240) : 'failed');
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5, minWidth: 0, flexWrap: 'wrap' };

/** One evidence reference: a file opens in the side panel, a page in a new tab. */
export function EvidenceLink({ raw }: { raw: string }) {
  const t = evidenceTarget(raw);
  if (t.kind === 'file') return <button style={{ ...linkBtn, fontSize: 12 }} onClick={() => openFileInPanel(t.path)} title={`Open /${t.path}`}>/{t.path}</button>;
  if (t.kind === 'url') return <a href={t.href} target="_blank" rel="noreferrer noopener" style={{ fontSize: 12, color: 'var(--accent-hi)', wordBreak: 'break-all' }}>{t.href}</a>;
  return <code style={{ fontSize: 11.5 }}>{raw}</code>;
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
  const refresh = useCallback(async () => { setQ(await api.orgQuality(wsId).catch(() => null)); }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); app.showToast(done); await refresh(); } catch (e) { app.showToast(errText(e)); } finally { setBusy(false); }
  };
  const byPolicy = useMemo(() => violationsByPolicy(q?.violations ?? []), [q]);
  const live = (q?.standards ?? []).filter((s) => s.status === 'active' || s.status === 'proposed');
  const adoptable = (q?.templates ?? []).filter((t) => !(q?.standards ?? []).some((s) => s.source === `template:${t.id}` && (s.status === 'active' || s.status === 'proposed')));
  const o = q?.metrics.overall;
  return (
    <div className="co-page" data-testid="quality-page">
      <PageHeader title="Quality"
        purpose="Whether finished work meets the bar, and whether anyone broke a rule on the way. Standards say what a deliverable must meet (criteria graded 1–5 by a verifier who is not the maker, with evidence the platform checks). Policies are rules as data, checked before tool calls and at review. Escapes are accepted work that came back."
        actions={decider ? <button className="co-btn small" disabled={busy} onClick={() => void act(() => api.runQualitySpotCheck(wsId), 'Spot checks run')}>Run spot checks</button> : undefined} />
      {q === undefined && <SkeletonRows rows={4} label="Loading quality" />}
      {q === null && <div className="co-alert" role="alert">Quality did not load.</div>}
      {q && o && Array.isArray(q.standards) && (
        <>
          <p data-testid="quality-lede" style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{qualityLede(q)}</p>
          <div className="co-metrics" style={{ margin: '0 0 14px' }} data-testid="quality-metrics">
            <Metric n={pct(o.firstPassYield)} label="first-pass yield" title="Tasks accepted at their first review" tone={o.firstPassYield !== null && o.firstPassYield < 0.6 ? 'warn' : undefined} />
            <Metric n={pct(o.reworkRate)} label="needed rework" title="Tasks sent back at least once" />
            <Metric n={o.escapes} label="escapes" title="Accepted work later reopened, tied to an incident, or failing a spot check" tone={o.escapes ? 'bad' : undefined} />
            <Metric n={o.spotChecks} label="spot checks" title={`${o.spotCheckFails} failed`} />
            <Metric n={q.metrics.policies.violations} label="violations" tone={q.metrics.policies.violations ? 'warn' : undefined} />
            <Metric n={pct(q.metrics.policies.resultConformance)} label="result policy conformance" />
          </div>
          <div className="co-grid">
            <Card id="quality-standards" title="Standards" span
              aside={decider && adoptable.length ? (
                <select aria-label="Adopt a template" value="" disabled={busy} style={{ ...input, width: 'auto', fontSize: 12, padding: '4px 8px' }} onChange={(e) => { const id = e.target.value; if (id) void act(() => api.createQualityStandard(wsId, { template: id }), 'Standard adopted'); }}>
                  <option value="">Adopt a template…</option>
                  {adoptable.map((t) => <option key={t.id} value={t.id}>{t.name}{t.deliverable ? ` (${t.deliverable})` : ' (company default)'}</option>)}
                </select>
              ) : undefined}>
              {live.length === 0 && <Empty compact title="No standards yet">Work is accepted on its done_when alone. Adopt a template, or ask the chief of staff to write the standards your deliverables need.</Empty>}
              {live.map((s) => <StandardRow key={s.id} s={s} unitName={unitName} decider={decider} onRetire={() => void act(() => api.reviseQualityStandard(wsId, s.id, { action: 'retire' }), `Retired ${s.name}`)} figures={q.metrics.byStandard[s.id]} />)}
            </Card>
            <Card id="quality-policies" title="Policies" span>
              {q.policies.filter((p) => p.status !== 'retired' && p.status !== 'rejected').length === 0 && <Empty compact title="No policies yet">Standing rules live as prose. The chief of staff turns them into policies the platform checks (a price floor, a required disclaimer, no send without a draft).</Empty>}
              {q.policies.filter((p) => p.status !== 'retired' && p.status !== 'rejected').map((p) => (
                <PolicyRow key={p.id} p={p} violations={byPolicy.get(p.id) ?? []} names={names} decider={decider} onRetire={() => void act(() => api.reviseOrgPolicy(wsId, p.id, { action: 'retire' }), `Retired ${p.key}`)} openTask={(id) => app.openOrgTask(id)} />
              ))}
            </Card>
            <Card id="quality-members" title="By member">
              {makersByYield(q).length === 0 && <Empty compact title="Nothing graded yet" />}
              {makersByYield(q).slice(0, 10).map((m) => (
                <div key={m.agentId} style={row}>
                  <Avatar a={names.get(m.agentId)} size={16} />
                  <span style={{ flex: 1, minWidth: 100 }}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</span>
                  <span style={faint} title="first-pass yield">{pct(m.firstPassYield)} first time</span>
                  <span style={faint}>{m.tasks} task{m.tasks === 1 ? '' : 's'}</span>
                  {m.escapes > 0 && <Pill tone="bad">{m.escapes} escape{m.escapes === 1 ? '' : 's'}</Pill>}
                </div>
              ))}
            </Card>
            <Card id="quality-results" title="Latest QC results">
              {q.recent.length === 0 && <Empty compact title="No QC results yet" />}
              {q.recent.slice(0, 12).map((r) => (
                <button key={r.id} onClick={() => app.openOrgTask(r.taskId)} style={{ ...row, width: '100%', background: 'none', border: 'none', borderTop: '1px solid var(--border-soft)', color: 'var(--text)', font: 'inherit', fontSize: 12.5, textAlign: 'left', cursor: 'pointer' }}>
                  <Pill tone={OUTCOME_TONE[r.outcome]}>{r.kind === 'spot_check' ? `spot check ${OUTCOME_LABEL[r.outcome]}` : OUTCOME_LABEL[r.outcome]}</Pill>
                  <span style={{ flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.taskKey ? `${r.taskKey} ` : ''}{r.taskTitle}</span>
                  {r.score !== null && <span style={faint}>{r.score}/5</span>}
                  {r.escapedAt && <Pill tone="bad" title={r.escapeReason}>escaped</Pill>}
                  <span style={faint}>{ago(r.decidedAt ?? r.createdAt)}</span>
                </button>
              ))}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function StandardRow({ s, unitName, decider, onRetire, figures }: { s: QualityStandard; unitName: (id: string) => string | undefined; decider: boolean; onRetire: () => void; figures?: QualityOverview['metrics']['overall'] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 0' }} data-testid="quality-standard">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={{ ...linkBtn, fontWeight: 600, fontSize: 13 }} onClick={() => setOpen(!open)} aria-expanded={open}>{s.name}</button>
        <span style={faint}>v{s.version} · {scopeLabel(s, unitName)} · pass at {s.passScore}/5{s.verifier === 'family' ? ' · another model family verifies' : ''}</span>
        {s.status === 'proposed' && <Pill tone="warn">waiting on your decision</Pill>}
        {s.pending && <Pill tone="warn" title="The current version stays until the card is decided">revision proposed</Pill>}
        {figures && <span style={{ ...faint, marginLeft: 'auto' }}>{pct(figures.firstPassYield)} first time · {figures.tasks} task{figures.tasks === 1 ? '' : 's'}</span>}
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          {s.summary && <div style={{ fontSize: 12.5, marginBottom: 4 }}>{s.summary}</div>}
          {s.criteria.map((c) => (
            <div key={c.id} style={{ ...row, borderTop: 'none', padding: '2px 0' }}>
              <code style={{ fontSize: 11.5 }}>{c.id}</code>
              <span style={{ flex: 1, minWidth: 160 }}>{c.text}</span>
              <span style={faint}>weight {c.weight}{c.min ? ` · min ${c.min}` : ''}{c.evidence?.length ? ` · ${c.evidence.includes('none') ? 'judged' : `evidence: ${c.evidence.join(', ')}`}` : ''}</span>
            </div>
          ))}
          {decider && s.status === 'active' && <button className="co-btn ghost small" style={{ marginTop: 6 }} onClick={onRetire}>Retire</button>}
        </div>
      )}
    </div>
  );
}

function PolicyRow({ p, violations, names, decider, onRetire, openTask }: { p: OrgPolicy; violations: QualityOverview['violations']; names: ReturnType<typeof useAgentNames>; decider: boolean; onRetire: () => void; openTask: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 0' }} data-testid="quality-policy">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill tone={ENFORCEMENT_TONE[p.enforcement]}>{p.enforcement}</Pill>
        <button style={{ ...linkBtn, fontWeight: 600, fontSize: 13, textAlign: 'left' }} onClick={() => setOpen(!open)} aria-expanded={open}>{p.statement}</button>
        <span style={faint}>{p.key} v{p.version} · {p.severity}{p.scopeKind !== 'company' ? ` · ${p.scopeKind.replace('_', ' ')} ${p.scopeRef}` : ''}</span>
        {p.status === 'proposed' && <Pill tone="warn">waiting on your decision</Pill>}
        {violations.length > 0 && <span style={{ ...faint, marginLeft: 'auto', color: 'var(--amber)' }}>{violations.length} violation{violations.length === 1 ? '' : 's'}</span>}
      </div>
      {open && (
        <div style={{ marginTop: 6, fontSize: 12.5 }}>
          {ruleLines(p).map((l, i) => <div key={i} style={faint}>{l}</div>)}
          {p.remediation && <div style={{ marginTop: 4 }}>Instead: {p.remediation}</div>}
          {p.rationale && <div style={{ ...faint, marginTop: 2 }}>Why: {p.rationale}</div>}
          {violations.slice(0, 8).map((v) => (
            <div key={v.id} style={row}>
              <Pill tone={v.outcome === 'blocked' ? 'bad' : v.outcome === 'warned' ? 'warn' : undefined}>{v.outcome}</Pill>
              <span>{names.get(v.agentId)?.name ?? (v.agentId.slice(0, 8) || 'someone')}</span>
              <span style={{ flex: 1, minWidth: 140, ...faint }}>{v.tool || (v.taskId ? 'a deliverable' : v.stage)}: {v.detail.slice(0, 160)}</span>
              {v.taskId && <button style={linkBtn} onClick={() => openTask(v.taskId!)}>task</button>}
              {v.status !== 'open' && <span style={faint}>{v.status.replace('_', ' ')}</span>}
              <span style={faint}>{ago(v.createdAt)}</span>
            </div>
          ))}
          {decider && p.status === 'active' && <button className="co-btn ghost small" style={{ marginTop: 6 }} onClick={onRetire}>Retire</button>}
        </div>
      )}
    </div>
  );
}

/** The task's QC panel: the standard it is held to and each round's grade. */
export function TaskQcPanel({ wsId, task }: { wsId: string; task: OrgTask }) {
  const names = useAgentNames();
  const [data, setData] = useState<{ standard: QualityStandard | null; results: QcResult[] } | null>(null);
  useEffect(() => { let live = true; void api.orgTaskQuality(wsId, task.id).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); }); return () => { live = false; }; }, [wsId, task.id, task.status, task.reviewRounds]);
  if (!data || !Array.isArray(data.results) || (!data.standard && data.results.length === 0)) return null;
  const rounds = qcRounds(data.results);
  return (
    <div data-testid="task-qc" style={{ border: '1px solid var(--border-soft)', borderRadius: 10, padding: '8px 10px', marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
        <b style={{ fontSize: 12.5 }}>Quality</b>
        {data.standard ? <span style={faint}>{data.standard.name} v{data.standard.version} · pass at {data.standard.passScore}/5</span> : <span style={faint}>no standard — accepted on its done_when</span>}
      </div>
      {rounds.length === 0 && <div style={faint}>Not submitted yet. The maker cites evidence for each criterion; a verifier who is not the maker grades it.</div>}
      {rounds.map((r) => {
        const verifierId = r.verifier.startsWith('agent:') ? r.verifier.slice(6) : null;
        const rows = criterionRows(r);
        return (
          <div key={r.id} style={{ borderTop: '1px solid var(--border-soft)', padding: '6px 0' }} data-testid="qc-round">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
              <Pill tone={OUTCOME_TONE[r.outcome]}>{r.kind === 'spot_check' ? 'spot check' : `round ${r.round + 1}`}: {OUTCOME_LABEL[r.outcome]}</Pill>
              {r.score !== null && <span><b>{r.score}</b>/5</span>}
              {verifierId && <span style={faint}>by {names.get(verifierId)?.name ?? verifierId.slice(0, 8)}{INDEPENDENCE_LABEL[r.independence] ? ` (${INDEPENDENCE_LABEL[r.independence]})` : ''}</span>}
              {!verifierId && r.verifier && <span style={faint}>by {r.verifier === 'check' ? 'its checks' : 'a person'}</span>}
              {r.escapedAt && <Pill tone="bad" title={r.escapeReason}>came back: {r.escapeReason.slice(0, 60)}</Pill>}
              <span style={{ ...faint, marginLeft: 'auto' }}>{ago(r.decidedAt ?? r.createdAt)}</span>
            </div>
            {rows.map((c) => (
              <div key={c.id} style={{ ...row, borderTop: 'none', padding: '3px 0 3px 8px' }}>
                <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 28, fontWeight: 600, color: c.below ? 'var(--red)' : undefined }}>{c.score !== null ? `${c.score}/5` : '—'}</span>
                <span style={{ flex: 1, minWidth: 160 }}>{c.text}{c.note ? <span style={faint}> — {c.note}</span> : null}</span>
                {c.refs.length > 0 && <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{c.refs.slice(0, 4).map((x) => <EvidenceLink key={x} raw={x} />)}</span>}
              </div>
            ))}
            {r.checks.filter((c) => !c.ok).map((c) => <div key={c.name} style={{ ...faint, color: 'var(--amber)' }}>{c.name}: {c.detail}</div>)}
            {r.note && r.outcome !== 'pass' && <div style={{ ...faint, marginTop: 2 }}>{r.note.slice(0, 400)}</div>}
          </div>
        );
      })}
    </div>
  );
}
