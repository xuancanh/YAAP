/** The Pulse page (docs/company-vision.md §5, §8; execution plan item 20):
 *  one screen for ten minutes a day — the pulse score with its 30-day
 *  sparkline, the three SLOs against their targets, open signals grouped by
 *  severity with ack / resolve and a deep link to the task, goal or member
 *  they name, the latest audits with "Run audit now", spend against the
 *  envelope, and today's rituals. Plain SVG, no chart library (the same
 *  approach as UsageChart). */
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useApp } from '../store';
import { api, type AuditFinding, type OrgAuditRun, type OrgDetail, type OrgMeeting, type OrgPulse, type OrgSignal, type OrgSpend } from '../lib/api';
import { I, P } from '../lib/icons';
import { safeJsonParse } from '../lib/util';
import { fmtUsd } from '../lib/pricing';
import { firesOn, groupSignals, humanCron, MEETING_KIND_TITLES, scoreColor, SEVERITY_COLOR, signalKindLabel, sloTiles, sparkPath } from '../lib/org';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useUnits, Avatar } from './org-ui';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
/** Health and audit independence (item 29, SPA item 32). */
const HealthStrip = lazy(() => import('./OrgIncidentsView').then((m) => ({ default: m.HealthStrip })));
const AssuranceCard = lazy(() => import('./OrgIncidentsView').then((m) => ({ default: m.AssuranceCard })));

export function PulsePane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const [pulse, setPulse] = useState<OrgPulse | null>(null);
  const [signals, setSignals] = useState<OrgSignal[]>([]);
  const [audits, setAudits] = useState<OrgAuditRun[]>([]);
  const [spend, setSpend] = useState<OrgSpend | null>(null);
  const [meetings, setMeetings] = useState<OrgMeeting[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [p, s, a, sp, m] = await Promise.all([
      api.orgPulse(wsId).then((v) => { setErr(null); return v; }).catch((e) => { setErr(e instanceof Error ? e.message.slice(0, 160) : 'pulse unavailable'); return null; }),
      api.orgSignals(wsId).catch((): OrgSignal[] => []),
      api.orgAudits(wsId, 10).catch((): OrgAuditRun[] => []),
      api.orgSpend(wsId).catch(() => null),
      api.orgMeetings(wsId).catch((): OrgMeeting[] => []),
    ]);
    setPulse(p); setSignals(s); setAudits(a); setSpend(sp); setMeetings(m);
  }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); void app.refreshWsOrg(); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  };
  const open = signals.filter((s) => s.status !== 'resolved');
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Pulse</h2>
          <div style={faint}>Signals, SLOs, spend versus plan and today's rituals on one screen. The score is four weighted quarters (cycle time, first-review acceptance, decision latency, health) minus a penalty per open critical signal; weights and targets are tunables.</div>
        </div>
        <button style={btn()} onClick={() => void act(() => api.runOrgAudit(wsId).then((r) => { if (r.result !== 'done' && r.result !== 'ran') throw new Error(`Audit ${r.result}`); }), 'Audit ran — findings are signals')} title="Run the auditor now (needs an auditor member; capped by auditUsdCap)">Run audit now</button>
      </div>
      {err && <div style={{ ...card, color: 'var(--red)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}
      <Suspense fallback={null}><HealthStrip health={app.orgHealth} onOpenIncidents={() => app.setOrgPane('incidents')} /></Suspense>
      {app.orgPendingPlans > 0 && (
        <div role="status" style={{ ...card, borderLeft: '3px solid var(--amber)', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}><b>{app.orgPendingPlans} plan{app.orgPendingPlans === 1 ? '' : 's'}</b> awaiting your veto — the chief's structural changes apply when the window closes unless you stop them.</span>
          <button style={{ ...btn(true), marginLeft: 'auto' }} onClick={() => app.setOrgPane('plans')}>Review plans</button>
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 10 }}>
        <ScoreTile pulse={pulse} openCritical={open.filter((s) => s.severity === 'critical').length} />
        <SpendTile spend={spend} org={org} />
        <RitualsTile meetings={meetings} onOpen={(m) => openMeeting(app, m)} />
      </div>
      {pulse && <SloRow pulse={pulse} />}
      <SignalsCard signals={open} onAck={(s, note) => act(() => api.ackOrgSignal(wsId, s.id, note), 'Signal acknowledged')} onResolve={(s) => act(() => api.resolveOrgSignal(wsId, s.id), 'Signal resolved')} />
      <AuditsCard audits={audits} />
      <Suspense fallback={null}><AssuranceCard org={org} audits={audits} onChanged={refresh} /></Suspense>
    </div>
  );
}

/** Open the thread a meeting is (the unit channel), when it has one. */
function openMeeting(app: ReturnType<typeof useApp>, m: OrgMeeting): void {
  const ch = app.channels.find((c) => c.id === m.channelId);
  if (ch && m.threadRootId) app.openChannel(ch.slug, m.threadRootId);
  else if (ch) app.openChannel(ch.slug);
  else app.showToast('This meeting has no channel thread');
}

function ScoreTile({ pulse, openCritical }: { pulse: OrgPulse | null; openCritical: number }) {
  const series = pulse?.series ?? [];
  const path = sparkPath(series.map((d) => d.score), 100, 28);
  const color = scoreColor(pulse?.score ?? null);
  const first = series.find((d) => d.score !== null);
  const delta = pulse && first && first.score !== null ? pulse.score - first.score : null;
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={label}>Pulse score · 30 days</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 34, fontWeight: 700, lineHeight: 1, color, ...mono }}>{pulse ? Math.round(pulse.score) : '—'}</span>
        <span style={faint}>/ 100{delta !== null ? ` · ${delta >= 0 ? '+' : ''}${Math.round(delta)} over the window` : ''}</span>
      </div>
      <svg viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="Pulse score over the last 30 days" style={{ width: '100%', height: 36, display: 'block' }}>
        <line x1={0} x2={100} y1={27.5} y2={27.5} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {path && <path d={path} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...faint, ...mono, fontSize: 10 }}>
        <span>{series[0]?.day.slice(5) ?? ''}</span>
        <span>{pulse ? `${pulse.breaches.length} SLO breach(es) · ${openCritical} critical open` : 'no sample yet'}</span>
        <span>{series.at(-1)?.day.slice(5) ?? ''}</span>
      </div>
    </div>
  );
}

function SloRow({ pulse }: { pulse: OrgPulse }) {
  const tiles = sloTiles(pulse.today, pulse.targets);
  const t = pulse.today;
  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', marginBottom: 10 }}>
      {tiles.map((s) => (
        <div key={s.key} style={{ ...card, padding: '10px 12px', borderLeft: `3px solid ${s.met === null ? 'var(--border)' : s.met ? 'var(--green)' : 'var(--red)'}` }} title={pulse.breaches.find((b) => b.metric === s.key)?.detail}>
          <div style={label}>{s.label}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 20, fontWeight: 700, ...mono }}>{s.value === null ? '—' : `${Math.round(s.value * 10) / 10}${s.unit}`}</span>
            <span style={faint}>target {s.key === 'firstReviewAcceptancePct' ? '≥' : '≤'} {s.target}{s.unit}</span>
          </div>
        </div>
      ))}
      <div style={{ ...card, padding: '10px 12px' }}>
        <div style={label}>Health · {t.windowDays}d window</div>
        <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
          <div>goals owned <b style={mono}>{t.goalsOwnedPct === null ? '—' : `${Math.round(t.goalsOwnedPct)}%`}</b> · at risk <b style={mono}>{t.goalsAtRiskPct === null ? '—' : `${Math.round(t.goalsAtRiskPct)}%`}</b></div>
          <div>spend vs envelope <b style={mono}>{t.spendVsEnvelopePct === null ? '—' : `${Math.round(t.spendVsEnvelopePct)}%`}</b> · {t.acceptedTasks} accepted · {t.runs} runs</div>
          <div>cost per accepted task <b style={mono}>{t.costPerAcceptedTaskUsd === null ? '—' : fmtUsd(t.costPerAcceptedTaskUsd)}</b></div>
        </div>
      </div>
    </div>
  );
}

function SpendTile({ spend, org }: { spend: OrgSpend | null; org: OrgDetail }) {
  const app = useApp();
  if (!spend) return <div style={{ ...card, ...faint }}>Spend: loading…</div>;
  const c = spend.company;
  const used = c.usd + c.reservedUsd;
  const pct = c.monthlyUsd > 0 ? Math.min(100, Math.round((used / c.monthlyUsd) * 100)) : null;
  // Linear projection to month end from the days elapsed.
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projected = dayOfMonth > 0 ? (c.usd / dayOfMonth) * daysInMonth : c.usd;
  const projPct = c.monthlyUsd > 0 ? Math.round((projected / c.monthlyUsd) * 100) : null;
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><div style={{ ...label, flex: 1 }}>Spend vs envelope · {spend.month}</div><button style={linkBtn} onClick={() => app.setOrgPane('capital')} title="Cost per outcome, forecast, allocations, routing">capital</button><button style={linkBtn} onClick={() => app.setOrgPane('spend')}>details</button></div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 700, ...mono }}>{fmtUsd(c.usd)}</span>
        <span style={faint}>{c.monthlyUsd > 0 ? `of ${fmtUsd(c.monthlyUsd)}` : 'no company envelope'}{c.reservedUsd > 0 ? ` · ${fmtUsd(c.reservedUsd)} reserved` : ''}</span>
      </div>
      {pct !== null && <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Spend against the company envelope"><div style={{ width: `${pct}%`, height: 6, background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)' }} /></div>}
      <div style={faint}>
        {projPct !== null ? <span style={{ color: projPct >= 120 ? 'var(--red)' : projPct >= 100 ? 'var(--amber)' : undefined }}>projected {fmtUsd(projected)} at month end ({projPct}%)</span> : `${c.runs} run(s) this month`}
        {spend.costPerAcceptedTask !== null && <> · {fmtUsd(spend.costPerAcceptedTask)} per accepted task</>}
        {org.monthlyBudgetUsd > 0 && c.monthlyUsd === 0 && <> · envelope {fmtUsd(org.monthlyBudgetUsd)}</>}
      </div>
    </div>
  );
}

/** Today's rituals: cadences whose cron fires today (with their state) and
 *  the meetings held or running today. */
function RitualsTile({ meetings, onOpen }: { meetings: OrgMeeting[]; onOpen: (m: OrgMeeting) => void }) {
  const app = useApp();
  const { byId } = useUnits();
  const today = new Date().toISOString().slice(0, 10);
  const todays = useMemo(() => app.orgCadences.filter((c) => c.enabled === 1 && firesOn(c.cron)), [app.orgCadences]);
  const held = meetings.filter((m) => (m.startedAt ?? m.createdAt).slice(0, 10) === today && m.status !== 'cancelled');
  const unitName = (id: string | null) => { const u = id ? byId.get(id) : null; return u ? (u.parentUnitId === null ? 'Company' : u.name) : 'Company'; };
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><div style={{ ...label, flex: 1 }}>Today's rituals</div><button style={linkBtn} onClick={() => app.setOrgPane('meetings')}>calendar</button></div>
      {todays.length === 0 && held.length === 0 && <div style={faint}>No ritual fires today.</div>}
      {held.map((m) => (
        <button key={m.id} onClick={() => onOpen(m)} style={{ ...linkBtn, textAlign: 'left', display: 'flex', gap: 6, alignItems: 'center', fontWeight: 500, color: 'var(--text)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.status === 'running' ? 'var(--green)' : m.status === 'done' ? 'var(--text-faint)' : 'var(--amber)', flex: 'none' }} />
          <span style={{ flex: 1 }}>{m.title || MEETING_KIND_TITLES[m.kind]} · {unitName(m.unitId)}</span>
          <span style={pill()}>{m.status}</span>
        </button>
      ))}
      {todays.filter((c) => !held.some((m) => m.unitId === c.unitId && m.kind === c.kind)).map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--border)', flex: 'none' }} />
          <span style={{ flex: 1 }}>{MEETING_KIND_TITLES[c.kind] ?? c.kind} · {unitName(c.unitId)}</span>
          <span style={faint}>{humanCron(c.cron).replace(/^.* at /, 'at ')}</span>
        </div>
      ))}
    </div>
  );
}

/** Open signals grouped by severity; each row deep-links to what it names. */
function SignalsCard({ signals, onAck, onResolve }: { signals: OrgSignal[]; onAck: (s: OrgSignal, note: string) => Promise<void>; onResolve: (s: OrgSignal) => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const { byId } = useUnits();
  const [ack, setAck] = useState<{ id: string; note: string } | null>(null);
  const groups = groupSignals(signals);
  const follow = (s: OrgSignal) => {
    // Outcomes are mirrored to /org/outcomes.md (docs/filesystem.md).
    if (s.kind === 'no_outcome') app.openFile({ kind: 'workspace', id: app.workspaceId }, app.fileList.some((f) => f.path === 'org/outcomes.md') ? 'org/outcomes.md' : null);
    else if (s.refType === 'task') app.openOrgTask(s.refId);
    else if (s.refType === 'goal') { app.setOrgFocus({ kind: 'goal', id: s.refId }); app.setOrgUnitId(null); app.setOrgPane('vision'); }
    else if (s.refType === 'agent' || s.refType === 'member') app.openAgent(s.refId);
    else if (s.refType === 'unit') { const u = byId.get(s.refId); if (u) { app.setOrgUnitId(u.parentUnitId === null ? null : u.id); app.setOrgPane('board'); } }
    else if (s.refType === 'meeting') app.setOrgPane('meetings');
    else if (s.refType === 'slo' || s.refType === 'audit') app.setOrgPane('audit');
  };
  const linkable = (s: OrgSignal) => Boolean(s.refId) && ['task', 'goal', 'agent', 'member', 'unit', 'meeting'].includes(s.refType);
  return (
    <div style={{ ...card, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Signals</div>
        <span style={faint}>{signals.length} open · each fires once a day, stays while the condition holds, resolves itself when it clears</span>
      </div>
      {groups.length === 0 && <div style={faint}>Nothing open. The sweep runs every five minutes without a model.</div>}
      {groups.map((g) => (
        <div key={g.severity} style={{ marginTop: 6 }}>
          <div style={{ ...label, color: SEVERITY_COLOR[g.severity], display: 'flex', gap: 6, alignItems: 'center' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLOR[g.severity] }} />{g.severity} · {g.rows.length}</div>
          {g.rows.map((s) => {
            const addressee = s.addresseeKind === 'ceo' ? 'you' : names.get(s.addresseeId)?.name ?? s.addresseeKind;
            const unit = s.unitId ? byId.get(s.unitId) : null;
            return (
              <div key={s.id} style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border-soft)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {linkable(s) ? <button onClick={() => follow(s)} style={{ ...linkBtn, fontSize: 13, color: 'var(--text)', textAlign: 'left' }} title={`Open the ${s.refType}`}>{s.title}</button> : <span>{s.title}</span>}
                    <span style={pill()}>{signalKindLabel(s.kind)}</span>
                    {s.status === 'acked' && <span style={pill('var(--accent-dim)', 'var(--text)')} title={s.ackNote || 'acknowledged'}>acked</span>}
                  </div>
                  {s.detail && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{s.detail}</div>}
                  <div style={{ ...faint, marginTop: 2 }}>to {addressee}{unit ? ` · ${unit.parentUnitId === null ? 'company' : unit.name}` : ''} · {ago(s.createdAt)}{s.refType && s.refId ? <> · <span style={mono}>{s.refType}:{s.refId.slice(0, 8)}</span></> : null}</div>
                  {ack?.id === s.id && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <input autoFocus value={ack.note} onChange={(e) => setAck({ id: s.id, note: e.target.value })} placeholder="Note (optional)" style={input} onKeyDown={(e) => { if (e.key === 'Enter') { void onAck(s, ack.note); setAck(null); } if (e.key === 'Escape') setAck(null); }} />
                      <button style={btn(true)} onClick={() => { void onAck(s, ack.note); setAck(null); }}>Ack</button>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 5, flex: 'none' }}>
                  {s.status === 'open' && <button style={btn()} onClick={() => setAck(ack?.id === s.id ? null : { id: s.id, note: '' })} title="Acknowledge: you saw it; it stays until the condition clears">Ack</button>}
                  <button style={btn()} onClick={() => void onResolve(s)} title="Resolve by hand; it re-opens tomorrow if the condition still holds">Resolve</button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function AuditsCard({ audits }: { audits: OrgAuditRun[] }) {
  const names = useAgentNames();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>Audits</div>
        <span style={faint}>the auditor samples accepted tasks, scope and spend rows and charter drift on a cadence; findings become signals</span>
      </div>
      {audits.length === 0 && <div style={faint}>No audit yet. Hire from the Auditor pack (or name <code>auditorAgentId</code>) and run one.</div>}
      {audits.map((a) => {
        const findings = safeJsonParse<AuditFinding[]>(a.findings, []);
        const sampled = safeJsonParse<Record<string, unknown>>(a.sampled, {});
        const auditor = names.get(a.auditorAgentId);
        const color = a.status === 'done' ? 'var(--green)' : a.status === 'running' ? 'var(--amber)' : 'var(--red)';
        return (
          <div key={a.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--border-soft)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
              <Avatar a={auditor} size={18} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{auditor?.name ?? 'auditor'}</span>
              <span style={pill()}>{a.trigger}</span>
              <span style={pill()}>{a.status.replace('_', ' ')}</span>
              {a.singleModel === 1 && <span style={pill('var(--amber)', '#fff')} title="No model family other than the workers' was available">single-model audit</span>}
              <span style={faint}>{ago(a.startedAt)} · {findings.length} finding(s) · {fmtUsd(a.usd)}{a.model ? ` · ${a.model}` : ''}{typeof sampled.tasks === 'number' ? ` · ${sampled.tasks} task(s) sampled` : ''}</span>
              <span style={{ flex: 1 }} />
              {(a.summary || findings.length > 0) && <button style={linkBtn} onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'hide' : 'report'}</button>}
            </div>
            {open === a.id && (
              <div style={{ marginTop: 6, paddingLeft: 15 }}>
                {a.summary && <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{a.summary}</div>}
                {findings.map((f, i) => (
                  <div key={i} style={{ fontSize: 12, display: 'flex', gap: 6, marginTop: 4, alignItems: 'flex-start' }}>
                    <span style={{ ...pill(SEVERITY_COLOR[f.severity as keyof typeof SEVERITY_COLOR] ?? 'var(--panel-2)', '#fff'), flex: 'none' }}>{f.severity}</span>
                    <span><b>{f.title}</b>{f.detail ? ` — ${f.detail}` : ''} <span style={{ ...faint, ...mono }}>{f.refType}:{f.refId.slice(0, 8)}</span></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ ...faint, marginTop: 6, display: 'flex', alignItems: 'center', gap: 5 }}><I d={P.shield} size={12} />The auditor runs read-only on a different model family when one is available.</div>
    </div>
  );
}
