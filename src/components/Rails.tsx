/** Secondary panel: workspace pill, the combined Home rail (agents → their
 *  chats + their folder, YAAM-style), market categories, and settings nav. */
import { useEffect, useMemo, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, type OrgPane } from '../store';
import { api, type ChatRail, type ChatSession } from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { ArtifactTree } from './ArtifactTree';
import { createFile, createFolder, workspaceSource } from '../lib/artifacts';
import { sectionDef, type CompanySection } from '../lib/company-nav';
import { bizFunctions, bySegment, marketCats, SEGMENT_LABEL, type MarketNav, type MarketSegment } from '../lib/market';
import { railChannels } from '../lib/channels';
import { SubChannelRows } from './SubChannels';

const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '2px 18px 8px' };

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The small trigger glyph on a work row (docs/work-log.md): what started
 *  the session — the heartbeat, a loop, a task key, a channel, a meeting. */
function workGlyph(s: Pick<ChatSession, 'trigger' | 'triggerKey'>): string {
  switch (s.trigger) {
    case 'heartbeat': case 'loop': return 'loop';
    case 'task': return s.triggerKey || 'task';
    case 'meeting': return 'meeting';
    case 'channel': return 'channel';
    case 'app': return 'app';
    case 'org': return 'org';
    default: return 'work';
  }
}

/** The row's title. A work session drops what its glyph already says: a
 *  loop reads by its name ("digest"), a task by its title, a channel
 *  session by its `#slug`, an org run without the `Org · ` prefix. */
function rowTitle(s: ChatSession): string {
  const name = s.name || s.autoTitle || (s.kind === 'work' ? 'Run' : 'New chat');
  if (s.kind !== 'work') return name;
  const key = s.triggerKey ?? '';
  const label = s.triggerLabel ?? '';
  switch (s.trigger) {
    case 'heartbeat': return 'Heartbeat';
    case 'loop': return key || name;
    case 'task': return key && label.startsWith(`${key} `) ? label.slice(key.length + 1) : label || name;
    case 'channel': case 'meeting': return key || name;
    case 'org': return name.replace(/^Org · /, '');
    default: return name;
  }
}

function SessionRow({ s, approval = false }: { s: ChatSession; approval?: boolean }) {
  const app = useApp();
  const tags = safeJsonParse<string[]>(s.tags, []).filter((t) => !(s.kind === 'work' && t === 'channel'));
  const active = s.id === app.currentId && app.homeView === 'chat';
  const work = s.kind === 'work';
  return (
    <div onClick={() => app.openSession(s.id)} data-testid={`rail-row-${s.id}`} style={{ padding: '7px 10px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {s.pinned === 1 && <I d={P.pin} size={11} fill="var(--amber)" style={{ flex: 'none' }} />}
        {work && <span title={`Work session · ${s.triggerLabel || s.name}`} style={{ fontSize: 9.5, color: 'var(--text-faint)', border: '1px solid var(--border-soft)', borderRadius: 4, padding: '0 4px', flex: 'none', maxWidth: 76, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workGlyph(s)}</span>}
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rowTitle(s)}</span>
        {work && s.running && <span title="Running now" aria-label="Running now" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flex: 'none', animation: 'pulse 1.4s ease-in-out infinite' }} />}
        {approval && <span title="Waiting on your approval" aria-label="Waiting on your approval" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none' }} />}
        {app.me?.hasMembers && s.shared === 1 && <span title="Shared with every member of this workspace" style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '0 5px', flex: 'none' }}>shared</span>}
        {app.me?.hasMembers && s.shared !== 1 && s.initiatedBy && s.initiatedBy !== app.me.actorId && <span title={`Private session of ${app.nameOf(s.initiatedBy)}`} style={{ fontSize: 9.5, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 4, padding: '0 5px', flex: 'none' }}>{app.nameOf(s.initiatedBy)}</span>}
        <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>{timeAgo(s.updatedAt)}</span>
      </div>
      {tags.length > 0 && (
        <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
          {tags.map((t) => <span key={t} style={{ fontSize: 10, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 5, padding: '1px 6px' }}>{t}</span>)}
        </div>
      )}
    </div>
  );
}

/** The Artifacts tree (docs/filesystem.md) for the workspace loaded in the
 *  store: Shared folders, then each agent's home with its avatar, plus the
 *  New file / New folder actions and live re-listing on `file.changed`. */
function ArtifactsSection() {
  const app = useApp();
  const wsId = app.fileTarget?.kind === 'workspace' ? app.fileTarget.id : null;
  const source = useMemo(() => (wsId ? workspaceSource(wsId) : null), [wsId]);
  const refreshFiles = app.refreshFiles;
  const onWorkspaceEvent = app.onWorkspaceEvent;
  useEffect(() => {
    if (!wsId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onWorkspaceEvent((ev) => {
      if (ev.type !== 'file.changed' && ev.type !== 'file_changed') return;
      clearTimeout(timer);
      timer = setTimeout(() => void refreshFiles(), 400);
    });
    return () => { off(); clearTimeout(timer); };
  }, [wsId, onWorkspaceEvent, refreshFiles]);
  const here = app.currentFile && app.currentFile.includes('/') ? app.currentFile.slice(0, app.currentFile.lastIndexOf('/')) : '';
  const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' };
  return (
    <>
      <div style={{ ...sectionLabel, padding: '10px 10px 4px', display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ flex: 1 }}>Artifacts</span>
        {source && wsId && (
          <>
            <button title={`New file${here ? ` in /${here}/` : ''}`} aria-label="New file" style={iconBtn}
              onClick={() => void createFile(source, here, app.showToast).then(async (p) => { if (p) { await refreshFiles(); app.openFile({ kind: 'workspace', id: wsId }, p); } })}>
              <I d={P.plus} size={14} />
            </button>
            <button title={`New folder${here ? ` in /${here}/` : ''}`} aria-label="New folder" style={iconBtn}
              onClick={() => void createFolder(source, here, app.showToast).then(async (p) => { if (p) await refreshFiles(); })}>
              <I d={P.folder} size={13} />
            </button>
          </>
        )}
      </div>
      <ArtifactTree entries={app.fileList} agents={app.agents} grouped
        selected={app.currentFile}
        onOpen={(p) => app.openFile(app.fileTarget!, p)} />
    </>
  );
}

/** Collapse state of the Home rail's agent groups, per viewer (localStorage,
 *  best effort): `true` = opened by hand, `false` = closed by hand; absent =
 *  the default (closed, unless the group holds the open chat or wants you). */
const RAIL_GROUPS_KEY = 'yaam-rail-groups';
function useRailCollapse(storageKey = RAIL_GROUPS_KEY): [Record<string, boolean>, (next: Record<string, boolean>) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const save = (next: Record<string, boolean>) => {
    setState(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage unavailable: keep it in memory */ }
  };
  return [state, save];
}

/** Collapse state of each agent's Work subsection, per viewer (same rules
 *  as the groups: absent = the default). */
const RAIL_WORK_KEY = 'yaam-rail-work';

interface RailWorkView {
  total: number; items: ChatSession[]; hasMore: boolean;
  /** Work sessions waiting on an approval (ids). */
  approvals: Set<string>;
  /** A run is going in one of the loaded work sessions. */
  running: boolean;
}

interface RailGroupView {
  key: string; id: string; name: string; emoji: string; avatar: string; isAgent: boolean;
  total: number; items: ChatSession[];
  /** The agent's runs (docs/work-log.md): the Work subsection's rows. */
  work: RailWorkView;
  hasMore: boolean; approvals: Set<string>; unread: number;
}

const moreBtn = (loading: boolean): React.CSSProperties => ({ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600, padding: '5px 10px', cursor: loading ? 'default' : 'pointer' });

/** The agent's Work subsection (docs/work-log.md): its work sessions —
 *  heartbeat, loops, task runs, meetings, channel wakes — as ordinary
 *  session rows, newest activity first, paged like chats. The header folds
 *  it, carries the count, a running / approval dot, and a link to the
 *  agent's Work log timeline. */
function WorkSection({ g, open, onToggle, searching }: { g: RailGroupView; open: boolean; onToggle: () => void; searching: boolean }) {
  const app = useApp();
  const [loading, setLoading] = useState(false);
  const w = g.work;
  const remaining = Math.max(0, w.total - w.items.length);
  const more = async () => {
    setLoading(true);
    try { await app.loadMoreWork(g.key); } catch { app.showToast('Could not load more work sessions'); } finally { setLoading(false); }
  };
  const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex', flex: 'none' };
  return (
    <div data-testid={`rail-work-${g.key || 'workspace'}`} style={{ marginTop: 2 }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 9, cursor: 'pointer', color: 'var(--text-faint)' }}>
        <button onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}'s work`} aria-expanded={open} style={{ ...iconBtn, padding: 0 }}>
          <I d={P.chevD} size={11} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .12s' }} />
        </button>
        <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', flex: 1 }}>Work</span>
        {w.running && <span title="A run is going now" aria-label="A run is going now" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', flex: 'none', animation: 'pulse 1.4s ease-in-out infinite' }} />}
        {w.approvals.size > 0 && <span title="A run is waiting on your approval" aria-label="A run is waiting on your approval" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flex: 'none' }} />}
        <span title={`${w.total} work session${w.total === 1 ? '' : 's'}`} style={{ fontSize: 10, background: 'var(--panel-2)', borderRadius: 5, padding: '0 5px', flex: 'none' }}>{w.total}</span>
        {g.isAgent && (
          <button onClick={(e) => { e.stopPropagation(); app.openWorkLog(g.id); }} title="Open the Work log — the timeline of its runs" aria-label={`Open ${g.name}'s Work log`} style={iconBtn}>
            <I d={P.clock} size={12} />
          </button>
        )}
      </div>
      {open && (
        <>
          {w.items.map((s) => <SessionRow key={s.id} s={s} approval={w.approvals.has(s.id)} />)}
          {!searching && w.hasMore && remaining > 0 && (
            <button type="button" onClick={() => void more()} disabled={loading} style={moreBtn(loading)}>
              {loading ? 'Loading…' : `Show more (${remaining})`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** One root in the combined rail — everything about a single agent: identity
 *  row (opens the agent home) with its unread / approval badges and chat
 *  count, then — when open — its newest chats and "Show more", then its
 *  Work subsection: its own runs (heartbeat, loops, task runs, meetings —
 *  docs/work-log.md) as the same session rows, folded unless one is
 *  running, waits on an approval, or is open. */
function AgentGroup({ g, open, onToggle, workOpen, onToggleWork, searching }: { g: RailGroupView; open: boolean; onToggle: () => void; workOpen: boolean; onToggleWork: () => void; searching: boolean }) {
  const app = useApp();
  const [loading, setLoading] = useState(false);
  const agentActive = g.isAgent && app.selectedAgent === g.id && app.homeView === 'agent';
  const remaining = Math.max(0, g.total - g.items.length);
  const more = async () => {
    setLoading(true);
    try { await app.loadMoreChats(g.key); } catch { app.showToast('Could not load more chats'); } finally { setLoading(false); }
  };
  const workApprovals = g.work.approvals.size;
  const showWork = searching ? g.work.items.length > 0 : g.work.total > 0;
  const iconBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex', flex: 'none' };
  return (
    <div style={{ marginTop: 4 }} data-testid={`rail-group-${g.key || 'workspace'}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 9, cursor: 'pointer', background: agentActive ? 'var(--accent-dim)' : 'none', minWidth: 0 }}
        onClick={() => { if (g.isAgent) app.openAgent(g.id); else onToggle(); }}>
        <div style={{ width: 24, height: 24, borderRadius: 7, background: g.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 12.5 }}>{g.emoji}</div>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
        {g.unread > 0 && (
          <span title="Unread activity from loops and proactive work" style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--amber)', borderRadius: 8, padding: '1px 6px', flex: 'none' }}>{g.unread}</span>
        )}
        {g.approvals.size + workApprovals > 0 && (
          <span title={workApprovals ? `${g.approvals.size + workApprovals} waiting on your approval (${workApprovals} in its work)` : `${g.approvals.size} chat(s) waiting on your approval`} style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--red)', borderRadius: 8, padding: '1px 6px', flex: 'none' }}>{g.approvals.size + workApprovals}</span>
        )}
        <span title={`${g.total} chat${g.total === 1 ? '' : 's'}`} style={{ fontSize: 10.5, color: 'var(--text-faint)', background: 'var(--panel-2)', borderRadius: 5, padding: '1px 6px', flex: 'none' }}>{g.total}</span>
        <button onClick={(e) => { e.stopPropagation(); void app.newChat(g.isAgent ? g.id : null); }} title="New chat" aria-label={`New chat with ${g.name}`} style={iconBtn}>
          <I d={P.plus} size={14} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onToggle(); }} title={open ? 'Collapse' : 'Expand'} aria-label={`${open ? 'Collapse' : 'Expand'} ${g.name}`} aria-expanded={open} style={iconBtn}>
          <I d={P.chevD} size={12} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .12s' }} />
        </button>
      </div>
      {open && (
        <div style={{ paddingLeft: 10, borderLeft: '1px solid var(--border-soft)', marginLeft: 19 }}>
          {g.items.map((s) => <SessionRow key={s.id} s={s} approval={g.approvals.has(s.id)} />)}
          {g.items.length === 0 && (!searching || !showWork) && <div style={{ padding: '4px 10px', fontSize: 11.5, color: 'var(--text-faint)' }}>No conversations.</div>}
          {!searching && g.hasMore && remaining > 0 && (
            <button type="button" onClick={() => void more()} disabled={loading} style={moreBtn(loading)}>
              {loading ? 'Loading…' : `Show more (${remaining})`}
            </button>
          )}
          {showWork && <WorkSection g={g} open={workOpen} onToggle={onToggleWork} searching={searching} />}
        </div>
      )}
    </div>
  );
}

// ---- group chat: channels (docs/group-chat.md, execution-plan item 15) — begin ----

/** The Channels block at the top of the Home rail: every channel of the
 *  workspace with its unread badge, plus "+ new channel". Direct messages
 *  (the agent chats) follow below, unchanged. */
function ChannelsBlock({ search }: { search: string }) {
  const app = useApp();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  // Sub-channels (docs/group-chat.md §9) nest under their parent; a search shows a parent when it or one of its discussions matches.
  const matches = (c: { slug: string; name: string; topic: string }) => !search || c.slug.includes(search) || c.name.toLowerCase().includes(search) || c.topic.toLowerCase().includes(search);
  const list = railChannels(app.channels).filter((g) => matches(g.channel) || g.subs.some(matches));
  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const c = await api.createChannel(app.workspaceId, { name: name.trim(), agentIds: app.agents.map((a) => a.id) });
      await app.refreshChannels();
      setName(''); setAdding(false);
      app.openChannel(c.slug);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 120) : 'could not create the channel');
    } finally { setCreating(false); }
  };
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 10px 4px' }}>
        <span style={{ ...sectionLabel, padding: 0, flex: 1 }}>Channels</span>
        <button onClick={() => setAdding(!adding)} title="New channel" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}><I d={P.plus} size={14} /></button>
      </div>
      {adding && (
        <div style={{ padding: '2px 8px 6px' }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={creating}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create(); if (e.key === 'Escape') setAdding(false); }}
            placeholder="Channel name (every agent joins)" style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px', color: 'var(--text)', fontSize: 12.5, outline: 'none' }} />
        </div>
      )}
      {list.map(({ channel: c, subs }) => {
        const active = app.homeView === 'channel' && app.currentChannel === c.slug;
        return (
          <div key={c.id}>
            <div onClick={() => app.openChannel(c.slug)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none' }}>
              <span style={{ fontWeight: 700, color: c.kind === 'private' ? 'var(--text-faint)' : 'var(--accent-hi)', width: 12, textAlign: 'center' }}>{c.kind === 'private' ? '🔒' : '#'}</span>
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: (c.unread ?? 0) > 0 ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.slug}</span>
              {(c.unread ?? 0) > 0 && <span title="Unread messages" style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--accent)', borderRadius: 8, padding: '1px 6px' }}>{c.unread}</span>}
            </div>
            <SubChannelRows wsId={app.workspaceId} parent={c} subs={subs} past={c.pastSubs ?? 0} current={app.homeView === 'channel' ? app.currentChannel : null} onOpen={(slug) => app.openChannel(slug)} />
          </div>
        );
      })}
      {list.length === 0 && !adding && <div style={{ padding: '4px 10px', fontSize: 11.5, color: 'var(--text-faint)' }}>No channels match.</div>}
    </div>
  );
}

// ---- group chat — end ----

/** The Home rail: one tree combining agents, their chats, and their folders,
 *  plus workspace-level chats/files and the archive — the YAAM layout. */
export function HomeRail() {
  const app = useApp();
  const [search, setSearch] = useState('');
  const [archOpen, setArchOpen] = useState(false);
  const [explicit, saveExplicit] = useRailCollapse();
  const [explicitWork, saveExplicitWork] = useRailCollapse(RAIL_WORK_KEY);
  const [searchKind, setSearchKind] = useState<'all' | 'chat' | 'work'>('all');
  const q = search.trim().toLowerCase();
  // Search runs on the server (the rail is paged), so it finds chats and
  // work sessions in collapsed groups and beyond the loaded pages; groups
  // with a hit open.
  const [hits, setHits] = useState<ChatRail | null>(null);
  useEffect(() => {
    if (!q || !app.workspaceId) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.chatRail(app.workspaceId, { q, perAgent: 50, kind: searchKind }).then((r) => { if (live) setHits(r); }).catch(() => { if (live) setHits({ groups: [], archivedTotal: 0 }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, app.workspaceId, searchKind]);

  /** The open session's group, and whether it is one of its work sessions. */
  const { sessions, chatRail, currentId, homeView } = app;
  const currentAt = useMemo((): { key: string; work: boolean } | null => {
    if (homeView !== 'chat' || !currentId) return null;
    const s = sessions.find((x) => x.id === currentId);
    if (s) return { key: s.agentId ?? '', work: s.kind === 'work' };
    const g = chatRail.find((x) => (x.work?.items ?? []).some((y) => y.id === currentId));
    return g ? { key: g.agentId ?? '', work: true } : null;
  }, [sessions, chatRail, currentId, homeView]);
  const currentAgentKey = currentAt?.key ?? null;

  const groups = useMemo(() => {
    const source = q ? hits?.groups ?? [] : app.chatRail;
    const byKey = new Map(source.map((g) => [g.agentId ?? '', g]));
    const base = new Map(app.chatRail.map((g) => [g.agentId ?? '', g]));
    const out: RailGroupView[] = [];
    const view = (key: string, meta: { id: string; name: string; emoji: string; avatar: string; isAgent: boolean }): RailGroupView | null => {
      const g = byKey.get(key);
      const nameHit = !!q && meta.isAgent && meta.name.toLowerCase().includes(q);
      // a search shows the groups with hits, and agents whose name matches (their usual first page)
      const use = g ?? (nameHit ? base.get(key) : undefined);
      if (q && !use && !nameHit) return null;
      const workItems = use?.work?.items ?? [];
      return {
        key, ...meta,
        total: use?.total ?? 0, items: use?.items ?? [],
        work: {
          total: use?.work?.total ?? 0, items: workItems, hasMore: !q && !!use?.work?.nextCursor,
          approvals: new Set(base.get(key)?.work?.approvalIds ?? []), running: workItems.some((s) => s.running),
        },
        hasMore: !q && !!use?.nextCursor, approvals: new Set(base.get(key)?.approvalIds ?? []),
        unread: meta.isAgent ? app.unread[meta.id] ?? 0 : 0,
      };
    };
    for (const a of app.agents) {
      const v = view(a.id, { id: a.id, name: a.name, emoji: a.emoji, avatar: grad(a.colors), isAgent: true });
      if (v) out.push(v);
    }
    const ws = view('', { id: '__ws', name: 'Workspace', emoji: '🗂️', avatar: 'var(--panel-2)', isAgent: false });
    if (ws && (q || ws.total > 0 || ws.work.total > 0 || out.length === 0)) out.push(ws);
    return out;
  }, [app.agents, app.chatRail, app.unread, hits, q]);

  /** Open: as the viewer set it by hand; otherwise only the open session's
   *  group and groups that want you (unread, an approval, a run going). A
   *  search opens every group with a hit. */
  const isOpen = (g: RailGroupView) => {
    if (q) return true;
    if (explicit[g.key] !== undefined) return explicit[g.key];
    return g.key === currentAgentKey || g.unread > 0 || g.approvals.size > 0 || g.work.approvals.size > 0;
  };
  /** The Work subsection: folded by default unless one of its sessions is
   *  running, waits on an approval, or is the open one; a search opens it
   *  when it has hits. */
  const isWorkOpen = (g: RailGroupView) => {
    if (q) return g.work.items.length > 0;
    if (explicitWork[g.key] !== undefined) return explicitWork[g.key];
    return g.work.running || g.work.approvals.size > 0 || (!!currentAt?.work && currentAt.key === g.key);
  };
  const anyOpen = groups.some(isOpen);
  const setAll = (open: boolean) => saveExplicit(Object.fromEntries(groups.map((g) => [g.key, open])));
  const archMore = async () => { try { await app.loadMoreArchived(); } catch { app.showToast('Could not load more archived chats'); } };

  return (
    <>
      <div style={{ padding: '0 12px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '7px 10px', marginBottom: 10 }}>
          <I d={P.search} size={14} stroke="var(--text-faint)" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13, minWidth: 0 }} />
        </div>
        {q && (
          <div role="group" aria-label="Search in" style={{ display: 'flex', gap: 4, margin: '-4px 0 10px' }}>
            {(['all', 'chat', 'work'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={searchKind === k} onClick={() => setSearchKind(k)}
                style={{ flex: 1, background: searchKind === k ? 'var(--accent-dim)' : 'var(--panel-2)', color: searchKind === k ? 'var(--accent-hi)' : 'var(--text-dim)', border: '1px solid var(--border-soft)', borderRadius: 7, padding: '3px 0', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                {k === 'all' ? 'All' : k === 'chat' ? 'Chats' : 'Work'}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void app.newChat(app.selectedAgent)} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <I d={P.plus} size={15} sw={2.2} />New chat
          </button>
          <button onClick={() => app.setNewAgentOpen(true)} title="Create a durable agent" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <I d={P.bot} size={15} />New agent
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
        {/* ---- group chat: channels (docs/group-chat.md) — begin ---- */}
        <ChannelsBlock search={q} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 4px' }}>
          <span style={{ ...sectionLabel, padding: 0, flex: 1 }}>Direct messages</span>
          {!q && groups.length > 1 && (
            <button type="button" onClick={() => setAll(!anyOpen)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: 10.5, fontWeight: 600, cursor: 'pointer', padding: 2 }}>
              {anyOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </div>
        {/* ---- group chat — end ---- */}
        {groups.map((g) => (
          <AgentGroup key={g.key || '__ws'} g={g} open={isOpen(g)} searching={!!q}
            onToggle={() => saveExplicit({ ...explicit, [g.key]: !isOpen(g) })}
            workOpen={isWorkOpen(g)} onToggleWork={() => saveExplicitWork({ ...explicitWork, [g.key]: !isWorkOpen(g) })} />
        ))}
        {q && hits && groups.length === 0 && <div style={{ padding: '6px 12px', fontSize: 11.5, color: 'var(--text-faint)' }}>No conversations match.</div>}
        {app.archivedTotal > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
            <div onClick={() => setArchOpen(!archOpen)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: 8, borderRadius: 9, cursor: 'pointer', color: 'var(--text-faint)' }}>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>Archived</span>
              <span style={{ fontSize: 10.5, background: 'var(--panel-2)', borderRadius: 5, padding: '1px 6px' }}>{app.archivedTotal}</span>
              <I d={P.chevD} size={12} style={{ transform: archOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            </div>
            {archOpen && app.archived.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 9, margin: '2px 0' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.autoTitle || 'Chat'}</span>
                <button onClick={() => void app.restoreChat(s.id)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Restore</button>
              </div>
            ))}
            {archOpen && app.archivedHasMore && (
              <button type="button" onClick={() => void archMore()} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600, padding: '5px 10px', cursor: 'pointer' }}>
                Show more ({Math.max(0, app.archivedTotal - app.archived.length)})
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Icons of the company pages (sections in src/lib/company-nav.ts). */
const PANE_ICON: Partial<Record<OrgPane, string[]>> = {
  vision: P.compass, goals: P.star, roadmap: P.board, decisions: P.check,
  board: P.board, pulse: P.pulse, brief: P.rows, meetings: P.chat, incidents: P.warn,
  chart: P.bot, teams: P.people, spend: P.bolt, capital: P.coin, audit: P.clock, replay: P.retry,
};

function PaneRow({ id, label, icon, active, badge, badgeColor = 'var(--amber)', badgeTitle, onClick }: { id: string; label: string; icon: string[]; active: boolean; badge?: number; badgeColor?: string; badgeTitle?: string; onClick: () => void }) {
  return (
    <button type="button" data-testid={`company-page-${id}`} onClick={onClick} aria-current={active ? 'page' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left', border: 'none', font: 'inherit', padding: '8px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 13, margin: '1px 0', color: 'var(--text)', background: active ? 'var(--accent-dim)' : 'none' }}>
      <I d={icon} size={16} sw={1.9} style={{ flex: 'none' }} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && <span title={badgeTitle} style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: badgeColor, borderRadius: 8, padding: '1px 6px' }}>{badge}</span>}
    </button>
  );
}

/** The Artifacts tab's rail: the workspace tree (docs/filesystem.md) —
 *  Shared folders with /org/ first (the company's mirrored records live
 *  there), then each agent's home. */
export function ArtifactsRail() {
  const app = useApp();
  useEffect(() => {
    if (app.fileTarget?.kind !== 'workspace' && app.workspaceId) {
      app.setFileTarget({ kind: 'workspace', id: app.workspaceId });
      app.setCurrentFile(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.workspaceId, app.fileTarget?.kind]);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
      <ArtifactsSection />
    </div>
  );
}

/** A company section's rail (src/lib/company-nav.ts): its dashboard, then
 *  its pages. Each page is in exactly one section; what waits on the CEO is
 *  in the Inbox, the files in Artifacts, company settings in Settings › Company. */
export function CompanyRail({ section }: { section: CompanySection }) {
  const app = useApp();
  const org = app.companiesEnabled && app.wsOrg && app.wsOrg.mode !== 'off' ? app.wsOrg : null;
  if (!org) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
        <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>Organization mode is off for this workspace — turn it on in Settings › Company.</div>
        <PaneRow id="open-artifacts" label="Open Artifacts" icon={P.files} active={false} onClick={() => app.go('artifacts')} />
      </div>
    );
  }
  const def = sectionDef(section);
  const openIncidents = (app.orgHealth?.openIncidents ?? []).filter((i) => i.status === 'open').length;
  const atRisk = countAtRisk(app.orgIntent ?? []);
  const badgeOf = (id: OrgPane): { n: number; color?: string; title: string } | undefined => {
    if (id === 'incidents' && openIncidents > 0) return { n: openIncidents, color: 'var(--red)', title: `${openIncidents} open incident(s)` };
    if (id === 'goals' && atRisk > 0) return { n: atRisk, title: `${atRisk} goal(s) at risk` };
    return undefined;
  };
  const view = app.orgPane && def.pages.some((p) => p.pane === app.orgPane) ? app.orgPane : null;
  const open = (pane: OrgPane | null) => {
    app.setOrgUnitId(null);
    if (pane) app.setOrgPane(pane); else app.go(section);
    app.setMobileDetail(true);
  };
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }} data-testid={`company-rail-${section}`}>
      <PaneRow id="overview" label="Overview" icon={P.panel} active={view === null} onClick={() => open(null)} />
      {def.pages.map((e) => {
        const b = badgeOf(e.pane);
        return <PaneRow key={e.pane} id={e.pane} label={e.label} icon={PANE_ICON[e.pane] ?? P.board} active={view === e.pane} badge={b?.n} badgeColor={b?.color} badgeTitle={b?.title} onClick={() => open(e.pane)} />;
      })}
    </div>
  );
}

/** Goals at risk anywhere in the intent tree. */
function countAtRisk(nodes: Array<{ atRisk: number; children: unknown[] }>): number {
  return nodes.reduce((n, g) => n + (g.atRisk ? 1 : 0) + countAtRisk(g.children as Array<{ atRisk: number; children: unknown[] }>), 0);
}

/** The Market rail: the Personal | Business switch, then the personal
 *  categories or the business functions, each with its count. */
export function MarketRail({ nav, setNav }: { nav: MarketNav; setNav: (patch: Partial<MarketNav>) => void }) {
  const app = useApp();
  const row = (key: string, label: React.ReactNode, count: number, active: boolean, onClick: () => void) => (
    <button key={key} onClick={onClick} aria-current={active ? 'true' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', border: 'none', font: 'inherit', padding: '7px 9px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none', color: active ? 'var(--text)' : 'var(--text-dim)' }}>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{count}</span>
    </button>
  );
  const personal = bySegment(app.market, 'personal');
  const fns = bizFunctions(app.market);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
      <div role="tablist" aria-label="Market segment" style={{ display: 'flex', gap: 4, padding: 3, margin: '0 2px 8px', borderRadius: 10, background: 'var(--panel-2)', border: '1px solid var(--border-soft)' }}>
        {(['personal', 'business'] as MarketSegment[]).map((s) => (
          <button key={s} role="tab" aria-selected={nav.segment === s} onClick={() => setNav({ segment: s })}
            style={{ flex: 1, border: 'none', font: 'inherit', fontSize: 12.5, fontWeight: 700, padding: '6px 8px', borderRadius: 8, cursor: 'pointer', background: nav.segment === s ? 'var(--panel)' : 'none', color: nav.segment === s ? 'var(--text)' : 'var(--text-dim)', boxShadow: nav.segment === s ? 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,.15))' : 'none' }}>
            {SEGMENT_LABEL[s]} <span style={{ fontWeight: 500, color: 'var(--text-faint)' }}>{bySegment(app.market, s).length}</span>
          </button>
        ))}
      </div>
      {nav.segment === 'personal'
        ? marketCats(app.market).map((c) => row(c, c, c === 'All' ? personal.length : personal.filter((m) => m.cat === c).length, c === nav.cat, () => setNav({ cat: c })))
        : <>
          {row('all', 'All functions', fns.reduce((n, f) => n + f.count, 0), nav.fn === '', () => setNav({ fn: '' }))}
          {fns.map((f) => row(f.id, <><span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: f.color, flex: 'none' }} />{f.label}</>, f.count, nav.fn === f.id, () => setNav({ fn: f.id })))}
        </>}
      <div style={{ margin: '14px 8px 0', padding: 12, border: '1px solid var(--border-soft)', borderRadius: 11, background: 'var(--panel-2)', fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        {nav.segment === 'business'
          ? 'Hire a function head and it hires its own team. Every hire shows its playbooks and loops for review first.'
          : 'Registry profiles get a capability review before install — imported loops enable immediately.'}
      </div>
    </div>
  );
}

export const SETTINGS_PANES = [
  { id: 'account', label: 'Account', icon: P.shield },
  { id: 'providers', label: 'Providers & agent types', icon: P.rows },
  { id: 'mcp', label: 'MCP servers', icon: P.globe },
  { id: 'skills', label: 'Skills & registries', icon: P.star },
  { id: 'permissions', label: 'Permissions', icon: P.shield },
  { id: 'context', label: 'Context & budget', icon: P.context },
  { id: 'memory', label: 'Workspace memory', icon: P.memoryIcon },
  { id: 'workspace', label: 'Workspace', icon: P.clock },
  { id: 'company', label: 'Company', icon: P.building },
  { id: 'usage', label: 'Usage', icon: P.bolt },
  { id: 'channels', label: 'Channels', icon: P.chat },
  { id: 'connections', label: 'Connections', icon: P.globe },
  { id: 'runner', label: 'Code runner & browser', icon: P.shield },
  { id: 'harness', label: 'Coding agents', icon: P.bolt },
  { id: 'plugins', label: 'Plugins', icon: P.market },
  { id: 'computer', label: 'Computer', icon: P.window },
  { id: 'market', label: 'Market', icon: P.market },
  { id: 'security', label: 'Security', icon: P.shield },
];

export function SettingsRail({ pane, setPane }: { pane: string; setPane: (p: string) => void }) {
  const app = useApp();
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
      {SETTINGS_PANES.filter((n) => n.id !== 'company' || app.companiesEnabled).map((n) => (
        <div key={n.id} onClick={() => { setPane(n.id); app.setMobileDetail(true); }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 13, margin: '1px 0', color: 'var(--text)', background: n.id === pane ? 'var(--accent-dim)' : 'none' }}>
          <I d={n.icon} size={16} sw={1.9} style={{ flex: 'none' }} />
          <span style={{ flex: 1 }}>{n.label}</span>
        </div>
      ))}
    </div>
  );
}

export function SecondaryHeader({ title }: { title: string }) {
  return <div style={sectionLabel}>{title}</div>;
}
