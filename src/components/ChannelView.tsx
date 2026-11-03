/** The channel main pane (docs/group-chat.md): header with tabs, the message
 *  list with author chips / system lines / live agent replies, the thread
 *  panel, approval cards addressed to this person, the composer with
 *  @mention autocomplete and drag-drop uploads into the channel folder, the
 *  Meetings tab (list and calendar, docs/meetings.md), the Files tab, and
 *  channel settings (topic, members, budget, archive). */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad } from '../store';
import { api, type Agent, type ChannelDetail, type ChannelFile, type ChannelMember, type ChannelMessage, type OrgDecision, type OrgMeeting, type WorkspaceEvent } from '../lib/api';
import { applyMention, decisionRefs, groupThreads, initials, linkCardSubId, liveInThread, meetingCommandHint, mentionQuery, mentionSuggestions, messageMentionSpans, subIcon, type MentionCandidate } from '../lib/channels';
import { Markdown, type RefResolver } from '../lib/md';
import { keyPrefix, normalizeTaskKey, unitKeyPrefixes } from '../lib/task-keys';
import { safeJsonParse } from '../lib/util';
import { fmtUsd } from '../lib/pricing';
import { MEETING_KIND_TITLES, minutesMeetingId, parseMinutes } from '../lib/org';
import { AUDIENCE_COLOR, audienceLabel } from '../lib/org2';
import { FollowToggle } from './FollowToggle';
import { MeetingsBoard } from './MeetingsBoard';
import { MeetingRoom, ProposalActions } from './MeetingRoom';
import { meetingComposerHint, openMeetingView, parseRoom } from '../lib/meetings';
import { StartDiscussionForm, SubBreadcrumb, SubChannelCard, SubStatusBar } from './SubChannels';

const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const ghostBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 };
const field: React.CSSProperties = { width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none' };
const smallBtn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };

type Tab = 'messages' | 'meetings' | 'files' | 'settings';
interface LiveReply { liveId: string; agentId: string; threadRootId: string | null; replyRootId?: string; text: string; done: boolean }
interface Approval { sessionId: string; callId: string; tool: string; input: Record<string, unknown>; agentId: string; threadRootId: string | null; forName: string }

function timeOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The author chip: an agent's gradient + emoji, a human's initials, or the
 *  system glyph. */
export function Chip({ kind, agent, name, size = 28 }: { kind: 'agent' | 'human' | 'system'; agent?: Agent; name: string; size?: number }) {
  const base: React.CSSProperties = { width: size, height: size, borderRadius: Math.round(size * 0.3), flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.5 };
  if (kind === 'agent') return <div title={name} style={{ ...base, background: agent ? grad(agent.colors) : 'linear-gradient(135deg,var(--accent),var(--blue))' }}>{agent?.emoji ?? '🤖'}</div>;
  if (kind === 'system') return <div title="system" style={{ ...base, background: 'var(--panel-2)', color: 'var(--text-faint)' }}><I d={P.sysLines} size={size * 0.5} /></div>;
  return <div title={name} style={{ ...base, background: 'var(--accent-dim)', color: 'var(--text)', fontWeight: 700, fontSize: size * 0.4, letterSpacing: '.3px' }}>{initials(name)}</div>;
}

/** Resolved `#decision:` chips, per workspace and id (or prefix). */
const decisionCache = new Map<string, Promise<OrgDecision | null>>();

export function ChannelView() {
  const app = useApp();
  const slug = app.currentChannel;
  const wsId = app.workspaceId;
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [page, setPage] = useState<{ messages: ChannelMessage[]; replies: Record<string, { count: number; lastAt: string }>; hasMore: boolean }>({ messages: [], replies: {}, hasMore: false });
  const [thread, setThread] = useState<string | null>(null);
  const [threadMsgs, setThreadMsgs] = useState<ChannelMessage[]>([]);
  const [tab, setTab] = useState<Tab>('messages');
  const [live, setLive] = useState<LiveReply[]>([]);
  const [typing, setTyping] = useState<Record<string, { agentId: string; threadRootId: string | null; replyRootId?: string }>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [files, setFiles] = useState<ChannelFile[]>([]);
  // Meetings held in this channel (docs/group-chat.md §8): the thread root
  // each one is gets a header; the minutes message a structured card.
  const [meetings, setMeetings] = useState<OrgMeeting[]>([]);
  // "Start a discussion" (docs/group-chat.md §9): from the header, a message or a thread.
  const [discuss, setDiscuss] = useState<{ origin: string | null; title: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const focusRef = useRef<string | null>(null);

  // A closed sub-channel is not in the rail's list: its own detail stands in (docs/group-chat.md §9).
  const listed = useMemo(() => app.channels.find((c) => c.slug === slug) ?? null, [app.channels, slug]);
  const channel = useMemo(() => (detail && detail.slug === slug ? { ...(listed ?? {}), ...detail } : listed), [listed, detail, slug]);
  const isSub = channel?.channelKind === 'sub';
  const closed = isSub && channel?.status === 'closed';
  const agentOf = useCallback((id: string) => app.agents.find((a) => a.id === id), [app.agents]);
  const members = useMemo(() => detail?.members ?? [], [detail]);
  const nameOf = useCallback((kind: string, id: string): string => {
    if (kind === 'system') return 'system';
    const m = members.find((x) => x.memberKind === kind && x.memberId === id);
    if (m) return m.name;
    return kind === 'agent' ? (agentOf(id)?.name ?? 'agent') : app.nameOf(id);
  }, [members, agentOf, app]);
  const me = app.me?.actorId ?? '';
  // Units (docs/group-chat.md §7): the goals a message references, and the unit this channel belongs to.
  const goals = useMemo(() => new Map((app.wsOrg?.org?.goals ?? []).map((g) => [g.id, g])), [app.wsOrg]);
  const rootUnitId = app.wsOrg?.units?.[0]?.id ?? null;
  const openGoal = (goalId: string) => {
    const g = goals.get(goalId);
    app.setOrgUnitId(g?.unitId && g.unitId !== rootUnitId ? g.unitId : null);
    app.setOrgPane('goals'); // opens Direction › Goals
    app.setMobileDetail(true);
  };
  const openUnitBoard = () => {
    if (!detail?.unit) return;
    app.setOrgUnitId(detail.unit.id === rootUnitId ? null : detail.unit.id);
    app.setOrgPane('board'); // opens Operations › Board
    app.setMobileDetail(true);
  };

  const load = useCallback(async () => {
    if (!wsId || !slug) return;
    const [d, p] = await Promise.all([api.channel(wsId, slug).catch(() => null), api.channelMessages(wsId, slug).catch(() => ({ messages: [], replies: {}, hasMore: false }))]);
    setDetail(d);
    setPage(p);
    void api.markChannelRead(wsId, slug).then(() => app.refreshChannels()).catch(() => {});
  }, [wsId, slug, app]);

  // channel switch: reset, load, and honour a deep-linked message
  useEffect(() => {
    setThread(null); setThreadMsgs([]); setLive([]); setTyping({}); setApprovals([]); setTab('messages');
    stickRef.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, slug]);

  useEffect(() => {
    if (!thread || !wsId || !slug) { setThreadMsgs([]); return; }
    void api.channelMessages(wsId, slug, { thread }).then((p) => setThreadMsgs(p.messages)).catch(() => setThreadMsgs([]));
  }, [thread, wsId, slug]);

  useEffect(() => {
    if (tab !== 'files' || !wsId || !slug) return;
    void api.channelFiles(wsId, slug).then(setFiles).catch(() => setFiles([]));
  }, [tab, wsId, slug]);

  // Meetings of this channel: loaded with the channel, re-polled while one runs
  // (the event bus carries no meeting events yet).
  const orgChannel = Boolean(detail?.orgMode && app.companiesEnabled);
  const channelId = channel?.id ?? null;
  useEffect(() => {
    if (!orgChannel || !wsId || !channelId) { setMeetings([]); return; }
    let stop = false;
    // Held here, or called here and run in a sub-channel of this channel (docs/group-chat.md §9).
    const load = () => api.orgMeetings(wsId).then((list) => { if (!stop) setMeetings(list.filter((m) => m.channelId === channelId || m.parentChannelId === channelId)); }).catch(() => {});
    void load();
    const t = setInterval(() => { void load(); }, 20_000);
    return () => { stop = true; clearInterval(t); };
  }, [orgChannel, wsId, channelId, page.messages.length]);
  const meetingByRoot = useMemo(() => new Map(meetings.filter((m) => m.threadRootId && m.channelId === channelId).map((m) => [m.threadRootId!, m])), [meetings, channelId]);
  // The meeting this sub-channel holds: its whole stream is the meeting.
  const subMeeting = useMemo(() => (isSub ? meetings.find((m) => m.channelId === channelId) ?? null : null), [isSub, meetings, channelId]);
  const meetingOfSub = useCallback((subId: string) => meetings.find((m) => m.channelId === subId) ?? null, [meetings]);
  // A room changed (docs/meetings.md "During"): the server says which; take the fresh row.
  const upsertMeeting = useCallback((m: OrgMeeting) => setMeetings((l) => (l.some((x) => x.id === m.id) ? l.map((x) => (x.id === m.id ? m : x)) : [...l, m])), []);
  const cancelMeeting = async (m: OrgMeeting) => {
    if (!confirm(`End ${m.title || 'the meeting'} now? The minutes are written from what was proposed so far.`)) return;
    try { await api.cancelOrgMeeting(wsId, m.id); app.showToast('Meeting cancelled'); setMeetings((l) => l.map((x) => (x.id === m.id ? { ...x, status: 'cancelled' } : x))); } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'could not cancel'); }
  };
  const openDecision = useCallback((id: string) => { app.setOrgFocus({ kind: 'decision', id }); app.setOrgUnitId(null); app.setOrgPane('decisions'); app.setMobileDetail(true); }, [app]);
  // `#decision:<id>` chips (docs/group-chat.md §8) resolve through
  // GET …/chat/decisions/:id (id or unique prefix): titles are fetched once per
  // id for the messages on screen and read synchronously by the Markdown
  // `refs` resolver, which draws #goal:/#decision:/#task: chips inline.
  const [decisionNames, setDecisionNames] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!wsId) return;
    const ids = new Set<string>();
    for (const m of [...page.messages, ...threadMsgs]) for (const id of decisionRefs(m.text)) if (!(id in decisionNames)) ids.add(id);
    if (ids.size === 0) return;
    let on = true;
    for (const id of ids) {
      const key = `${wsId}:${id}`;
      if (!decisionCache.has(key)) decisionCache.set(key, api.chatDecision(wsId, id).catch(() => null));
      void decisionCache.get(key)!.then((d) => { if (on) setDecisionNames((n) => (id in n ? n : { ...n, [id]: d ? d.title : null })); });
    }
    return () => { on = false; };
  }, [wsId, page.messages, threadMsgs, decisionNames]);
  const orgPrefixes = useMemo(() => unitKeyPrefixes(app.wsOrg?.units ?? []), [app.wsOrg]);
  const refs = useCallback<RefResolver>((kind, id, bare) => {
    if (kind === 'goal') {
      const g = goals.get(id) ?? [...goals.values()].find((x) => x.id.startsWith(id));
      return { label: g?.title ?? `goal ${id.slice(0, 8)}`, onClick: () => openGoal(g?.id ?? id) };
    }
    if (kind === 'decision') return { label: decisionNames[id] ?? `decision ${id.slice(0, 8)}`, onClick: () => openDecision(id) };
    if (kind === 'task') {
      // Task keys (docs/tasks-keys.md): a known org board prefix opens the
      // board drawer, an agent's prefix its Tasks tab; anything else stays text.
      const key = normalizeTaskKey(id);
      if (key) {
        const p = keyPrefix(key);
        if (orgPrefixes.has(p) && app.companiesEnabled) return { label: key, onClick: () => app.openOrgTask(key) };
        const owner = app.agents.find((a) => (a.taskKey ?? '').toUpperCase() === p);
        if (owner) return { label: key, onClick: () => app.openAgent(owner.id, 'Tasks') };
        if (bare) return null;
      }
      if (bare) return null;
      if (orgChannel) return { label: key ?? `task ${id.slice(0, 8)}`, onClick: () => app.openOrgTask(id) };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, decisionNames, orgChannel, openDecision, rootUnitId, app, orgPrefixes]);

  // live events for this channel
  useEffect(() => {
    if (!channel) return;
    const id = channel.id;
    return app.onWorkspaceEvent((ev: WorkspaceEvent) => {
      if (!('channelId' in ev) || ev.channelId !== id) return;
      if (ev.type === 'channel_message') {
        const m = ev.message;
        if (m.threadRootId) {
          setPage((p) => ({ ...p, replies: { ...p.replies, [m.threadRootId!]: { count: (p.replies[m.threadRootId!]?.count ?? 0) + (p.messages.some((x) => x.id === m.id) ? 0 : 1), lastAt: m.createdAt } } }));
          setThreadMsgs((t) => (t.length && t[0].id === m.threadRootId && !t.some((x) => x.id === m.id) ? [...t, m] : t));
        } else {
          setPage((p) => (p.messages.some((x) => x.id === m.id) ? { ...p, messages: p.messages.map((x) => (x.id === m.id ? m : x)) } : { ...p, messages: [...p.messages, m] }));
          setThreadMsgs((t) => (t.length && t[0].id === m.id ? [m, ...t.slice(1)] : t));
        }
        if (m.authorKind !== 'system') void api.markChannelRead(wsId, channel.slug, m.id).then(() => app.refreshChannels()).catch(() => {});
      } else if (ev.type === 'channel_typing') {
        setTyping((t) => { const n = { ...t }; if (ev.on) n[ev.liveId] = { agentId: ev.agentId, threadRootId: ev.threadRootId, replyRootId: ev.replyRootId }; else delete n[ev.liveId]; return n; });
        if (!ev.on) setLive((l) => l.filter((x) => x.liveId !== ev.liveId));
      } else if (ev.type === 'channel_stream') {
        setLive((l) => {
          const i = l.findIndex((x) => x.liveId === ev.liveId);
          if (ev.done) return i < 0 ? l : l.filter((x) => x.liveId !== ev.liveId);
          if (i < 0) return [...l, { liveId: ev.liveId, agentId: ev.agentId, threadRootId: ev.threadRootId, replyRootId: ev.replyRootId, text: ev.delta, done: false }];
          return l.map((x, j) => (j === i ? { ...x, text: x.text + ev.delta } : x));
        });
      } else if (ev.type === 'channel_approval') {
        if (ev.forActor === me) setApprovals((a) => [...a.filter((x) => x.callId !== ev.callId), { sessionId: ev.sessionId, callId: ev.callId, tool: ev.tool, input: ev.input, agentId: ev.agentId, threadRootId: ev.threadRootId, forName: ev.forName }]);
      } else if (ev.type === 'meeting_update') {
        void api.orgMeeting(wsId, ev.meetingId).then(upsertMeeting).catch(() => {});
      } else if (ev.type === 'channel_update') {
        void api.channel(wsId, channel.slug).then(setDetail).catch(() => {});
      }
    });
  }, [channel, app, wsId, me, upsertMeeting]);

  // autoscroll while near the bottom; deep-linked focus scrolls once
  useEffect(() => {
    if (app.channelFocus) focusRef.current = app.channelFocus;
    if (!stickRef.current && !focusRef.current) return;
    requestAnimationFrame(() => {
      if (focusRef.current) {
        const target = page.messages.find((m) => m.id === focusRef.current);
        const el = document.getElementById(`msg-${focusRef.current}`);
        if (el) { el.scrollIntoView({ block: 'center' }); focusRef.current = null; app.setChannelFocus(null); return; }
        // the message is a reply: open its thread, which renders it
        if (!target && page.messages.length > 0) {
          const inThread = threadMsgs.find((m) => m.id === focusRef.current);
          if (!inThread) {
            void api.channelMessages(wsId, slug ?? '', { thread: focusRef.current }).then((p) => { if (p.messages[0]) setThread(p.messages[0].id); }).catch(() => { focusRef.current = null; app.setChannelFocus(null); });
          }
          return;
        }
      }
      const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight;
    });
  }, [page.messages, live, typing, threadMsgs, app, wsId, slug]);

  const decide = async (a: Approval, allow: boolean) => {
    setApprovals((list) => list.filter((x) => x.callId !== a.callId));
    try { await api.approve(a.sessionId, a.callId, allow ? 'allow-once' : 'deny'); } catch { app.showToast('approval failed'); }
  };

  const makeTask = async (m: ChannelMessage) => {
    if (!wsId || !slug) return;
    try {
      const res = await api.makeChannelTask(wsId, slug, m.id);
      app.showToast(`Task [${res.task.id.slice(0, 8)}] created on the ${res.kind === 'org' ? 'company board' : 'kanban'}`);
    } catch (err) { app.showToast(err instanceof Error ? err.message : 'could not make a task'); }
  };

  const openTask = (m: ChannelMessage) => {
    if (!m.taskId) return;
    // Organisation mode: the board pane under the Workspace section (item 16).
    if (detail?.orgMode && app.companiesEnabled) { app.openOrgTask(m.taskId); return; }
    const agent = m.authorKind === 'agent' ? m.authorId : members.find((x) => x.memberKind === 'agent')?.memberId;
    if (agent) app.openAgent(agent, 'Tasks');
  };

  if (!slug || !channel) {
    return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 14 }}>Pick a channel in the rail.</div>;
  }

  const groups = groupThreads(page.messages, page.replies);
  const topLive = live.filter((l) => !l.threadRootId);
  const topTyping = Object.values(typing).filter((t) => !t.threadRootId && !live.some((l) => l.agentId === t.agentId && !l.threadRootId));
  const mentionables: MentionCandidate[] = members.map((m) => ({ kind: m.memberKind, id: m.memberId, name: m.name }));

  const renderMessage = (m: ChannelMessage, opts: { replies?: number; lastReplyAt?: string | null; inThread?: boolean } = {}) => {
    const cardOf = m.authorKind === 'system' ? linkCardSubId(m.attachments) : null;
    if (cardOf) {
      return (
        <div key={m.id} id={`msg-${m.id}`} style={{ display: 'flex', gap: 11, padding: '2px 0' }}>
          <SubChannelCard subId={cardOf} text={m.text} meeting={meetingOfSub(cardOf)} onOpen={(s) => app.openChannel(s)} />
        </div>
      );
    }
    if (m.authorKind === 'system') {
      return (
        <div key={m.id} id={`msg-${m.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', fontSize: 11.5, color: 'var(--text-dim)' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 20, padding: '3px 11px', maxWidth: '80%' }}><I d={P.sysLines} size={12} />{m.text}</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
        </div>
      );
    }
    const agent = m.authorKind === 'agent' ? agentOf(m.authorId) : undefined;
    const name = nameOf(m.authorKind, m.authorId);
    const atts = safeJsonParse<Array<{ path: string; kind: string }>>(m.attachments, []);
    const mine = m.authorKind === 'human' && (m.authorId === me || (!app.me && m.authorId));
    const meeting = meetingByRoot.get(m.id);
    const minutesOf = minutesMeetingId(atts);
    return (
      <div key={m.id} id={`msg-${m.id}`} className="chan-msg" style={{ display: 'flex', gap: 11, padding: '7px 10px', margin: '2px -10px', borderRadius: 10, animation: 'msgIn .18s ease', background: focusRef.current === m.id ? 'var(--accent-dim)' : undefined, borderLeft: meeting ? `3px solid ${meeting.status === 'running' ? 'var(--green)' : 'var(--border)'}` : undefined }}>
        <Chip kind={m.authorKind} agent={agent} name={name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {meeting && <MeetingHeader meeting={meeting} inThread={Boolean(opts.inThread) || isSub} onOpen={() => setThread(m.id)} onExpand={() => openMeetingView(wsId, meeting.id)} onCancel={() => void cancelMeeting(meeting)} />}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: mine ? 'var(--accent-hi)' : 'var(--text)' }}>{name}{mine ? ' (you)' : ''}</span>
            {m.authorKind === 'agent' && <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px' }}>agent{m.unprompted === 1 ? ' · unprompted' : ''}</span>}
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>{timeOf(m.createdAt)}</span>
            <span className="chan-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
              {!opts.inThread && !closed && <button onClick={() => setThread(m.id)} title="Reply in thread" style={ghostBtn}><I d={P.chat} size={13} />Reply</button>}
              {!isSub && !opts.inThread && <button onClick={() => setDiscuss({ origin: m.id, title: discussTitle(m.text) })} title="Start a discussion from this message: a sub-channel with its own space" style={ghostBtn}>🗣 Discuss</button>}
              <button onClick={() => void makeTask(m)} title="Make a task from this message" style={ghostBtn}><I d={P.board} size={13} />Make task</button>
            </span>
          </div>
          {minutesOf ? <MinutesCard wsId={wsId} meetingId={minutesOf} fallback={m.text} refs={refs} onDecision={openDecision} onTask={(id) => app.openOrgTask(id)} /> : <div style={{ fontSize: 14, lineHeight: 1.6, marginTop: 2 }}><Markdown text={m.text} refs={refs} compact mentions={(s) => messageMentionSpans(s, m.mentions, mentionables).map((x) => ({ start: x.start, end: x.end, kind: x.member.kind }))} /></div>}
          {opts.inThread && thread && meetingByRoot.get(thread) && m.authorKind === 'agent' && <ProposalSlot wsId={wsId} meeting={meetingByRoot.get(thread)!} messageId={m.id} onChanged={upsertMeeting} text={m.text} />}
          {!opts.inThread && subMeeting && m.authorKind === 'agent' && <ProposalSlot wsId={wsId} meeting={subMeeting} messageId={m.id} onChanged={upsertMeeting} text={m.text} />}
          {atts.filter((a) => a.kind !== 'minutes').length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {atts.filter((a) => a.kind !== 'minutes').map((a, i) => (
                <button key={i} onClick={() => app.openFile({ kind: 'workspace', id: wsId }, a.path)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 9px', fontSize: 11.5, color: 'var(--text-dim)', cursor: 'pointer', ...mono }}>
                  {a.kind === 'image' ? '▣' : '▤'} {a.path.split('/').pop()}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 5 }}>
            {m.taskId && (
              <button onClick={() => openTask(m)} title="Open on the board" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--accent-dim)', border: 'none', color: 'var(--text)', borderRadius: 7, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                <I d={P.board} size={12} />task {m.taskKey ?? m.taskId.slice(0, 8)}
              </button>
            )}
            {!opts.inThread && (opts.replies ?? 0) > 0 && (
              <button onClick={() => setThread(m.id)} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                {opts.replies} {opts.replies === 1 ? 'reply' : 'replies'}{opts.lastReplyAt ? <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · {timeOf(opts.lastReplyAt)}</span> : null}
              </button>
            )}
            {!opts.inThread && thread !== m.id && (() => {
              // An agent tagged inside this thread is replying there: say so
              // in the main list, where its live reply is not drawn.
              const inThread = [...new Set(Object.values(typing).filter((t) => t.threadRootId === m.id).map((t) => agentOf(t.agentId)?.name ?? 'An agent'))];
              return inThread.length > 0 ? (
                <button onClick={() => setThread(m.id)} style={{ background: 'none', border: 'none', color: 'var(--green)', fontSize: 12, cursor: 'pointer', padding: 0 }}>
                  {inThread.join(', ')} {inThread.length === 1 ? 'is' : 'are'} replying in the thread…
                </button>
              ) : null;
            })()}
          </div>
        </div>
      </div>
    );
  };

  const renderLive = (l: LiveReply) => {
    const agent = agentOf(l.agentId);
    return (
      <div key={l.liveId} style={{ display: 'flex', gap: 11, padding: '7px 0' }}>
        <Chip kind="agent" agent={agent} name={agent?.name ?? 'agent'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ fontWeight: 600, fontSize: 13 }}>{agent?.name ?? 'agent'}</span><span style={{ fontSize: 10.5, color: 'var(--green)' }}>replying…</span></div>
          <div style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{l.text}<span style={{ animation: 'blink 1s infinite', color: 'var(--accent)' }}>▋</span></div>
        </div>
      </div>
    );
  };

  const renderTyping = (t: { agentId: string }) => {
    const agent = agentOf(t.agentId);
    return (
      <div key={`typing-${t.agentId}`} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', fontSize: 12, color: 'var(--text-dim)' }}>
        <Chip kind="agent" agent={agent} name={agent?.name ?? 'agent'} size={22} />
        <span>{agent?.name ?? 'An agent'} is thinking</span>
        <span style={{ display: 'inline-flex', gap: 3 }}>{[0, 1, 2].map((i) => <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-faint)', animation: `pulse 1.2s ${i * 0.2}s infinite` }} />)}</span>
      </div>
    );
  };

  const renderApproval = (a: Approval) => {
    const agent = agentOf(a.agentId);
    const arg = typeof a.input?.path === 'string' ? a.input.path : typeof a.input?.url === 'string' ? a.input.url : JSON.stringify(a.input).slice(0, 120);
    return (
      <div key={a.callId} style={{ margin: '10px 0', border: '1px solid var(--amber)', borderRadius: 12, overflow: 'hidden', background: 'var(--panel)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', background: 'var(--panel-2)' }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
          <span style={{ fontSize: 12.5 }}><b>{agent?.name ?? 'An agent'}</b> asks you to approve <span style={{ ...mono, fontWeight: 600 }}>{a.tool}</span></span>
          <span style={{ ...mono, fontSize: 12, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{arg}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '9px 13px', alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', flex: 1 }}>Only you see this card — mentions carry no approval authority.</span>
          <button onClick={() => void decide(a, true)} style={{ ...smallBtn, background: 'var(--accent)', color: '#fff', border: 'none' }}>Allow once</button>
          <button onClick={() => void decide(a, false)} style={smallBtn}>Deny</button>
        </div>
      </div>
    );
  };

  const threadRoot = thread ? (threadMsgs[0] ?? page.messages.find((m) => m.id === thread)) : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <style>{'.chan-msg .chan-actions{opacity:0;transition:opacity .12s}.chan-msg:hover .chan-actions{opacity:1}'}</style>
      <header style={{ flex: 'none', borderBottom: '1px solid var(--border)', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 11, background: 'var(--panel)', flexWrap: app.stacked ? 'wrap' : undefined }}>
        {app.stacked && (
          <button onClick={() => app.setMobileChatOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex', flex: 'none' }}><I d={P.chevL} size={20} /></button>
        )}
        <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--panel-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontWeight: 700, color: 'var(--accent-hi)' }}>{isSub ? subIcon(channel.purpose) : '#'}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {isSub
              ? <SubBreadcrumb detail={detail} channel={channel} onParent={(s) => app.openChannel(s)} />
              : <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '-.2px' }}>#{channel.slug}</div>}
            {channel.kind === 'private' && <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px' }}>private</span>}
            {detail?.unit && (
              <button onClick={openUnitBoard} title="Open this unit's board" style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 6px', cursor: 'pointer' }}>
                {detail.unit.id === rootUnitId ? 'Company channel' : `Unit channel · ${detail.unit.name}`}
              </button>
            )}
            {channel.archivedAt && <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 4, padding: '0 5px' }}>archived</span>}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isSub ? `#${channel.slug}${channel.topic ? ` · ${channel.topic}` : ''}` : channel.topic || 'No topic yet'} · {members.filter((m) => m.memberKind === 'agent').length} agents · {members.filter((m) => m.memberKind === 'human').length} people
          </div>
        </div>
        {isSub && <FollowToggle wsId={wsId} targetKind="channel" targetId={channel.id} />}
        {!isSub && !channel.archivedAt && (
          <button onClick={() => setDiscuss({ origin: null, title: '' })} title="Start a discussion: a temporary sub-channel; this channel keeps one card" style={{ ...smallBtn, flex: 'none', padding: app.stacked ? '5px 7px' : '5px 10px' }}>🗣{app.stacked ? '' : ' Discussion'}</button>
        )}
        <div style={{ display: 'flex', gap: 4, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: 3 }}>
          {(['messages', 'meetings', 'files', 'settings'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ background: tab === t ? 'var(--accent)' : 'none', color: tab === t ? '#fff' : 'var(--text-dim)', border: 'none', borderRadius: 7, padding: app.stacked ? '5px 7px' : '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize' }}>{t}</button>
          ))}
        </div>
      </header>
      {isSub && <SubStatusBar wsId={wsId} channel={channel} onChanged={() => void load()} />}
      {discuss && slug && (
        <StartDiscussionForm wsId={wsId} slug={slug} members={members} originMessageId={discuss.origin} defaultTitle={discuss.title}
          onCancel={() => setDiscuss(null)} onDone={(c) => { setDiscuss(null); app.openChannel(c.slug); }} />
      )}

      {tab === 'messages' && (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} style={{ flex: 1, overflowY: 'auto', padding: '16px 0 8px' }}>
              <div style={{ maxWidth: 820, margin: '0 auto', padding: '0 24px' }}>
                {subMeeting && <div style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}><MeetingRoom wsId={wsId} meeting={subMeeting} me={me} name={(kind, id) => nameOf(kind, id)} onChanged={upsertMeeting} /></div>}
                {page.hasMore && (
                  <button onClick={() => void api.channelMessages(wsId, slug, { before: page.messages[0]?.id }).then((p) => setPage((cur) => ({ messages: [...p.messages, ...cur.messages], replies: { ...p.replies, ...cur.replies }, hasMore: p.hasMore })))} style={{ ...smallBtn, display: 'block', margin: '0 auto 14px' }}>Load earlier messages</button>
                )}
                {groups.length === 0 && topLive.length === 0 && (
                  <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 13, padding: '60px 0' }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{isSub ? channel.name : `Welcome to #${channel.slug}`}</div>
                    <div style={{ marginTop: 6, lineHeight: 1.55, maxWidth: 420, margin: '6px auto 0' }}>{isSub ? 'A discussion with its own space: the parent channel only shows its card. Close it with an outcome when it is settled.' : 'People and agents share this channel. Mention an agent with @name to bring it in; agents allowed to speak unprompted join when a message is clearly theirs.'}</div>
                  </div>
                )}
                {groups.map((g) => renderMessage(g.root, { replies: g.replyCount, lastReplyAt: g.lastReplyAt }))}
                {topLive.map(renderLive)}
                {topTyping.map(renderTyping)}
                {approvals.filter((a) => !a.threadRootId || !thread).map(renderApproval)}
              </div>
            </div>
            {closed
              ? <div role="status" style={{ flex: 'none', padding: '12px 24px 18px', textAlign: 'center', fontSize: 12.5, color: 'var(--text-faint)' }}>{channel.purpose === 'meeting' ? 'The meeting has ended; its stream is kept read-only.' : 'Closed — read-only. Reopen it above to continue.'}</div>
              : <Composer wsId={wsId} slug={slug} folder={channel.folder} mentionables={mentionables} orgMode={orgChannel && !isSub}
                  placeholder={subMeeting?.status === 'running' ? (parseRoom(subMeeting.room).present.includes(me) ? 'Speak — heard at the next turn; "stop" ends the meeting' : 'Write — read at the next round (Join to be heard at the next turn)') : isSub ? `Message ${channel.name}  ·  @ to mention` : `Message #${channel.slug}  ·  @ to mention an agent or a person${orgChannel ? '  ·  /meeting to start one' : ''}`}
                  note={subMeeting?.status === 'running' ? 'A meeting is running here: messages are heard at the next round (the next turn once you join); "stop" ends it.' : undefined} />}
          </div>
          {thread && threadRoot && (
            <aside style={{ width: app.stacked ? '100%' : 380, flex: 'none', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', position: app.stacked ? 'absolute' : 'relative', inset: app.stacked ? 0 : undefined, zIndex: app.stacked ? 20 : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>Thread</span>
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>#{channel.slug}</span>
                {!isSub && <button onClick={() => setDiscuss({ origin: thread, title: discussTitle(threadRoot.text) })} title="Move this thread into a discussion of its own" style={ghostBtn}>🗣 Discuss</button>}
                <div style={{ marginLeft: 'auto' }}><FollowToggle wsId={wsId} targetKind="thread" targetId={thread} /></div>
                <button onClick={() => setThread(null)} style={ghostBtn}><I d={P.x} size={14} /></button>
              </div>
              {meetingByRoot.get(thread) && <MeetingRoom wsId={wsId} meeting={meetingByRoot.get(thread)!} me={me} name={(kind, id) => nameOf(kind, id)} onChanged={upsertMeeting} />}
              <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
                {renderMessage(threadRoot, { inThread: true })}
                <div style={{ height: 1, background: 'var(--border-soft)', margin: '8px 0' }} />
                {threadMsgs.slice(1).map((m) => renderMessage(m, { inThread: true }))}
                {live.filter((l) => liveInThread(l, thread)).map(renderLive)}
                {Object.values(typing).filter((t) => liveInThread(t, thread) && !live.some((l) => l.agentId === t.agentId && liveInThread(l, thread))).map(renderTyping)}
                {approvals.filter((a) => a.threadRootId === thread).map(renderApproval)}
              </div>
              {!closed && <Composer wsId={wsId} slug={slug} folder={channel.folder} mentionables={mentionables} threadRootId={thread} compact orgMode={orgChannel}
                {...meetingComposerHint(meetingByRoot.get(thread), me)} />}
            </aside>
          )}
        </div>
      )}

      {tab === 'meetings' && <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', minWidth: 0 }}><MeetingsBoard wsId={wsId} channel={slug} startIn={orgChannel ? { id: channel.id, slug } : null} /></div>}
      {tab === 'files' && <FilesTab wsId={wsId} slug={slug} folder={channel.folder} files={files} reload={() => void api.channelFiles(wsId, slug).then(setFiles).catch(() => {})} />}
      {tab === 'settings' && detail && <SettingsTab detail={detail} onChange={(d) => { setDetail(d); void app.refreshChannels(); }} />}
    </div>
  );
}

/** A discussion's default title from the message it starts from: its first line, plain. */
function discussTitle(text: string): string {
  const line = (text.split('\n').map((x) => x.trim()).find(Boolean) ?? '').replace(/[*_`#>~]/g, '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

// ---- composer ----

export function Composer({ wsId, slug, folder, mentionables, threadRootId, placeholder, compact, note, orgMode }: {
  wsId: string; slug: string; folder: string; mentionables: MentionCandidate[]; threadRootId?: string | null; placeholder: string; compact?: boolean;
  /** One line under the box (a running meeting reads replies at the next round). */
  note?: string;
  /** Organization mode: the `/meeting` command is available here (docs/group-chat.md §8). */
  orgMode?: boolean;
}) {
  const app = useApp();
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Array<{ path: string; kind: string }>>([]);
  const [menu, setMenu] = useState<{ start: number; filter: string } | null>(null);
  const [sel, setSel] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const suggestions = menu ? mentionSuggestions(menu.filter, mentionables) : [];
  const meetingHint = orgMode && !threadRootId ? meetingCommandHint(text) : null;

  const onChange = (v: string, caret: number) => {
    setText(v);
    setMenu(mentionQuery(v, caret));
    setSel(0);
  };
  const pick = (c: MentionCandidate) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = applyMention(text, menu?.start ?? 0, caret, c.name);
    setText(next.text);
    setMenu(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(next.caret, next.caret); });
  };
  const upload = async (files: FileList | File[]) => {
    for (const file of Array.from(files).slice(0, 8)) {
      if (file.size > 5_000_000) { app.showToast(`${file.name} is too large (5MB max)`); continue; }
      const b64 = btoa(new Uint8Array(await file.arrayBuffer()).reduce((acc, b) => acc + String.fromCharCode(b), ''));
      const path = `${folder.replace(/^\/+|\/+$/g, '')}/${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      try {
        await api.wsPutFile(wsId, path, b64, file.type || undefined);
        setAtts((a) => [...a, { path, kind: file.type.startsWith('image/') ? 'image' : 'text' }]);
      } catch { app.showToast(`upload of ${file.name} failed`); }
    }
  };
  const send = async () => {
    const t = text.trim();
    if ((!t && atts.length === 0) || sending) return;
    setSending(true);
    try {
      await api.postChannelMessage(wsId, slug, { text: t || 'See the attached file.', threadRootId: threadRootId ?? null, attachments: atts });
      setText(''); setAtts([]); setMenu(null);
      if (inputRef.current) inputRef.current.style.height = 'auto';
    } catch (err) {
      app.showToast(err instanceof Error ? err.message : 'could not post');
    } finally { setSending(false); }
  };
  return (
    <div style={{ flex: 'none', padding: compact ? '0 12px 12px' : '0 24px 18px' }}>
      <div style={{ maxWidth: compact ? undefined : 820, margin: '0 auto' }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void upload(e.dataTransfer.files); }}
          style={{ position: 'relative', border: `1px solid ${dragOver ? 'var(--green)' : menu ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 14, background: 'var(--panel)', boxShadow: 'var(--shadow)' }}>
          <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
          {menu && suggestions.length > 0 && (
            <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 320, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', overflow: 'hidden', zIndex: 30, animation: 'msgIn .12s' }}>
              <div style={{ padding: '7px 12px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', borderBottom: '1px solid var(--border-soft)' }}>Mention</div>
              <div style={{ maxHeight: 240, overflowY: 'auto', padding: 5 }}>
                {suggestions.map((c, i) => {
                  const agent = c.kind === 'agent' ? app.agents.find((a) => a.id === c.id) : undefined;
                  return (
                    <div key={`${c.kind}:${c.id}`} onMouseDown={(e) => { e.preventDefault(); pick(c); }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', background: i === sel ? 'var(--accent-dim)' : 'none' }}>
                      <Chip kind={c.kind} agent={agent} name={c.name} size={22} />
                      <span style={{ flex: 1, fontSize: 13 }}>{c.name}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{c.kind}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {meetingHint && (
            <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px 0', fontSize: 11.5, color: 'var(--text-dim)' }}>
              <I d={P.slash} size={12} />
              <span style={{ ...mono, color: 'var(--text)' }}>/meeting [planning|standup|weekly_review|retro|board] [#unit] [agenda…]</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {meetingHint.complete ? `starts a ${MEETING_KIND_TITLES[meetingHint.kind]?.toLowerCase() ?? 'meeting'} ${meetingHint.unitSlug ? `in #${meetingHint.unitSlug}` : 'here'}${meetingHint.agenda ? ` — "${meetingHint.agenda.slice(0, 60)}"` : ', agenda from the board or your text'}; Enter sends` : 'starts a meeting in this channel; attendees take one turn per round'}
              </span>
            </div>
          )}
          {atts.length > 0 && (
            <div style={{ display: 'flex', gap: 7, padding: '11px 13px 0', flexWrap: 'wrap' }}>
              {atts.map((a) => (
                <div key={a.path} style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', fontSize: 11.5, color: 'var(--text-dim)', ...mono }}>
                  {a.kind === 'image' ? '▣' : '▤'} {a.path.split('/').pop()}
                  <button onClick={() => setAtts((l) => l.filter((x) => x.path !== a.path))} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'flex' }}><I d={P.x} size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => { const el = e.target; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; onChange(el.value, el.selectionStart ?? el.value.length); }}
            onKeyDown={(e) => {
              if (menu && suggestions.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pick(suggestions[sel]); return; }
                if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
            }}
            placeholder={placeholder}
            rows={1}
            style={{ width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'none', color: 'var(--text)', fontSize: 14, lineHeight: 1.5, padding: compact ? '11px 13px 6px' : '14px 15px 8px', maxHeight: 200 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 11px 9px' }}>
            <button onClick={() => fileRef.current?.click()} title="Attach a file to the channel folder (or drop it here)" style={{ ...ghostBtn, padding: 6 }}><I d={P.attach} size={16} /></button>
            <button onClick={() => { const v = `${text}${text && !/\s$/.test(text) ? ' ' : ''}@`; setText(v); setMenu(mentionQuery(v)); inputRef.current?.focus(); }} title="Mention" style={{ ...ghostBtn, padding: 6 }}><I d={P.at} size={16} /></button>
            {note && <span role="status" style={{ fontSize: 11, color: 'var(--amber)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={note}>{note}</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>
              {!compact && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Enter to send</span>}
              <button onClick={() => void send()} disabled={sending} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: text.trim() || atts.length ? 'var(--accent)' : 'var(--accent-dim)', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer' }}>
                <I d={P.sendArrow} size={16} sw={2.2} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- meetings (docs/group-chat.md §8) ----

/** Inline Approve / Reject / Answer under an agent's proposal in a meeting thread. */
function ProposalSlot({ wsId, meeting, messageId, onChanged, text }: { wsId: string; meeting: OrgMeeting; messageId: string; onChanged: (m: OrgMeeting) => void; text: string }) {
  if (!/^(Decision proposed|Action proposed|Question for the CEO):/.test(text)) return null;
  return <div><ProposalActions wsId={wsId} meeting={meeting} messageId={messageId} onChanged={onChanged} /></div>;
}

/** The strip above a meeting's agenda root: "Meeting · <kind> · running/done",
 *  rounds and cost, Cancel while it runs, Open thread from the channel. */
function MeetingHeader({ meeting: m, inThread, onOpen, onExpand, onCancel }: { meeting: OrgMeeting; inThread: boolean; onOpen: () => void; onExpand: () => void; onCancel: () => void }) {
  const running = m.status === 'running';
  const color = running ? 'var(--green)' : m.status === 'done' ? 'var(--text-dim)' : m.status === 'cancelled' ? 'var(--red)' : 'var(--amber)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4, fontSize: 11.5 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--panel-2)', border: `1px solid ${running ? 'var(--green)' : 'var(--border)'}`, borderRadius: 6, padding: '1px 8px', fontWeight: 600, color: 'var(--text)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, animation: running ? 'pulse 1.2s infinite' : undefined }} />
        Meeting · {MEETING_KIND_TITLES[m.kind] ?? m.kind} · <span style={{ color }}>{m.status}</span>
      </span>
      <span style={{ color: 'var(--text-faint)' }}>{m.rounds > 0 ? `${m.rounds} round${m.rounds === 1 ? '' : 's'} · ` : ''}{fmtUsd(m.usd)}{running ? ' · replies are read at the next round' : ''}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
        {!inThread && <button onClick={onOpen} style={{ ...smallBtn, padding: '2px 8px', fontSize: 11 }}>Open thread</button>}
        {!inThread && <button onClick={onExpand} style={{ ...smallBtn, padding: '2px 8px', fontSize: 11 }} title="Open the full-screen room">Room</button>}
        {running && <button onClick={onCancel} style={{ ...smallBtn, padding: '2px 8px', fontSize: 11, color: 'var(--red)' }} title="End the meeting now; the minutes are written from what was proposed">Cancel</button>}
      </span>
    </div>
  );
}

/** The minutes as a structured card (summary, decisions as `#decision:` chips,
 *  actions linking to the tasks they became, risks, questions for the CEO),
 *  read from the meeting row; the rendered text is the fallback. */
export function MinutesCard({ wsId, meetingId, fallback, refs, onDecision, onTask }: { wsId: string; meetingId: string; fallback: string; refs: RefResolver; onDecision: (id: string) => void; onTask: (taskId: string) => void }) {
  const app = useApp();
  const [m, setM] = useState<OrgMeeting | null | undefined>(undefined);
  const [raw, setRaw] = useState(false);
  useEffect(() => { void api.orgMeeting(wsId, meetingId).then(setM).catch(() => setM(null)); }, [wsId, meetingId]);
  if (m === undefined) return <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>Loading the minutes…</div>;
  if (m === null || raw) return <div style={{ fontSize: 14, lineHeight: 1.6, marginTop: 2 }}><Markdown text={fallback} refs={refs} compact />{m && <button onClick={() => setRaw(false)} style={{ ...ghostBtn, padding: 0 }}>structured view</button>}</div>;
  const minutes = parseMinutes(m.minutes);
  const nm = (id: string) => app.agents.find((a) => a.id === id)?.name ?? (id ? id.slice(0, 8) : 'the facilitator');
  const section = (title: string, n: number) => <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)', marginTop: 10, marginBottom: 4 }}>{title} · {n}</div>;
  const row: React.CSSProperties = { fontSize: 13, lineHeight: 1.5, padding: '3px 0', borderBottom: '1px solid var(--border-soft)' };
  return (
    <div style={{ marginTop: 4, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--panel)', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Minutes — {m.title || MEETING_KIND_TITLES[m.kind]}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{minutes.endedBy === 'stopped' ? 'ended early' : minutes.endedBy === 'usd_cap' ? 'stopped at the USD cap' : `${m.rounds} round${m.rounds === 1 ? '' : 's'}`} · {fmtUsd(m.usd)}</span>
        <button onClick={() => setRaw(true)} style={{ ...ghostBtn, marginLeft: 'auto', padding: 0 }}>as text</button>
      </div>
      {minutes.summary && <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 6, whiteSpace: 'pre-wrap' }}>{minutes.summary}</div>}
      {section('Decisions', minutes.decisions.length)}
      {minutes.decisions.length === 0 && <div style={{ ...row, color: 'var(--text-faint)', borderBottom: 'none' }}>none</div>}
      {minutes.decisions.map((d, i) => (
        <div key={i} style={{ ...row, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}><b>{d.title}</b>{d.decision ? `: ${d.decision}` : ''}{d.rationale ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>why: {d.rationale}</div> : null}</div>
          {d.decisionId ? <button onClick={() => onDecision(d.decisionId!)} title="Open in the decision log" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--accent-dim)', border: 'none', color: 'var(--text)', borderRadius: 7, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer', ...mono }}>#decision:{d.decisionId.slice(0, 8)}</button> : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>not logged</span>}
        </div>
      ))}
      {section('Actions', minutes.actions.length)}
      {minutes.actions.length === 0 && <div style={{ ...row, color: 'var(--text-faint)', borderBottom: 'none' }}>none</div>}
      {minutes.actions.map((a, i) => (
        <div key={i} style={{ ...row, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}><b>{a.title}</b> — {a.owner || 'unowned'}{a.done_when ? <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>done when: {a.done_when}</div> : null}</div>
          {a.taskId ? <button onClick={() => onTask(a.taskId!)} title="Open on the board" style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--accent-dim)', border: 'none', color: 'var(--text)', borderRadius: 7, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}><I d={P.board} size={12} />task {a.taskKey ?? a.taskId.slice(0, 8)}</button> : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>no task</span>}
        </div>
      ))}
      {section('Risks', minutes.risks.length)}
      {minutes.risks.length === 0 && <div style={{ ...row, color: 'var(--text-faint)', borderBottom: 'none' }}>none</div>}
      {minutes.risks.map((r, i) => <div key={i} style={{ ...row, color: 'var(--amber)' }}>■ {r.text} <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>({nm(r.by)})</span></div>)}
      {section('Questions for the CEO', minutes.questions.length)}
      {minutes.questions.length === 0 && <div style={{ ...row, color: 'var(--text-faint)', borderBottom: 'none' }}>none</div>}
      {minutes.questions.map((q, i) => <div key={i} style={row}>? {q.question} <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>({nm(q.by)})</span></div>)}
      {(minutes.lessons?.length ?? 0) > 0 && (
        <>
          {section('Lessons', minutes.lessons!.length)}
          {minutes.lessons!.map((l, i) => (
            <div key={i} style={{ ...row, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: '#fff', background: AUDIENCE_COLOR[l.audience] ?? 'var(--panel-2)', borderRadius: 6, padding: '1px 7px', flex: 'none' }} title="Who remembers this lesson">{audienceLabel(l.audience)}</span>
              <span style={{ flex: 1, minWidth: 180 }}>{l.text} <span style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>({nm(l.by)})</span></span>
              {l.proposedCharterChange && <span style={{ fontSize: 11, color: 'var(--amber)' }} title={l.proposedCharterChange.text}>charter change for {nm(l.proposedCharterChange.agent)}{l.proposedCharterChange.approvalId ? ' → card' : ''}</span>}
              {l.proposedPlaybookChange && (l.proposedPlaybookChange.taskId ? <button onClick={() => onTask(l.proposedPlaybookChange!.taskId!)} style={{ fontSize: 11, background: 'var(--accent-dim)', border: 'none', color: 'var(--text)', borderRadius: 7, padding: '2px 8px', cursor: 'pointer' }}>playbook revise task</button> : <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>playbook change proposed</span>)}
            </div>
          ))}
        </>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>Minutes are hash-chained into the audit log; actions became tasks, decisions went to the log, questions reach the next brief{(minutes.lessons?.length ?? 0) > 0 ? ', lessons went to the memory of their audience' : ''}.</div>
    </div>
  );
}

// ---- files tab ----

function FilesTab({ wsId, slug, folder, files, reload }: { wsId: string; slug: string; folder: string; files: ChannelFile[]; reload: () => void }) {
  const app = useApp();
  const [dragOver, setDragOver] = useState(false);
  const upload = async (list: FileList) => {
    for (const file of Array.from(list).slice(0, 8)) {
      if (file.size > 5_000_000) { app.showToast(`${file.name} is too large (5MB max)`); continue; }
      const b64 = btoa(new Uint8Array(await file.arrayBuffer()).reduce((acc, b) => acc + String.fromCharCode(b), ''));
      await api.wsPutFile(wsId, `${folder.replace(/^\/+|\/+$/g, '')}/${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`, b64, file.type || undefined).catch(() => app.showToast(`upload of ${file.name} failed`));
    }
    reload();
  };
  return (
    <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); void upload(e.dataTransfer.files); }}
      style={{ flex: 1, overflowY: 'auto', padding: 24, outline: dragOver ? '2px dashed var(--green)' : 'none', outlineOffset: -8 }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 12, ...mono }}>{folder}/ · agents in #{slug} see this folder as shared/</div>
        {files.length === 0 && <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>No files yet. Drop files here or attach them to a message.</div>}
        {files.map((f) => (
          <div key={f.path} onClick={() => app.openFile({ kind: 'workspace', id: wsId }, f.path)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9, cursor: 'pointer', border: '1px solid var(--border-soft)', marginBottom: 6, background: 'var(--panel)' }}>
            <span>{/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? '🖼️' : f.name.endsWith('.md') ? '📄' : '📎'}</span>
            <span style={{ flex: 1, fontSize: 13, ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{f.size > 1024 ? `${Math.round(f.size / 1024)} KB` : `${f.size} B`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- settings tab ----

function SettingsTab({ detail, onChange }: { detail: ChannelDetail; onChange: (d: ChannelDetail) => void }) {
  const app = useApp();
  const wsId = detail.workspaceId;
  const [topic, setTopic] = useState(detail.topic);
  const [budget, setBudget] = useState(String(detail.dailyTokenBudget));
  const [addAgent, setAddAgent] = useState('');
  const [addHuman, setAddHuman] = useState('');
  useEffect(() => { setTopic(detail.topic); setBudget(String(detail.dailyTokenBudget)); }, [detail.topic, detail.dailyTokenBudget]);
  const reload = async () => onChange(await api.channel(wsId, detail.slug));
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try { await fn(); await reload(); if (ok) app.showToast(ok); } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'failed'); }
  };
  const agentMembers = detail.members.filter((m) => m.memberKind === 'agent');
  const humanMembers = detail.members.filter((m) => m.memberKind === 'human');
  const freeAgents = app.agents.filter((a) => !agentMembers.some((m) => m.memberId === a.id));
  const freeHumans = Object.entries(app.me?.names ?? {}).filter(([id]) => !humanMembers.some((m) => m.memberId === id));
  const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 };
  const label: React.CSSProperties = { fontSize: 13.5, fontWeight: 600 };
  const hint: React.CSSProperties = { fontSize: 12, color: 'var(--text-faint)', marginTop: 3 };
  const Row = ({ m }: { m: ChannelMember }) => {
    const agent = m.memberKind === 'agent' ? app.agents.find((a) => a.id === m.memberId) : undefined;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-soft)' }}>
        <Chip kind={m.memberKind} agent={agent} name={m.name} size={26} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name}{m.role === 'owner' ? <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 6 }}>owner</span> : null}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{m.memberKind === 'agent' ? (m.unprompted === 1 ? 'may reply unprompted when a message is clearly theirs' : 'replies only when mentioned') : `notified: ${m.notify}`}</div>
        </div>
        {m.memberKind === 'agent' ? (
          <label title="Unprompted replies pass a cheap relevance check and the §2 bounds: one per 2 minutes, two per message, never to another unprompted reply, never over the daily budget." style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={m.unprompted === 1} onChange={(e) => void act(() => api.updateChannelMember(wsId, detail.slug, 'agent', m.memberId, { unprompted: e.target.checked }))} />unprompted
          </label>
        ) : (
          <select value={m.notify} onChange={(e) => void act(() => api.updateChannelMember(wsId, detail.slug, 'human', m.memberId, { notify: e.target.value }))} style={{ ...field, width: 'auto', padding: '4px 8px', fontSize: 12 }}>
            <option value="all">every message</option><option value="mentions">mentions</option><option value="none">nothing</option>
          </select>
        )}
        {!(m.memberKind === 'human' && detail.slug === 'general') && (
          <button onClick={() => void act(() => api.removeChannelMember(wsId, detail.slug, m.memberKind, m.memberId), `${m.name} removed`)} title="Remove" style={ghostBtn}><I d={P.x} size={13} /></button>
        )}
      </div>
    );
  };
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={card}>
          <div style={label}>Topic</div>
          <div style={hint}>Agents read it when deciding whether a message is theirs; people see it in the header.</div>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} onBlur={() => { if (topic !== detail.topic) void act(() => api.updateChannel(wsId, detail.slug, { topic }), 'Topic saved'); }} style={{ ...field, marginTop: 10 }} placeholder="What this channel is for" />
          <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={label}>Visibility</div>
              <div style={hint}>Private channels are visible to their members only.</div>
            </div>
            <select value={detail.kind} onChange={(e) => void act(() => api.updateChannel(wsId, detail.slug, { kind: e.target.value as 'public' | 'private' }))} style={{ ...field, width: 'auto' }}>
              <option value="public">public</option><option value="private">private</option>
            </select>
          </div>
        </div>
        <div style={card}>
          <div style={label}>Daily token budget for agent replies</div>
          <div style={hint}>Agents stop replying here once today&apos;s turns reach it; 0 uses the workspace default (Settings → Context &amp; budget). Spent today: <span style={mono}>{detail.spentToday.toLocaleString()}</span> tokens.</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => { const n = parseInt(budget || '0', 10); if (n !== detail.dailyTokenBudget) void act(() => api.updateChannel(wsId, detail.slug, { dailyTokenBudget: n }), 'Budget saved'); }} style={{ ...field, width: 140, ...mono }} />
            <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>tokens per day</span>
          </div>
        </div>
        <div style={card}>
          <div style={label}>Agents</div>
          <div style={hint}>Members may be mentioned and may reply; the unprompted toggle lets an agent speak when a message clearly falls in its charter.</div>
          <div style={{ marginTop: 8 }}>{agentMembers.map((m) => <Row key={m.id} m={m} />)}</div>
          {freeAgents.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <select value={addAgent} onChange={(e) => setAddAgent(e.target.value)} style={{ ...field, flex: 1 }}>
                <option value="">Add an agent…</option>
                {freeAgents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
              </select>
              <button disabled={!addAgent} onClick={() => void act(() => api.addChannelMember(wsId, detail.slug, { kind: 'agent', id: addAgent }), 'Agent added').then(() => setAddAgent(''))} style={smallBtn}>Add</button>
            </div>
          )}
        </div>
        <div style={card}>
          <div style={label}>People</div>
          <div style={hint}>Mentions notify a person through their paired Telegram, email and push with a link back here, under the workspace&apos;s quiet hours.</div>
          <div style={{ marginTop: 8 }}>{humanMembers.map((m) => <Row key={m.id} m={m} />)}</div>
          {freeHumans.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <select value={addHuman} onChange={(e) => setAddHuman(e.target.value)} style={{ ...field, flex: 1 }}>
                <option value="">Add a person…</option>
                {freeHumans.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <button disabled={!addHuman} onClick={() => void act(() => api.addChannelMember(wsId, detail.slug, { kind: 'human', id: addHuman }), 'Member added').then(() => setAddHuman(''))} style={smallBtn}>Add</button>
            </div>
          )}
        </div>
        {detail.slug !== 'general' && (
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={label}>{detail.archivedAt ? 'Archived' : 'Archive this channel'}</div>
              <div style={hint}>Archived channels keep their messages and files; nobody can post and no agent wakes.</div>
            </div>
            <button onClick={() => void act(() => api.archiveChannel(wsId, detail.slug, !detail.archivedAt), detail.archivedAt ? 'Channel restored' : 'Channel archived').then(() => { if (!detail.archivedAt) app.openChannel('general'); })} style={{ ...smallBtn, color: detail.archivedAt ? 'var(--text)' : 'var(--red)' }}>{detail.archivedAt ? 'Restore' : 'Archive'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
