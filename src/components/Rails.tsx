/** Secondary panel: workspace pill, the combined Home rail (agents → their
 *  chats + their folder, YAAM-style), market categories, and settings nav. */
import { useEffect, useMemo, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, type OrgPane } from '../store';
import { api, type ChatRail, type ChatSession, type OrgUnitNode } from '../lib/api';
import { safeJsonParse } from '../lib/util';
import { atRiskByUnit, firesOn, MEETING_KIND_TITLES } from '../lib/org';
import { NewWorkspaceWizard } from './NewWorkspaceWizard';
import { ArtifactTree } from './ArtifactTree';
import { createFile, createFolder, workspaceSource } from '../lib/artifacts';
import { COMPANY_GROUPS } from '../lib/inbox';
import { bizFunctions, bySegment, marketCats, SEGMENT_LABEL, type MarketNav, type MarketSegment } from '../lib/market';

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

export function WorkspacePill() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  // "Add workspace" opens the onboarding wizard (item 25): name and colour,
  // then whether to run it as a company with a chief of staff.
  const [adding, setAdding] = useState(false);
  const ws = app.workspaces.find((w) => w.id === app.workspaceId);
  if (!ws) return null;
  return (
    <div style={{ padding: '12px 12px 8px', position: 'relative' }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 11px', color: 'var(--text)', cursor: 'pointer' }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: ws.color, flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.shared ? `shared by ${ws.shared.ownerName} · ${ws.shared.role}` : 'workspace · s3'}</div>
        </div>
        <I d={P.upDown} size={13} stroke="var(--text-faint)" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% - 2px)', left: 12, right: 12, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', zIndex: 50, padding: 6, animation: 'msgIn .12s' }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '6px 8px 4px' }}>Workspaces · scope chats</div>
          {app.workspaces.filter((w) => !w.shared).map((w) => (
            <div key={w.id} onClick={() => { app.pickWorkspace(w.id); setOpen(false); app.showToast(`Switched to ${w.name}`); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 8, cursor: 'pointer', margin: '1px 0', background: w.id === app.workspaceId ? 'var(--panel-2)' : 'none' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: w.color, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{w.name}</div>
              </div>
              {w.id === app.workspaceId && <I d={P.check} size={14} stroke="var(--accent)" sw={2.5} />}
            </div>
          ))}
          {app.workspaces.some((w) => w.shared) && (
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '8px 8px 4px', borderTop: '1px solid var(--border-soft)', marginTop: 4 }}>Shared with you</div>
          )}
          {app.workspaces.filter((w) => w.shared).map((w) => (
            <div key={w.id} onClick={() => { app.pickWorkspace(w.id); setOpen(false); app.showToast(`Switched to ${w.name} (${w.shared!.ownerName}'s)`); }}
              title={`Owned by ${w.shared!.ownerName}; you are a ${w.shared!.role}`}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 8, cursor: 'pointer', margin: '1px 0', background: w.id === app.workspaceId ? 'var(--panel-2)' : 'none' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: w.color, flex: 'none', outline: '1px dashed var(--text-faint)', outlineOffset: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{w.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{w.shared!.ownerName} · {w.shared!.role}</div>
              </div>
              {w.id === app.workspaceId && <I d={P.check} size={14} stroke="var(--accent)" sw={2.5} />}
            </div>
          ))}
          <button type="button" onClick={() => { setAdding(true); setOpen(false); }} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px', borderRadius: 8, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12.5, borderTop: '1px solid var(--border-soft)', marginTop: 4, background: 'none', border: 'none', borderTopStyle: 'solid', font: 'inherit', textAlign: 'left' }}>
            <I d={P.plus} size={14} />Add workspace
          </button>
        </div>
      )}
      {adding && <NewWorkspaceWizard onClose={() => setAdding(false)} />}
    </div>
  );
}

function SessionRow({ s, approval = false }: { s: ChatSession; approval?: boolean }) {
  const app = useApp();
  const tags = safeJsonParse<string[]>(s.tags, []);
  const active = s.id === app.currentId && app.homeView === 'chat';
  return (
    <div onClick={() => app.openSession(s.id)} style={{ padding: '7px 10px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {s.pinned === 1 && <I d={P.pin} size={11} fill="var(--amber)" style={{ flex: 'none' }} />}
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.autoTitle || 'New chat'}</span>
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
function useRailCollapse(): [Record<string, boolean>, (next: Record<string, boolean>) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(RAIL_GROUPS_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const save = (next: Record<string, boolean>) => {
    setState(next);
    try { localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep it in memory */ }
  };
  return [state, save];
}

interface RailGroupView {
  key: string; id: string; name: string; emoji: string; avatar: string; isAgent: boolean;
  total: number; items: ChatSession[]; loops: { total: number; items: ChatSession[] };
  hasMore: boolean; approvals: Set<string>; unread: number;
}

/** One root in the combined rail — everything about a single agent: identity
 *  row (opens the agent home) with its unread / approval badges and chat
 *  count, then — when open — its newest chats, "Show more", and its loop /
 *  heartbeat sessions folded into one row. */
function AgentGroup({ g, open, onToggle, searching }: { g: RailGroupView; open: boolean; onToggle: () => void; searching: boolean }) {
  const app = useApp();
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const agentActive = g.isAgent && app.selectedAgent === g.id && app.homeView === 'agent';
  const remaining = Math.max(0, g.total - g.items.length);
  const showLoops = loopsOpen || searching || g.loops.items.some((s) => s.id === app.currentId && app.homeView === 'chat');
  const more = async () => {
    setLoading(true);
    try { await app.loadMoreChats(g.key); } catch { app.showToast('Could not load more chats'); } finally { setLoading(false); }
  };
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
        {g.approvals.size > 0 && (
          <span title={`${g.approvals.size} chat(s) waiting on your approval`} style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--red)', borderRadius: 8, padding: '1px 6px', flex: 'none' }}>{g.approvals.size}</span>
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
          {g.items.length === 0 && g.loops.total === 0 && <div style={{ padding: '4px 10px', fontSize: 11.5, color: 'var(--text-faint)' }}>No conversations.</div>}
          {!searching && g.hasMore && remaining > 0 && (
            <button type="button" onClick={() => void more()} disabled={loading}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, fontWeight: 600, padding: '5px 10px', cursor: loading ? 'default' : 'pointer' }}>
              {loading ? 'Loading…' : `Show more (${remaining})`}
            </button>
          )}
          {g.loops.total > 0 && (
            <>
              <div role="button" tabIndex={0} onClick={() => setLoopsOpen(!loopsOpen)} onKeyDown={(e) => { if (e.key === 'Enter') setLoopsOpen(!loopsOpen); }}
                title="Scheduled loops and heartbeat runs, one row per agent"
                style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 9, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }}>
                <I d={P.clock} size={12} style={{ flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Heartbeat runs</span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none' }}>{g.loops.total}</span>
                <I d={P.chevD} size={11} style={{ transform: showLoops ? 'none' : 'rotate(-90deg)', transition: 'transform .12s', flex: 'none' }} />
              </div>
              {showLoops && (
                <div style={{ paddingLeft: 8 }}>
                  {g.loops.items.map((s) => <SessionRow key={s.id} s={s} approval={g.approvals.has(s.id)} />)}
                </div>
              )}
            </>
          )}
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
  const list = app.channels.filter((c) => !search || c.slug.includes(search) || c.topic.toLowerCase().includes(search));
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
      {list.map((c) => {
        const active = app.homeView === 'channel' && app.currentChannel === c.slug;
        return (
          <div key={c.id} onClick={() => app.openChannel(c.slug)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none' }}>
            <span style={{ fontWeight: 700, color: c.kind === 'private' ? 'var(--text-faint)' : 'var(--accent-hi)', width: 12, textAlign: 'center' }}>{c.kind === 'private' ? '🔒' : '#'}</span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: (c.unread ?? 0) > 0 ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.slug}</span>
            {(c.unread ?? 0) > 0 && <span title="Unread messages" style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--accent)', borderRadius: 8, padding: '1px 6px' }}>{c.unread}</span>}
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
  const q = search.trim().toLowerCase();
  // Search runs on the server (the rail is paged), so it finds chats in
  // collapsed groups and beyond the loaded pages; groups with a hit open.
  const [hits, setHits] = useState<ChatRail | null>(null);
  useEffect(() => {
    if (!q || !app.workspaceId) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.chatRail(app.workspaceId, { q, perAgent: 50 }).then((r) => { if (live) setHits(r); }).catch(() => { if (live) setHits({ groups: [], archivedTotal: 0 }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, app.workspaceId]);

  const currentAgentKey = useMemo(() => {
    if (app.homeView !== 'chat' || !app.currentId) return null;
    const s = app.sessions.find((x) => x.id === app.currentId);
    return s ? (s.agentId ?? '') : null;
  }, [app.sessions, app.currentId, app.homeView]);

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
      return {
        key, ...meta,
        total: use?.total ?? 0, items: use?.items ?? [], loops: use?.loops ?? { total: 0, items: [] },
        hasMore: !q && !!use?.nextCursor, approvals: new Set(base.get(key)?.approvalIds ?? []),
        unread: meta.isAgent ? app.unread[meta.id] ?? 0 : 0,
      };
    };
    for (const a of app.agents) {
      const v = view(a.id, { id: a.id, name: a.name, emoji: a.emoji, avatar: grad(a.colors), isAgent: true });
      if (v) out.push(v);
    }
    const ws = view('', { id: '__ws', name: 'Workspace', emoji: '🗂️', avatar: 'var(--panel-2)', isAgent: false });
    if (ws && (q || ws.total > 0 || ws.loops.total > 0 || out.length === 0)) out.push(ws);
    return out;
  }, [app.agents, app.chatRail, app.unread, hits, q]);

  /** Open: as the viewer set it by hand; otherwise only the open chat's
   *  group and groups that want you (unread, an approval). A search opens
   *  every group with a hit. */
  const isOpen = (g: RailGroupView) => {
    if (q) return true;
    if (explicit[g.key] !== undefined) return explicit[g.key];
    return g.key === currentAgentKey || g.unread > 0 || g.approvals.size > 0;
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
            onToggle={() => saveExplicit({ ...explicit, [g.key]: !isOpen(g) })} />
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

/** Icons of the Company rail's entries (groups in src/lib/inbox.ts). */
const PANE_ICON: Partial<Record<OrgPane, string[]>> = {
  vision: P.compass, goals: P.star, plans: P.rows, decisions: P.check,
  pulse: P.sun, meetings: P.chat, incidents: P.warn,
  chart: P.bot, spend: P.bolt, audit: P.clock,
};

/** Collapse state of the Company rail's groups, per viewer (localStorage, best effort). */
const GROUPS_KEY = 'yaam-company-groups';
function useCollapsed(): [Record<string, boolean>, (id: string) => void] {
  const [state, setState] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
  });
  const toggle = (id: string) => setState((prev) => {
    const next = { ...prev, [id]: !prev[id] };
    try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: keep it in memory */ }
    return next;
  });
  return [state, toggle];
}

function GroupLabel({ id, label, collapsed, onToggle }: { id: string; label: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button type="button" data-testid={`company-group-${id}`} aria-expanded={!collapsed} onClick={onToggle}
      style={{ ...sectionLabel, display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: '10px 10px 4px', textAlign: 'left' }}>
      <span style={{ flex: 1 }}>{label}</span>
      <I d={P.chevD} size={11} style={{ transform: collapsed ? 'rotate(-90deg)' : 'none', transition: 'transform .12s' }} />
    </button>
  );
}

function PaneRow({ id, label, icon, active, badge, badgeColor = 'var(--amber)', badgeTitle, onClick, indent = 0 }: { id: string; label: string; icon: string[]; active: boolean; badge?: number; badgeColor?: string; badgeTitle?: string; onClick: () => void; indent?: number }) {
  return (
    <div key={id} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', paddingLeft: 10 + indent, borderRadius: 9, cursor: 'pointer', fontSize: 13, margin: '1px 0', color: 'var(--text)', background: active ? 'var(--accent-dim)' : 'none' }}>
      <I d={icon} size={16} sw={1.9} style={{ flex: 'none' }} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && <span title={badgeTitle} style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: badgeColor, borderRadius: 8, padding: '1px 6px' }}>{badge}</span>}
    </div>
  );
}

/** One unit of the organization (docs/group-chat.md §7): the company at
 *  the top (`#company`, Board, Goals), then every unit below it as a
 *  collapsible group headed by its lead — `#<slug>`, Board, Goals — each
 *  opening the existing pane scoped to that unit (`orgUnitId`). */
function UnitGroup({ node, depth }: { node: OrgUnitNode; depth: number }) {
  const app = useApp();
  const isRoot = node.parentUnitId === null;
  const [open, setOpen] = useState(depth < 2);
  const lead = app.agents.find((a) => a.id === node.leadAgentId);
  const channel = app.channels.find((c) => c.id === node.channelId) ?? app.channels.find((c) => c.slug === node.slug);
  const unitId = isRoot ? null : node.id;
  const scoped = app.section === 'workspace' && app.orgUnitId === unitId;
  const pane = (id: OrgPane) => { app.setOrgUnitId(unitId); app.setOrgPane(id); app.setMobileDetail(true); };
  const indent = depth * 12;
  const channelActive = app.homeView === 'channel' && app.currentChannel === (channel?.slug ?? node.slug);
  // The CEO's seat (docs/company-vision.md §8): goals at risk in this unit and today's ritual.
  const atRisk = useMemo(() => atRiskByUnit(app.orgIntent), [app.orgIntent]);
  const risk = (atRisk[node.id] ?? 0) + (isRoot ? atRisk[''] ?? 0 : 0);
  const today = app.orgCadences.filter((c) => c.unitId === node.id && c.enabled === 1 && firesOn(c.cron)).map((c) => MEETING_KIND_TITLES[c.kind] ?? c.kind);
  return (
    <div style={{ marginBottom: 2 }}>
      <div onClick={() => !isRoot && setOpen(!open)} title={isRoot ? 'The company' : `${node.name} · led by ${lead?.name ?? 'an agent'} · ${node.memberAgentIds.length} member(s)`}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', paddingLeft: 10 + indent, borderRadius: 9, cursor: isRoot ? 'default' : 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
        {isRoot
          ? <span style={{ width: 18, height: 18, borderRadius: 6, background: 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flex: 'none' }}>🏢</span>
          : <span style={{ width: 18, height: 18, borderRadius: 6, background: lead ? grad(lead.colors) : 'var(--panel-2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flex: 'none' }}>{lead?.emoji ?? '?'}</span>}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isRoot ? 'Company' : node.name}</span>
        {today.length > 0 && <span title={`Today: ${today.join(', ')}`} onClick={(e) => { e.stopPropagation(); pane('meetings'); }} style={{ fontSize: 9.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 5, padding: '0 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>{today[0].toLowerCase()}{today.length > 1 ? ` +${today.length - 1}` : ''}</span>}
        {risk > 0 && <span title={`${risk} goal(s) at risk — open the vision page`} onClick={(e) => { e.stopPropagation(); pane('vision'); }} style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--amber)', borderRadius: 8, padding: '1px 6px' }}>{risk}</span>}
        {node.counts.openTasks > 0 && <span title="Open tasks on this board" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{node.counts.openTasks}</span>}
        {!isRoot && <I d={P.chevD} size={13} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .12s', color: 'var(--text-faint)', flex: 'none' }} />}
      </div>
      {open && (
        <>
          <div onClick={() => app.openChannel(channel?.slug ?? node.slug)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', paddingLeft: 22 + indent, borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: channelActive ? 'var(--accent-dim)' : 'none' }}>
            <span style={{ fontWeight: 700, color: 'var(--accent-hi)', width: 12, textAlign: 'center' }}>#</span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: (channel?.unread ?? 0) > 0 ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channel?.slug ?? node.slug}</span>
            {(channel?.unread ?? 0) > 0 && <span title="Unread messages" style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--accent)', borderRadius: 8, padding: '1px 6px' }}>{channel!.unread}</span>}
          </div>
          <PaneRow id={`${node.id}-board`} label="Board" icon={P.board} indent={12 + indent} active={scoped && app.orgPane === 'board'} onClick={() => pane('board')} />
          <PaneRow id={`${node.id}-goals`} label="Goals" icon={P.star} indent={12 + indent} active={scoped && app.orgPane === 'goals'} onClick={() => pane('goals')} />
          {node.children.map((c) => <UnitGroup key={c.id} node={c} depth={depth + 1} />)}
        </>
      )}
    </div>
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

/** The Company tab's rail (the Workspace section): the company's panes in
 *  collapsible groups — Teams (each unit's #channel, Board, Goals),
 *  Direction, Operations, People & money, Oversight. What waits on the CEO
 *  (approvals, keys, my tasks) lives in the Inbox; the files in Artifacts. */
export function WorkspaceRail() {
  const app = useApp();
  const [collapsed, toggle] = useCollapsed();
  const org = app.companiesEnabled && app.wsOrg && app.wsOrg.mode !== 'off' ? app.wsOrg : null;
  if (!org) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
        <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>Organization mode is off for this workspace — turn it on in Settings → Workspace.</div>
        <PaneRow id="open-artifacts" label="Open Artifacts" icon={P.files} active={false} onClick={() => app.go('artifacts')} />
      </div>
    );
  }
  const openIncidents = app.orgHealth?.openIncidents.length ?? 0;
  const view = app.orgPane ?? 'board';
  const badgeOf = (id: OrgPane): { n: number; color?: string; title: string } | undefined => {
    if (id === 'plans' && app.orgPendingPlans > 0) return { n: app.orgPendingPlans, title: `${app.orgPendingPlans} plan(s) awaiting your veto` };
    if (id === 'incidents' && openIncidents > 0) return { n: openIncidents, color: 'var(--red)', title: `${openIncidents} open incident(s)` };
    return undefined;
  };
  const open = (pane: OrgPane, unit: string | null = app.orgUnitId) => { app.setOrgUnitId(unit); app.setOrgPane(pane); app.setMobileDetail(true); };
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 12px' }}>
      <div style={{ ...sectionLabel, padding: '2px 10px 2px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1 }}>Organization</span>
        <span title={org.orgStatus === 'paused' ? 'Paused (kill switch)' : `${org.mode} mode`} style={{ fontSize: 9.5, fontWeight: 600, textTransform: 'none', letterSpacing: 0, color: org.orgStatus === 'paused' ? '#fff' : 'var(--text-dim)', background: org.orgStatus === 'paused' ? 'var(--red)' : 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 5, padding: '0 6px' }}>{org.orgStatus === 'paused' ? 'paused' : org.mode}</span>
      </div>
      {COMPANY_GROUPS.map((g) => (
        <div key={g.id}>
          <GroupLabel id={g.id} label={g.label} collapsed={Boolean(collapsed[g.id])} onToggle={() => toggle(g.id)} />
          {!collapsed[g.id] && g.id === 'teams' && (
            <>
              {/* Units (docs/group-chat.md §7): the company, then one collapsible group per live unit — #channel, Board, Goals. */}
              {(org.units ?? []).map((u) => <UnitGroup key={u.id} node={u} depth={0} />)}
              {(org.units ?? []).length === 0 && <PaneRow id="board" label="Board" icon={P.board} active={view === 'board' && app.orgUnitId === null} onClick={() => open('board', null)} />}
            </>
          )}
          {!collapsed[g.id] && g.entries.map((e) => {
            const b = badgeOf(e.pane);
            const active = app.section === 'workspace' && (e.tabs ? e.tabs.includes(view) : view === e.pane) && (e.pane !== 'goals' || app.orgUnitId === null);
            return <PaneRow key={e.pane} id={e.pane} label={e.label} icon={PANE_ICON[e.pane] ?? P.board} active={active} badge={b?.n} badgeColor={b?.color} badgeTitle={b?.title}
              onClick={() => open(e.pane, e.pane === 'goals' ? null : app.orgUnitId)} />;
          })}
        </div>
      ))}
    </div>
  );
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
  { id: 'usage', label: 'Usage', icon: P.bolt },
  { id: 'channels', label: 'Channels', icon: P.chat },
  { id: 'connections', label: 'Connections', icon: P.globe },
  { id: 'runner', label: 'Code runner & browser', icon: P.shield },
  { id: 'computer', label: 'Computer', icon: P.window },
  { id: 'market', label: 'Market', icon: P.market },
  { id: 'security', label: 'Security', icon: P.shield },
];

export function SettingsRail({ pane, setPane }: { pane: string; setPane: (p: string) => void }) {
  const app = useApp();
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
      {SETTINGS_PANES.map((n) => (
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
