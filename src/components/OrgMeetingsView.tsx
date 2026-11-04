/** Meetings and Decisions (docs/company-vision.md §3, §6; docs/group-chat.md
 *  §8; execution plan item 19). Meetings: the cadences per unit with their
 *  cron in words and editable, the meetings as a list and a calendar
 *  (MeetingsBoard: upcoming occurrences and the meetings held, each with its
 *  minutes file — docs/meetings.md), and "Start meeting" with kind, unit and agenda.
 *  Decisions: the decision log — what was decided, the alternatives, the
 *  rationale, who decided, where it came from, with a link to the meeting. */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { useApp } from '../store';
import { api, type OrgCadence, type OrgDecision, type OrgDetail, type OrgMeeting } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import { decidedByLabel, decisionSource, firesOn, humanCron, MEETING_KIND_TITLES } from '../lib/org';
import { openMeetingView, tokensText } from '../lib/meetings';
import { card, input, btn, pill, h2, faint, label, linkBtn, ago, useAgentNames, useUnits, Avatar, UnitChips } from './org-ui';
import { MeetingsBoard } from './MeetingsBoard';
import { MeetingStartDialog } from './MeetingStartDialog';

const RelatedDrawer = lazy(() => import('./OrgMemoryView').then((m) => ({ default: m.RelatedDrawer })));

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

/** Open the thread a meeting is (in its unit channel). */
export function useOpenMeeting() {
  const app = useApp();
  return useCallback((m: OrgMeeting) => {
    const ch = app.channels.find((c) => c.id === m.channelId);
    if (ch && m.threadRootId) app.openChannel(ch.slug, m.threadRootId);
    else if (ch) app.openChannel(ch.slug);
    // A closed sub-channel is not in the rail's list: the meeting's room still opens.
    else if (m.parentChannelId) openMeetingView(app.workspaceId, m.id);
    else app.showToast(m.status === 'scheduled' ? 'The meeting has not started yet' : 'This meeting has no channel thread');
  }, [app]);
}

export function MeetingsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const { current, isCompany, byId, units } = useUnits();
  const names = useAgentNames();
  const openMeeting = useOpenMeeting();
  const [meetings, setMeetings] = useState<OrgMeeting[] | null>(null);
  const [starting, setStarting] = useState(false);
  const unitId = isCompany ? null : current?.id ?? null;
  const refresh = useCallback(async () => {
    setMeetings(await api.orgMeetings(wsId, { unitId }).catch((): OrgMeeting[] => []));
    void app.refreshWsOrg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, unitId]);
  useEffect(() => { void refresh(); const t = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(t); }, [refresh]);
  // A deep link names a meeting: open its thread once the list has it.
  useEffect(() => {
    if (app.orgFocus?.kind !== 'meeting' || !meetings) return;
    const m = meetings.find((x) => x.id === app.orgFocus!.id);
    if (m) { app.setOrgFocus(null); openMeeting(m); }
  }, [meetings, app, openMeeting]);
  const cadences = useMemo(() => app.orgCadences.filter((c) => (unitId ? c.unitId === unitId : true)), [app.orgCadences, unitId]);
  const byUnit = useMemo(() => {
    const m = new Map<string, OrgCadence[]>();
    for (const c of cadences) m.set(c.unitId, [...(m.get(c.unitId) ?? []), c]);
    return [...m.entries()].sort(([a], [b]) => (byId.get(a)?.depth ?? 0) - (byId.get(b)?.depth ?? 0));
  }, [cadences, byId]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try { await fn(); await refresh(); if (done) app.showToast(done); } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'failed'); }
  };
  const unitName = (id: string | null) => { const u = id ? byId.get(id) : null; return u ? (u.parentUnitId === null ? 'Company' : u.name) : 'Company'; };
  const running = (meetings ?? []).filter((m) => m.status === 'running');
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>{isCompany ? 'Meetings' : `${current?.name ?? 'Department'} · meetings`}</h2>
          <div style={faint}>Rituals are threads in the department channel: they open with the last meeting's open items, give each attendee one turn per round (later rounds only those with something open; passing is cheap), time-box each agenda item, stay under a USD cap, skip themselves when there is nothing to discuss, and end in minutes that become tasks, decisions, risks and questions for you. Crons are server-local, like loops.</div>
        </div>
        <button style={btn(true)} onClick={() => setStarting(!starting)}>Start meeting</button>
      </div>
      <UnitChips count={(u) => app.orgCadences.filter((c) => c.unitId === u.id && c.enabled === 1 && firesOn(c.cron)).length || null} title={(u) => `${app.orgCadences.filter((c) => c.unitId === u.id && c.enabled === 1 && firesOn(c.cron)).length} ritual(s) today`} />
      {starting && <MeetingStartDialog wsId={wsId} units={units} defaultUnitId={unitId ?? units.find((u) => u.parentUnitId === null)?.id ?? ''} onDone={(m) => { setStarting(false); void refresh(); if (m) setTimeout(() => { void api.orgMeeting(wsId, m.id).then(openMeeting).catch(() => {}); }, 1500); }} />}
      {running.length > 0 && (
        <div style={{ ...card, marginBottom: 10, borderLeft: '3px solid var(--green)' }}>
          <div style={label}>Running now</div>
          {running.map((m) => (
            <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', animation: 'pulse 1.2s infinite' }} />
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{m.title || MEETING_KIND_TITLES[m.kind]} · {unitName(m.unitId)}</span>
              <span style={faint}>round {m.rounds} · {tokensText((m.tokensIn ?? 0) + (m.tokensOut ?? 0))} tokens · {fmtUsd(m.usd)} · started {ago(m.startedAt)}</span>
              <button style={btn(true)} onClick={() => { void api.joinMeeting(wsId, m.id).catch(() => undefined); openMeetingView(wsId, m.id); }} title="Join the full-screen room: you are heard at the next turn">Join</button>
              <button style={btn()} onClick={() => openMeeting(m)} title="Open the meeting's thread in its channel">Thread</button>
              <button style={btn(false, true)} onClick={() => { if (confirm('Cancel this meeting? The minutes are written from what was proposed so far.')) void act(() => api.cancelOrgMeeting(wsId, m.id), 'Meeting cancelled'); }}>Cancel</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ ...card, marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Cadences</div>
          <span style={faint}>per department · five-field cron, server-local · the chief and leads reshape them with <code>org_set_cadence</code>; you edit them here</span>
        </div>
        {byUnit.length === 0 && <div style={faint}>No cadences yet — they are created with the first department.</div>}
        {byUnit.map(([uid, rows]) => {
          const u = byId.get(uid);
          const lead = u ? names.get(u.leadAgentId) : undefined;
          return (
            <div key={uid} style={{ marginTop: 8 }}>
              {(isCompany || byUnit.length > 1) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                  {u?.parentUnitId === null ? '🏢' : <Avatar a={lead} size={16} />}{unitName(uid)}
                  {u && <button style={linkBtn} onClick={() => app.openChannel(u.slug)}>#{u.slug}</button>}
                </div>
              )}
              {rows.sort((a, b) => a.kind.localeCompare(b.kind)).map((c) => <CadenceRow key={c.id} c={c} wsId={wsId} act={act} />)}
            </div>
          );
        })}
      </div>
      <MeetingsBoard wsId={wsId} unitId={unitId} showUnit={isCompany} />
    </div>
  );
}

function CadenceRow({ c, wsId, act }: { c: OrgCadence; wsId: string; act: (fn: () => Promise<unknown>, done?: string) => Promise<void> }) {
  const [cron, setCron] = useState(c.cron);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setCron(c.cron); }, [c.cron]);
  const today = c.enabled === 1 && firesOn(c.cron);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 150px) minmax(0, 1fr) auto', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border-soft)', opacity: c.enabled === 1 ? 1 : .55 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center' }}>{MEETING_KIND_TITLES[c.kind] ?? c.kind}{today && <span style={pill('var(--accent-dim)', 'var(--text)')}>today</span>}</div>
      <div style={{ minWidth: 0 }}>
        {editing ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <input aria-label="Cron" autoFocus value={cron} onChange={(e) => setCron(e.target.value)} style={{ ...input, ...mono, padding: '4px 8px' }} placeholder="min hour dom mon dow"
              onKeyDown={(e) => { if (e.key === 'Enter' && cron.trim()) { void act(() => api.updateOrgCadence(wsId, c.id, { cron: cron.trim() }), `${MEETING_KIND_TITLES[c.kind]}: ${humanCron(cron.trim())}`); setEditing(false); } if (e.key === 'Escape') { setCron(c.cron); setEditing(false); } }} />
            <button style={btn(true)} disabled={!cron.trim()} onClick={() => { void act(() => api.updateOrgCadence(wsId, c.id, { cron: cron.trim() }), `${MEETING_TITLE(c.kind)}: ${humanCron(cron.trim())}`); setEditing(false); }}>Save</button>
            <button style={btn()} onClick={() => { setCron(c.cron); setEditing(false); }}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} title="Edit the cron" style={{ ...linkBtn, color: 'var(--text)', fontWeight: 500, textAlign: 'left', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5 }}>{humanCron(c.cron)}</span>
            <span style={{ ...faint, ...mono, fontSize: 10.5 }}>{c.cron}</span>
            {c.nextRunAt && c.enabled === 1 && <span style={faint}>next {new Date(c.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
            {c.lastRunAt && <span style={faint}>last {ago(c.lastRunAt)}</span>}
          </button>
        )}
      </div>
      <label style={{ ...faint, display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }} title={c.enabled === 1 ? 'Fires on the cron' : 'Off: never fires'}>
        <input type="checkbox" checked={c.enabled === 1} onChange={(e) => void act(() => api.updateOrgCadence(wsId, c.id, { enabled: e.target.checked }), e.target.checked ? 'Cadence on' : 'Cadence off')} />on
      </label>
    </div>
  );
}
const MEETING_TITLE = (k: string) => MEETING_KIND_TITLES[k] ?? k;

// ---- decisions ----

export function DecisionsPane({ org }: { org: OrgDetail }) {
  const app = useApp();
  const wsId = org.workspaceId;
  const names = useAgentNames();
  const { current, isCompany, byId } = useUnits();
  const openMeeting = useOpenMeeting();
  const [rows, setRows] = useState<OrgDecision[] | null>(null);
  const [meetings, setMeetings] = useState<Map<string, OrgMeeting>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [related, setRelated] = useState<OrgDecision | null>(null);
  const unitId = isCompany ? null : current?.id ?? null;
  // The search runs server-side over title, decision and rationale (GET …/decisions/search, item 22), debounced.
  const refresh = useCallback(async () => {
    const needle = q.trim();
    const [d, m] = await Promise.all([(needle ? api.orgSearchDecisions(wsId, needle, unitId) : api.orgDecisions(wsId, unitId)).catch((): OrgDecision[] => []), api.orgMeetings(wsId).catch((): OrgMeeting[] => [])]);
    setRows(d); setMeetings(new Map(m.map((x) => [x.id, x])));
  }, [wsId, unitId, q]);
  useEffect(() => { const d = setTimeout(() => { void refresh(); }, q ? 250 : 0); const t = setInterval(() => { void refresh(); }, 60_000); return () => { clearTimeout(d); clearInterval(t); }; }, [refresh, q]);
  // A `#decision:` chip deep-linked here (an id or its prefix): expand and scroll to it.
  useEffect(() => {
    if (app.orgFocus?.kind !== 'decision' || !rows) return;
    const d = rows.find((x) => x.id === app.orgFocus!.id || x.id.startsWith(app.orgFocus!.id));
    if (!d) { if (rows.length) { app.showToast('That decision is not in this department\'s log'); app.setOrgFocus(null); } return; }
    setOpen(d.id); app.setOrgFocus(null);
    requestAnimationFrame(() => document.getElementById(`decision-${d.id}`)?.scrollIntoView({ block: 'center' }));
  }, [rows, app]);
  const shown = rows ?? [];
  const SOURCE_HINT: Record<string, string> = { meeting: 'proposed in a meeting and logged when it closed', approval: 'an approval card you decided', cadence: 'a cadence change', autonomous: 'the chief acted on its own within the caps' };
  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h2 style={h2}>{isCompany ? 'Decisions' : `${current?.name ?? 'Department'} · decisions`}</h2>
          <div style={faint}>The decision log (§6): what was decided, the alternatives, the rationale, who decided and where it came from. Reference one in a channel as <code>#decision:&lt;id&gt;</code>.</div>
        </div>
        <input aria-label="Search decisions" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the log" style={{ ...input, width: 180 }} />
      </div>
      <UnitChips />
      {related && <Suspense fallback={null}><RelatedDrawer wsId={wsId} ref={`decision:${related.id}`} title={related.title} onClose={() => setRelated(null)} /></Suspense>}
      {rows === null && <div style={faint}>Loading…</div>}
      {rows && shown.length === 0 && <div style={{ ...card, ...faint }}>{q ? 'No decision matches.' : 'No decision logged yet. Meetings log theirs when they close; approvals and cadence changes log themselves.'}</div>}
      {shown.map((d) => {
        const src = decisionSource(d);
        const meeting = d.meetingId ? meetings.get(d.meetingId) : undefined;
        const unit = d.unitId ? byId.get(d.unitId) : null;
        const by = decidedByLabel(d.decidedBy, (id) => names.get(id)?.name, (id) => app.nameOf(id));
        const expanded = open === d.id;
        return (
          <div key={d.id} id={`decision-${d.id}`} style={{ ...card, padding: '10px 12px', marginBottom: 8, borderLeft: `3px solid ${src === 'meeting' ? 'var(--accent)' : src === 'approval' ? 'var(--green)' : src === 'autonomous' ? 'var(--amber)' : 'var(--border)'}` }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{d.title}</span>
                  <span style={{ ...faint, ...mono, fontSize: 10.5 }} title="Reference it in a channel">#decision:{d.id.slice(0, 8)}</span>
                  <span style={pill()} title={SOURCE_HINT[src]}>{src}</span>
                  {unit && isCompany && <span style={pill()}>{unit.parentUnitId === null ? 'company' : unit.name}</span>}
                </div>
                {d.decision && <div style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{d.decision}</div>}
                <div style={{ ...faint, marginTop: 4 }}>decided by {by} · {ago(d.createdAt)}{meeting ? <> · in <button style={linkBtn} onClick={() => openMeeting(meeting)}>{meeting.title || MEETING_KIND_TITLES[meeting.kind]}</button></> : d.approvalId ? <> · <button style={linkBtn} onClick={() => app.setOrgPane('approvals')}>approval</button></> : null}</div>
              </div>
              <button style={btn()} onClick={() => setRelated(d)} title="Everything linked to this decision in the record">Related</button>
              {(d.rationale || d.alternatives) && <button style={btn()} onClick={() => setOpen(expanded ? null : d.id)} aria-expanded={expanded}>{expanded ? 'Less' : 'Why'}</button>}
            </div>
            {expanded && (
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 8, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
                <div><div style={label}>Rationale</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 3, lineHeight: 1.5, color: d.rationale ? 'var(--text)' : 'var(--text-faint)' }}>{d.rationale || 'none given'}</div></div>
                <div><div style={label}>Alternatives considered</div><div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', marginTop: 3, lineHeight: 1.5, color: d.alternatives ? 'var(--text)' : 'var(--text-faint)' }}>{d.alternatives || 'none recorded'}</div></div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
