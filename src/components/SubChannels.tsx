/** Sub-channels in the SPA (docs/group-chat.md §9): the parent's link card,
 *  the "Start a discussion" form, the breadcrumb and status strip of a
 *  sub-channel, and the rail's nested rows with the "Past discussions (N)"
 *  list. ChannelView and the rail's Channels block compose these. */
import { useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { api, type Channel, type ChannelDetail, type ChannelMember, type OrgMeeting, type SubChannelSummary } from '../lib/api';
import { agoText, parseLinkCardText, subIcon } from '../lib/channels';
import { MEETING_KIND_TITLES } from '../lib/org';

const btn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const field: React.CSSProperties = { width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none' };

function purposeLabel(purpose: string | null | undefined): string {
  return purpose === 'meeting' ? 'Meeting' : purpose === 'project' ? 'Project discussion' : 'Discussion';
}

/** The live dot: green while open (pulsing for a running meeting), grey once closed. */
export function LiveDot({ open, running, size = 7 }: { open: boolean; running?: boolean; size?: number }) {
  return <span aria-label={open ? 'live' : 'closed'} style={{ width: size, height: size, borderRadius: '50%', flex: 'none', background: open ? 'var(--green)' : 'var(--text-faint)', animation: running ? 'pulse 1.2s infinite' : undefined }} />;
}

/** The parent's link card: one system message the server rewrites in place;
 *  drawn from the live channel row when the rail has it (open), else from the
 *  card's text (closed). Clicking opens the sub-channel. */
export function SubChannelCard({ subId, text, meeting, onOpen }: { subId: string; text: string; meeting?: OrgMeeting | null; onOpen: (slug: string) => void }) {
  const app = useApp();
  const live = app.channels.find((c) => c.id === subId) ?? null;
  const parsed = parseLinkCardText(text);
  const open = live ? live.status !== 'closed' : parsed.status === 'live';
  const title = live?.name ?? parsed.title;
  const slug = live?.slug ?? parsed.slug;
  const members = live?.memberCount ?? parsed.members;
  const purpose = live?.purpose ?? (/^📅/.test(text) ? 'meeting' : /^📌/.test(text) ? 'project' : 'discussion');
  const running = meeting?.status === 'running';
  const status = purpose === 'meeting'
    ? (meeting ? (running ? 'live' : meeting.status === 'done' ? 'ended' : meeting.status) : open ? 'live' : 'ended')
    : open ? 'live' : 'closed';
  return (
    <button data-testid="sub-card" onClick={() => slug && onOpen(slug)} disabled={!slug}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', maxWidth: 560, textAlign: 'left', background: 'var(--panel)', border: `1px solid ${open ? 'var(--green)' : 'var(--border)'}`, borderRadius: 12, padding: '10px 12px', margin: '8px 0', cursor: slug ? 'pointer' : 'default', color: 'var(--text)' }}>
      <span style={{ fontSize: 18, lineHeight: 1, flex: 'none', marginTop: 1 }}>{subIcon(purpose)}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{purposeLabel(purpose)}{meeting ? ` · ${MEETING_KIND_TITLES[meeting.kind] ?? meeting.kind}` : ''}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: open ? 'var(--green)' : 'var(--text-dim)' }}><LiveDot open={open} running={running} />{status}</span>
        </span>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>
          {members !== null && members !== undefined ? `${members} member${members === 1 ? '' : 's'}` : ''}
          {live?.lastActivityAt && open ? ` · last activity ${agoText(live.lastActivityAt)}` : ''}
          {running && meeting ? ` · round ${Math.max(1, meeting.rounds)}` : ''}
          {(live?.unread ?? 0) > 0 ? ` · ${live!.unread} unread` : ''}
        </span>
        {!open && parsed.outcome && <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>{parsed.outcome}</span>}
      </span>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--accent-hi)', flex: 'none', alignSelf: 'center' }}>{open ? 'Open' : 'View'} <I d={P.chevR} size={11} /></span>
    </button>
  );
}

/** "Start a discussion": a title, why, and who is in it (default: everyone in
 *  the channel). From a message or a thread, that thread gets a pointer. */
export function StartDiscussionForm({ wsId, slug, members, originMessageId, defaultTitle, onDone, onCancel }: {
  wsId: string; slug: string; members: ChannelMember[]; originMessageId?: string | null; defaultTitle?: string;
  onDone: (c: Channel) => void; onCancel: () => void;
}) {
  const app = useApp();
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(members.map((m) => `${m.memberKind}:${m.memberId}`)));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const all = picked.size === members.length;
      const c = await api.startDiscussion(wsId, slug, {
        title: title.trim(), reason: reason.trim() || undefined, originMessageId: originMessageId ?? undefined,
        members: all ? undefined : members.filter((m) => picked.has(`${m.memberKind}:${m.memberId}`)).map((m) => ({ kind: m.memberKind, id: m.memberId })),
      });
      await app.refreshChannels();
      onDone(c);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'could not start the discussion');
    } finally { setBusy(false); }
  };
  return (
    <div role="dialog" aria-label="Start a discussion" style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow)', padding: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Start a discussion</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.45 }}>A temporary sub-channel of #{slug}: the channel keeps one card linking to it; close it with an outcome when it is settled.</div>
        <input autoFocus aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it about?" maxLength={100} style={{ ...field, marginTop: 12 }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); if (e.key === 'Escape') onCancel(); }} />
        <textarea aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it needs its own space (optional)" rows={2} style={{ ...field, marginTop: 8, resize: 'vertical' }} />
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '12px 0 4px' }}>Members · {picked.size}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {members.map((m) => {
            const key = `${m.memberKind}:${m.memberId}`;
            const on = picked.has(key);
            return (
              <button key={key} onClick={() => setPicked((p) => { const n = new Set(p); if (on) n.delete(key); else n.add(key); return n; })} aria-pressed={on}
                style={{ ...btn, padding: '3px 9px', fontWeight: 500, background: on ? 'var(--accent-dim)' : 'var(--panel-2)', borderColor: on ? 'var(--accent)' : 'var(--border)' }}>
                {m.memberKind === 'agent' ? '🤖 ' : ''}{m.name}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={btn}>Cancel</button>
          <button onClick={() => void submit()} disabled={!title.trim() || busy} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none', opacity: title.trim() ? 1 : 0.6 }}>{busy ? 'Starting…' : 'Start'}</button>
        </div>
      </div>
    </div>
  );
}

/** A sub-channel's breadcrumb: "#parent › Title", the parent clickable. */
export function SubBreadcrumb({ detail, channel, onParent }: { detail: ChannelDetail | null; channel: Channel; onParent: (slug: string) => void }) {
  const parent = detail?.parent ?? null;
  return (
    <div data-testid="sub-breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 15 }}>
      {parent && <button onClick={() => onParent(parent.slug)} title={`Back to #${parent.slug}`} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', fontWeight: 600, fontSize: 15, flex: 'none' }}>#{parent.slug}</button>}
      {parent && <span style={{ color: 'var(--text-faint)', flex: 'none' }}>›</span>}
      <span style={{ fontWeight: 600, letterSpacing: '-.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel.name}</span>
    </div>
  );
}

/** The status strip under a sub-channel's header: open (who started it, last
 *  activity, Close) or closed (the outcome, Reopen). */
export function SubStatusBar({ wsId, channel, onChanged }: { wsId: string; channel: Channel; onChanged: () => void }) {
  const app = useApp();
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const open = channel.status !== 'closed';
  const meeting = channel.purpose === 'meeting';
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); app.showToast(done); setClosing(false); setOutcome(''); await app.refreshChannels(); onChanged(); } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'failed'); } finally { setBusy(false); }
  };
  return (
    <div role="status" data-testid="sub-status" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '7px 16px', borderBottom: '1px solid var(--border)', background: open ? 'var(--panel)' : 'var(--panel-2)', fontSize: 12 }}>
      <LiveDot open={open} />
      {open
        ? <span style={{ color: 'var(--text-dim)' }}>{purposeLabel(channel.purpose)} · open{channel.lastActivityAt ? ` · last activity ${agoText(channel.lastActivityAt)}` : ''}{meeting ? ' · closes when the meeting ends' : ''}</span>
        : <span style={{ color: 'var(--text-dim)', flex: 1, minWidth: 0 }}>{meeting ? 'This meeting has ended' : 'This discussion is closed'} — read-only{channel.outcome ? `: ${channel.outcome}` : '.'}</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        {open && !meeting && !closing && <button onClick={() => setClosing(true)} style={{ ...btn, padding: '3px 10px' }}>Close</button>}
        {!open && <button onClick={() => void act(() => api.reopenDiscussion(wsId, channel.slug), 'Reopened')} style={{ ...btn, padding: '3px 10px' }}>Reopen</button>}
      </span>
      {closing && (
        <div style={{ display: 'flex', gap: 6, width: '100%', flexWrap: 'wrap' }}>
          <input autoFocus aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Outcome — what was settled (optional)" style={{ ...field, flex: 1, minWidth: 180, padding: '5px 9px', fontSize: 12.5 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void act(() => api.closeDiscussion(wsId, channel.slug, outcome.trim() || undefined), 'Discussion closed'); if (e.key === 'Escape') setClosing(false); }} />
          <button onClick={() => void act(() => api.closeDiscussion(wsId, channel.slug, outcome.trim() || undefined), 'Discussion closed')} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none', padding: '3px 10px' }}>Close discussion</button>
          <button onClick={() => setClosing(false)} style={{ ...btn, padding: '3px 10px' }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** The rail rows under a channel: its open sub-channels (indented, live dot
 *  or meeting icon, unread badge) and a collapsed "Past discussions (N)". */
export function SubChannelRows({ wsId, parent, subs, past, current, onOpen }: { wsId: string; parent: Channel; subs: Channel[]; past: number; current: string | null; onOpen: (slug: string) => void }) {
  const [showPast, setShowPast] = useState(false);
  const [pastList, setPastList] = useState<SubChannelSummary[] | null>(null);
  useEffect(() => {
    if (!showPast) return;
    let on = true;
    void api.channelSubs(wsId, parent.slug, 'closed').then((l) => { if (on) setPastList(l); }).catch(() => { if (on) setPastList([]); });
    return () => { on = false; };
  }, [showPast, wsId, parent.slug, past]);
  if (subs.length === 0 && past === 0) return null;
  const row = (active: boolean): React.CSSProperties => ({ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 10px 4px 30px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none', minWidth: 0 });
  return (
    <div data-testid={`subs-of-${parent.slug}`}>
      {subs.map((s) => (
        <div key={s.id} onClick={() => onOpen(s.slug)} title={s.name} style={row(current === s.slug)}>
          {s.purpose === 'meeting' ? <span style={{ fontSize: 11, flex: 'none' }}>📅</span> : <LiveDot open />}
          <span style={{ flex: 1, fontSize: 12, fontWeight: (s.unread ?? 0) > 0 ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{s.name}</span>
          {(s.unread ?? 0) > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--accent)', borderRadius: 8, padding: '1px 6px' }}>{s.unread}</span>}
        </div>
      ))}
      {past > 0 && (
        <div onClick={() => setShowPast(!showPast)} style={{ ...row(false), color: 'var(--text-faint)', fontSize: 11.5 }} aria-expanded={showPast}>
          <I d={showPast ? P.chevD : P.chevR} size={10} />
          <span>Past discussions ({past})</span>
        </div>
      )}
      {showPast && (pastList ?? []).map((s) => (
        <div key={s.id} onClick={() => onOpen(s.slug)} title={s.outcome || s.name} style={{ ...row(current === s.slug), paddingLeft: 44 }}>
          <span style={{ fontSize: 10.5, flex: 'none', opacity: 0.7 }}>{subIcon(s.purpose)}</span>
          <span style={{ flex: 1, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-faint)' }}>{s.name}</span>
          <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>{agoText(s.closedAt)}</span>
        </div>
      ))}
    </div>
  );
}
