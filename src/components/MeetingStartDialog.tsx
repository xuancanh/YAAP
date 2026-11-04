/** Start a meeting from the UI (docs/meetings.md "Start a meeting"): kind,
 *  the unit (Company → Meetings) or the channel (a channel's Meetings tab),
 *  attendees — the unit's or the channel's agents and you — title and
 *  agenda; it calls the same start path as `/meeting` and the API
 *  (POST …/org/meetings). Bullet lines in the agenda become its items. */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api, MEETING_KINDS, type ChannelMember, type MeetingKind, type OrgMeeting } from '../lib/api';
import { MEETING_KIND_TITLES } from '../lib/org';
import { card, input, btn, faint, label } from './org-ui';

export function MeetingStartDialog({ wsId, units, defaultUnitId, channel, onDone }: {
  wsId: string;
  /** The org's units (depth for indentation); empty in a non-unit channel. */
  units: Array<{ id: string; name: string; parentUnitId: string | null; depth: number; memberAgentIds?: string[]; leadAgentId?: string }>;
  defaultUnitId?: string | null;
  /** Start in this channel (its Meetings tab); attendees come from its members. */
  channel?: { id: string; slug: string } | null;
  onDone: (m: OrgMeeting | null) => void;
}) {
  const app = useApp();
  const me = app.me?.actorId ?? '';
  const [kind, setKind] = useState<MeetingKind>('adhoc');
  const [unitId, setUnitId] = useState(defaultUnitId ?? units.find((u) => u.parentUnitId === null)?.id ?? '');
  const [agenda, setAgenda] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<ChannelMember[] | null>(null);
  /** Attendees the person unticked. Everyone else is picked, so a refetch of
   *  the members or the agents list never undoes the person's choice. */
  const [unpicked, setUnpicked] = useState<Set<string>>(() => new Set());
  const [joinMe, setJoinMe] = useState(true);
  useEffect(() => {
    if (!channel) { setMembers(null); return; }
    void api.channel(wsId, channel.slug).then((d) => setMembers(d.members)).catch(() => setMembers([]));
  }, [wsId, channel]);
  const agentName = (id: string) => app.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const candidates = useMemo(() => {
    if (channel) return (members ?? []).filter((x) => x.memberKind === 'agent').map((x) => ({ id: x.memberId, name: x.name }));
    const u = units.find((x) => x.id === unitId);
    const ids = [...new Set([...(u?.leadAgentId ? [u.leadAgentId] : []), ...(u?.memberAgentIds ?? [])])];
    return ids.map((id) => ({ id, name: agentName(id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, members, units, unitId, app.agents]);
  const isPicked = (id: string) => !unpicked.has(id);
  const toggle = (id: string) => setUnpicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const start = async () => {
    setBusy(true);
    try {
      const agents = candidates.filter((c) => isPicked(c.id)).map((c) => ({ kind: 'agent' as const, id: c.id }));
      const attendees = agents.length || joinMe ? [...agents, ...(joinMe && me ? [{ kind: 'human' as const, id: me }] : [])] : undefined;
      const m = await api.startOrgMeeting(wsId, {
        kind, unitId: channel ? undefined : unitId || undefined, channelId: channel?.id, agenda: agenda.trim() || undefined, title: title.trim() || undefined,
        attendees: attendees && attendees.some((a) => a.kind === 'agent') ? attendees : undefined,
      });
      if (joinMe) await api.joinMeeting(wsId, m.id).catch(() => undefined);
      app.showToast(`${MEETING_KIND_TITLES[kind]} started${channel ? ` in #${channel.slug}` : ' in the department channel'}`);
      onDone(m);
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'could not start'); } finally { setBusy(false); }
  };
  return (
    <div role="dialog" aria-label="Start a meeting" style={{ ...card, marginBottom: 10, display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 4 }}>Kind
          <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as MeetingKind)} style={input}>{MEETING_KINDS.map((k) => <option key={k} value={k}>{MEETING_KIND_TITLES[k]}</option>)}</select>
        </label>
        {channel ? (
          <div style={{ ...label, display: 'flex', flexDirection: 'column', gap: 4 }}>Channel<span style={{ ...input, textTransform: 'none', letterSpacing: 0 }}>#{channel.slug}</span></div>
        ) : (
          <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 4 }}>Unit
            <select aria-label="Unit" value={unitId} onChange={(e) => setUnitId(e.target.value)} style={input}>{units.map((u) => <option key={u.id} value={u.id}>{'· '.repeat(u.depth)}{u.parentUnitId === null ? 'Company' : u.name}</option>)}</select>
          </label>
        )}
        <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 4 }}>Title (optional)
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} style={input} placeholder={MEETING_KIND_TITLES[kind]} />
        </label>
      </div>
      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <legend style={{ ...label, marginBottom: 4 }}>Attendees</legend>
        {candidates.length === 0 && <span style={faint}>{channel && members === null ? 'Loading…' : 'The department (lead and reports) by default'}</span>}
        {candidates.map((c) => (
          <label key={c.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12.5 }}>
            <input type="checkbox" checked={isPicked(c.id)} onChange={() => toggle(c.id)} />{c.name}
          </label>
        ))}
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12.5 }}>
          <input type="checkbox" checked={joinMe} onChange={(e) => setJoinMe(e.target.checked)} />Me (join the room)
        </label>
      </fieldset>
      <label style={{ ...label, display: 'flex', flexDirection: 'column', gap: 4 }}>Agenda
        <textarea aria-label="Agenda" value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={3} style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} placeholder={kind === 'standup' ? 'Composed from the board (done · in progress · blocked per member); add anything extra here' : 'What to settle — one "- item" per line becomes an agenda item'} />
      </label>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ ...faint, flex: 1, minWidth: 200 }}>Rituals open with the last meeting's open items. Join the room to be heard at the next turn; "stop" in the thread ends it.</span>
        <button style={btn()} onClick={() => onDone(null)}>Cancel</button>
        <button style={btn(true)} disabled={busy || (!channel && !unitId)} onClick={() => void start()}>{busy ? 'Starting…' : 'Start now'}</button>
      </div>
    </div>
  );
}
