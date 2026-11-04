/** Incidents, health and audit independence on screen (docs/incidents.md,
 *  execution-plan item 29; SPA item 32): the Incidents pane (open first by
 *  severity with what was contained, then resolved; a drawer with the
 *  timeline — detection, containment steps and their results, the
 *  postmortem, the resolution — "Contain more" and "Resolve" with "undo
 *  containment"), the owner's report form, the health strip (degraded
 *  providers and connections, frozen classes) and the Pulse's assurance card
 *  (auditor precision / recall from spot checks, rotation, the spot-check
 *  cards, the last red-team run and "Run red-team now"). */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type IncidentSeverity, type ManualContainment, type OrgAuditRun, type OrgDetail, type OrgHealth, type OrgIncident } from '../lib/api';
import {
  ACTION_CLASSES, auditorQuality, CLASS_LABEL, containedNow, healthStrip, incidentCounts, incidentLine, INCIDENT_KIND_LABEL, INCIDENT_SEVERITY_COLOR, incidentTimeline, lastRedTeam, MANUAL_CONTAINMENT_LABEL, pendingSpotChecks, sortIncidents,
} from '../lib/org3';
import { I, P } from '../lib/icons';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useFollowRef, Avatar, Drawer } from './org-ui';
import { useOrgRole } from './OrgSensingView';

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^\d{3} /, '').slice(0, 200) : 'failed');
const TONE: Record<string, string> = { red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)' };

/** What is degraded right now, one chip each (Pulse, Incidents). */
export function HealthStrip({ health, onOpenIncidents }: { health: OrgHealth | null; onOpenIncidents?: () => void }) {
  const items = healthStrip(health);
  const counts = incidentCounts(health?.openIncidents);
  const open = counts.open + counts.contained;
  if (!health || (items.length === 0 && open === 0)) return null;
  return (
    <div role="status" aria-label="Organization health" style={{ ...card, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, borderLeft: `3px solid ${health.status === 'incident' ? 'var(--red)' : 'var(--amber)'}` }}>
      <I d={P.warn} size={14} stroke={health.status === 'incident' ? 'var(--red)' : 'var(--amber)'} />
      <b style={{ fontSize: 12.5 }}>{health.status === 'incident' ? 'Incident' : 'Degraded'}</b>
      {items.map((x, i) => <span key={i} title={x.title} style={{ ...pill('var(--panel-2)', TONE[x.tone]), borderColor: TONE[x.tone] }}>{x.text}</span>)}
      {open > 0 && (onOpenIncidents ? <button style={{ ...linkBtn, marginLeft: 'auto' }} onClick={onOpenIncidents}>{incidentLine(counts)} →</button> : <span style={{ ...faint, marginLeft: 'auto' }}>{incidentLine(counts)}</span>)}
    </div>
  );
}

export function IncidentsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const role = useOrgRole(wsId);
  const decider = role === 'ceo' || role === 'board';
  const names = useAgentNames();
  const [list, setList] = useState<OrgIncident[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const refresh = useCallback(async () => { setList(await api.orgIncidents(wsId).catch((): OrgIncident[] => [])); }, [wsId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 20_000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (app.orgFocus?.kind !== 'incident' || !list) return;
    const hit = list.find((i) => i.id === app.orgFocus!.id || i.id.startsWith(app.orgFocus!.id));
    if (hit) { setOpenId(hit.id); app.setOrgFocus(null); }
  }, [list, app]);
  const { open, resolved } = sortIncidents(list ?? []);
  const shown = list?.find((i) => i.id === openId) ?? null;
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>Incidents</h2>
          <div style={faint}>When something goes wrong the system contains it first (pause, freeze a class, supervised) and tells you once. Containment only narrows; resolving with "undo" reverses what is still in force.</div>
        </div>
        {role !== undefined && role !== null && role !== 'observer' && <button style={btn(true)} onClick={() => setReporting(!reporting)}>{reporting ? 'Close' : 'Report an incident'}</button>}
      </div>
      <HealthStrip health={app.orgHealth} />
      {reporting && <ReportForm org={org} onDone={async (inc) => { setReporting(false); await refresh(); void app.refreshWsOrg(); if (inc) setOpenId(inc.id); }} />}
      {list === null && <div style={faint}>Loading…</div>}
      {list !== null && open.length === 0 && <div style={{ ...card, ...faint, marginBottom: 10 }}>No open incidents.</div>}
      {open.map((i) => <IncidentRow key={i.id} i={i} names={names} onOpen={() => setOpenId(i.id)} />)}
      {resolved.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button style={linkBtn} onClick={() => setShowResolved(!showResolved)} aria-expanded={showResolved}>{showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})</button>
          {showResolved && <div style={{ marginTop: 8 }}>{resolved.map((i) => <IncidentRow key={i.id} i={i} names={names} onOpen={() => setOpenId(i.id)} />)}</div>}
        </div>
      )}
      {shown && <IncidentDrawer org={org} incident={shown} decider={decider} onClose={() => setOpenId(null)} onChanged={async () => { await refresh(); void app.refreshWsOrg(); }} />}
    </div>
  );
}

function IncidentRow({ i, names, onOpen }: { i: OrgIncident; names: ReturnType<typeof useAgentNames>; onOpen: () => void }) {
  const a = i.agentId ? names.get(i.agentId) : undefined;
  const held = containedNow(i);
  const color = i.status === 'resolved' ? 'var(--text-faint)' : INCIDENT_SEVERITY_COLOR[i.severity];
  return (
    <button onClick={onOpen} aria-label={`Open incident ${i.title}`} style={{ ...card, display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, cursor: 'pointer', color: 'var(--text)', borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={pill(color, '#fff')}>{i.severity}</span>
        <span style={pill()}>{i.status}</span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 160 }}>{i.title}</span>
        <span style={faint}>{ago(i.openedAt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 5, ...faint }}>
        <span>{INCIDENT_KIND_LABEL[i.kind] ?? i.kind}</span>
        {a && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Avatar a={a} size={14} />{a.name}</span>}
        {i.actionClass && <span>class {CLASS_LABEL[i.actionClass] ?? i.actionClass}</span>}
        {i.status !== 'resolved' && <span style={{ color: held.length ? 'var(--amber)' : undefined }}>{held.length ? `contained: ${held.map((s) => s.result).join('; ')}` : 'nothing contained'}</span>}
        {i.status === 'resolved' && i.resolution && <span>resolved — {i.resolution.slice(0, 120)}</span>}
        {i.postmortemMeetingId && <span>postmortem scheduled</span>}
      </div>
    </button>
  );
}

function ReportForm({ org, onDone }: { org: OrgDetail; onDone: (i: OrgIncident | null) => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [agentId, setAgentId] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('minor');
  const [cls, setCls] = useState('');
  const members = org.members.filter((m) => m.status !== 'terminated');
  const submit = async () => {
    try { const r = await api.reportOrgIncident(org.workspaceId, { title: title.trim(), detail: detail.trim(), severity, ...(agentId ? { agentId } : {}), ...(cls ? { actionClass: cls } : {}) }); app.showToast(`Reported — ${r.status === 'contained' ? 'contained' : 'noted'}`); await onDone(r); } catch (e) { app.showToast(errText(e)); }
  };
  return (
    <div role="form" aria-label="Report an incident" style={{ ...card, marginBottom: 12, display: 'grid', gap: 8 }}>
      <div><label style={label} htmlFor="inc-title">What happened</label><input id="inc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Writer emailed a customer the wrong price" style={input} /></div>
      <div><label style={label} htmlFor="inc-detail">Detail</label><textarea id="inc-detail" value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} /></div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <div><label style={label} htmlFor="inc-agent">About</label>
          <select id="inc-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={input}><option value="">No one member</option>{members.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select></div>
        <div><label style={label} htmlFor="inc-sev">Severity</label>
          <select id="inc-sev" value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)} style={input}>
            <option value="minor">minor — a signal and a note</option><option value="major">major — pauses the member</option><option value="critical">critical — pauses, freezes, supervised</option>
          </select></div>
        <div><label style={label} htmlFor="inc-cls">Action class (optional)</label>
          <select id="inc-cls" value={cls} onChange={(e) => setCls(e.target.value)} style={input}><option value="">—</option>{ACTION_CLASSES.filter((c) => c !== 'read').map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}</select></div>
      </div>
      <div style={faint}>Containment follows the severity's level (tunables <code>incidents.contain*</code>); the trust ledger demotes the member for this class.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={!title.trim() || !detail.trim()} onClick={() => void submit()}>Report</button></div>
    </div>
  );
}

function IncidentDrawer({ org, incident: i, decider, onClose, onChanged }: { org: OrgDetail; incident: OrgIncident; decider: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const follow = useFollowRef();
  const [action, setAction] = useState<ManualContainment>('pause_member');
  const [agentId, setAgentId] = useState(i.agentId ?? '');
  const [cls, setCls] = useState(i.actionClass && (ACTION_CLASSES as string[]).includes(i.actionClass) ? i.actionClass : 'external_irreversible');
  const [resolution, setResolution] = useState('');
  const [undo, setUndo] = useState(true);
  const a = i.agentId ? names.get(i.agentId) : undefined;
  const timeline = incidentTimeline(i);
  const held = containedNow(i);
  const run = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); await onChanged(); app.showToast(done); } catch (e) { app.showToast(errText(e)); } };
  const members = org.members.filter((m) => m.status === 'active');
  const containWhat = action === 'pause_member' ? `pause ${names.get(agentId)?.name ?? 'the member'}` : action === 'freeze_class' ? `freeze ${(CLASS_LABEL[cls] ?? cls).toLowerCase()} actions for every member` : action === 'supervised' ? 'switch the company to supervised' : 'pause the whole company';
  return (
    <Drawer onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={pill(i.status === 'resolved' ? 'var(--text-faint)' : INCIDENT_SEVERITY_COLOR[i.severity], '#fff')}>{i.severity}</span>
        <h2 style={{ ...h2, flex: 1 }}>{i.title}</h2>
        <button style={btn()} onClick={onClose} aria-label="Close"><I d={P.x} size={14} /></button>
      </div>
      <div style={faint}>[{i.id.slice(0, 8)}] {INCIDENT_KIND_LABEL[i.kind] ?? i.kind} · {i.status}{a ? ` · ${a.name}` : ''}{i.actionClass ? ` · ${CLASS_LABEL[i.actionClass] ?? i.actionClass}` : ''}{i.refType && i.refId ? ` · about ${i.refType} ${i.refId.slice(0, 8)}` : ''}</div>
      {i.refType === 'task' && i.refId && <div><button style={linkBtn} onClick={() => { onClose(); follow('task', i.refId); }}>Open the task</button></div>}
      <div style={card}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Timeline</div>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {timeline.map((e, k) => (
            <li key={k} style={{ display: 'flex', gap: 8, padding: '5px 0', borderTop: k ? '1px solid var(--border-soft)' : undefined }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-faint)', flex: 'none', width: 92 }}>{e.at.slice(5, 16).replace('T', ' ')}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: e.kind === 'detected' || e.kind === 'resolved' ? 600 : 500, textDecoration: e.undone ? 'line-through' : undefined }}>{e.text}</div>
                {e.detail && <div style={{ ...faint, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{e.detail}</div>}
                {e.kind === 'postmortem' && i.postmortemMeetingId && <button style={linkBtn} onClick={() => { onClose(); follow('meeting', i.postmortemMeetingId!); }}>Open the postmortem meeting</button>}
              </div>
            </li>
          ))}
        </ol>
      </div>
      {i.status !== 'resolved' && decider && (
        <div style={{ ...card, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Contain more</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select aria-label="Containment" value={action} onChange={(e) => setAction(e.target.value as ManualContainment)} style={{ ...input, width: 'auto', flex: '1 1 180px' }}>
              {(Object.keys(MANUAL_CONTAINMENT_LABEL) as ManualContainment[]).map((k) => <option key={k} value={k}>{MANUAL_CONTAINMENT_LABEL[k].label} — {MANUAL_CONTAINMENT_LABEL[k].hint}</option>)}
            </select>
            {action === 'pause_member' && <select aria-label="Member to pause" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ ...input, width: 'auto', flex: '1 1 140px' }}><option value="">Member…</option>{members.map((m) => <option key={m.id} value={m.agentId}>{names.get(m.agentId)?.name ?? m.agentId.slice(0, 8)}</option>)}</select>}
            {action === 'freeze_class' && <select aria-label="Class to freeze" value={cls} onChange={(e) => setCls(e.target.value)} style={{ ...input, width: 'auto', flex: '1 1 160px' }}>{ACTION_CLASSES.filter((c) => c !== 'read').map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}</select>}
            <button style={btn(false, action === 'pause_org')} disabled={action === 'pause_member' && !agentId}
              onClick={() => { if (action === 'pause_org' && !confirm('Pause the whole company? Every wake and run stops until you resume it.')) return; void run(() => api.containOrgIncident(org.workspaceId, i.id, { action, ...(action === 'pause_member' ? { agentId } : {}), ...(action === 'freeze_class' ? { actionClass: cls } : {}) }), 'Contained'); }}>
              Contain: {containWhat}
            </button>
          </div>
        </div>
      )}
      {i.status !== 'resolved' && decider && (
        <div style={{ ...card, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Resolve</div>
          <textarea aria-label="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2} placeholder="What was done, what changes" style={{ ...input, resize: 'vertical' }} />
          <label style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} disabled={held.length === 0} />
            <span>Undo containment{held.length ? `: ${held.map((s) => s.result).join('; ')}` : ' (nothing is still in force)'}</span>
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn(true)} disabled={!resolution.trim()} onClick={() => void run(() => api.resolveOrgIncident(org.workspaceId, i.id, { resolution: resolution.trim(), undo: undo && held.length > 0 }), 'Resolved')}>Resolve{undo && held.length ? ' and undo' : ''}</button></div>
        </div>
      )}
      {i.status !== 'resolved' && !decider && <div style={faint}>Containing and resolving are the CEO's or a board member's.</div>}
    </Drawer>
  );
}

// ---- Pulse: auditor quality, spot checks, red team ----

export function AssuranceCard({ org, audits, onChanged }: { org: OrgDetail; audits: OrgAuditRun[]; onChanged: () => Promise<void> }) {
  const app = useApp();
  const names = useAgentNames();
  const follow = useFollowRef();
  const role = useOrgRole(org.workspaceId);
  const decider = role === 'ceo' || role === 'board';
  const q = auditorQuality(audits);
  const cards = pendingSpotChecks(audits);
  const rt = lastRedTeam(audits);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const answer = async (auditId: string, itemId: string, agree: boolean) => {
    try { const r = await api.answerSpotCheck(org.workspaceId, auditId, itemId, { agree, note: notes[`${auditId}:${itemId}`] || undefined }); app.showToast(r.incident ? 'Recorded — a minor auditor_miss incident opened' : 'Recorded'); await onChanged(); } catch (e) { app.showToast(errText(e)); }
  };
  const redteam = async () => {
    setRunning(true);
    try { const r = await api.runOrgRedTeam(org.workspaceId); app.showToast(r.breach ? 'Breach — an incident opened and the member is paused' : `Red-team: ${r.result}`); await onChanged(); void app.refreshWsOrg(); } catch (e) { app.showToast(errText(e)); } finally { setRunning(false); }
  };
  return (
    <div style={{ ...card, marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Who audits the auditor</span>
        <span style={faint}>{q.text}</span>
      </div>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 8 }}>
        <div><div style={label}>Precision</div><div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700 }}>{q.precision === null ? '—' : `${Math.round(q.precision * 100)}%`}</div></div>
        <div><div style={label}>Recall</div><div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 700 }}>{q.recall === null ? '—' : `${Math.round(q.recall * 100)}%`}</div></div>
        <div><div style={label}>Rotation</div><div style={{ fontSize: 12.5, color: q.noRotation ? 'var(--amber)' : undefined }}>{q.noRotation ? 'no rotation — hire or title a second Auditor' : 'the seat rotates'}</div></div>
      </div>
      {cards.length > 0 && <div style={{ ...label, margin: '6px 0' }}>Spot checks · {cards.length} waiting</div>}
      {cards.map((c) => {
        const k = `${c.auditId}:${c.itemId}`;
        return (
          <div key={k} style={{ borderTop: '1px solid var(--border-soft)', padding: '8px 0' }}>
            <div style={{ fontSize: 12.5 }}>{c.kind === 'finding' ? 'The auditor raised:' : 'The auditor let this pass:'} <b>{c.title}</b>{c.refType && c.refId ? <> <button style={linkBtn} onClick={() => follow(c.refType, c.refId)}>open</button></> : null}</div>
            <div style={{ fontSize: 12.5, margin: '4px 0' }}>Do you agree with the auditor on this item?</div>
            {decider ? (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input aria-label="Note" value={notes[k] ?? ''} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} placeholder="Note (optional)" style={{ ...input, flex: '1 1 160px', width: 'auto' }} />
                <button style={btn(true)} onClick={() => void answer(c.auditId, c.itemId, true)}>Agree</button>
                <button style={btn(false, true)} onClick={() => void answer(c.auditId, c.itemId, false)}>Disagree</button>
              </div>
            ) : <div style={faint}>The CEO or a board member answers.</div>}
          </div>
        );
      })}
      <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8, marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={label}>Red team</span>
        {rt ? <span style={{ fontSize: 12.5, color: rt.breach ? 'var(--red)' : 'var(--green)' }}>{rt.breach ? 'breached' : 'held the line'} · {names.get(rt.agentId)?.name ?? 'a member'} · {ago(rt.at)}</span> : <span style={faint}>no run yet</span>}
        {rt?.breach && <button style={linkBtn} onClick={() => app.setOrgPane('incidents')}>see the incident</button>}
        {decider && <button style={{ ...btn(), marginLeft: 'auto' }} disabled={running} onClick={() => void redteam()} title="Hands one member a sandboxed copy of its inbound content with a canary; nothing it calls executes">{running ? 'Running…' : 'Run red-team now'}</button>}
      </div>
    </div>
  );
}
