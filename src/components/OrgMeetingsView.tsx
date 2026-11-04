/** Meetings and Decisions (docs/company-vision.md §3, §6; docs/group-chat.md
 *  §8; execution plan item 19). Meetings: the cadences per unit with their
 *  cron in words and editable, the meetings as a list and a calendar
 *  (MeetingsBoard: upcoming occurrences and the meetings held, each with its
 *  minutes file — docs/meetings.md), and "Start meeting" with kind, unit and agenda.
 *  Decisions: the decision log — what was decided, the alternatives, the
 *  rationale, who decided, where it came from, with a link to the meeting. */
/* eslint-disable react-refresh/only-export-components */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, type OrgCadence, type OrgDetail, type OrgMeeting } from '../lib/api';
import { fmtUsd } from '../lib/pricing';
import { firesOn, humanCron, MEETING_KIND_TITLES } from '../lib/org';
import { openMeetingView, tokensText } from '../lib/meetings';
import { card, input, btn, pill, faint, label, linkBtn, ago, useAgentNames, useUnits, Avatar, UnitChips } from './org-ui';
import { MeetingsBoard } from './MeetingsBoard';
import { MeetingStartDialog } from './MeetingStartDialog';
import { PageHeader } from './CompanyKit';


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
    <div className="co-page" data-testid="meetings-page">
      <PageHeader title={isCompany ? 'Meetings' : `${current?.name ?? 'Department'} meetings`}
        purpose="Rituals run as threads in the department channel: one turn per attendee per round, time-boxed, under a USD cap, skipped when there is nothing to discuss. Their minutes become tasks, decisions, risks and questions for you."
        actions={<button className="co-btn primary" onClick={() => setStarting(!starting)} aria-expanded={starting}>Start meeting</button>} />
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

