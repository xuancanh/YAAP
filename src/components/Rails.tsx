/** Secondary panel: workspace pill, the combined Home rail (agents → their
 *  chats + their folder, YAAM-style), market categories, and settings nav. */
import { useEffect, useMemo, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, type CompanyView } from '../store';
import { api, type ChatSession } from '../lib/api';
import { safeJsonParse } from '../lib/util';

const sectionLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '2px 18px 8px' };

/** Rail chip order: professional clusters first, then personal life; anything
 *  the catalog adds beyond this list appends at the end. */
const CAT_ORDER = [
  'Workplace', 'Product & Engineering', 'Education', 'Legal & Finance', 'Writing & Media',
  'Care & Community', 'Property & Field', 'Small Business',
  'Family & Care', 'Home & Money', 'Health & Growth', 'Events & Travel', 'Hobbies & Leisure',
];

/** Category list for the market rails, in canonical order, 'All' first. Lives
 *  here (not in MarketView) so the rail doesn't pull the lazy view's chunk. */
export function marketCats(market: Array<{ cat: string }>): string[] {
  const found = Array.from(new Set(market.map((m) => m.cat)));
  return ['All', ...CAT_ORDER.filter((c) => found.includes(c)), ...found.filter((c) => !CAT_ORDER.includes(c))];
}

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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const ws = app.workspaces.find((w) => w.id === app.workspaceId);
  if (!ws) return null;
  return (
    <div style={{ padding: '12px 12px 8px', position: 'relative' }}>
      <button onClick={() => setOpen(!open)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 11px', color: 'var(--text)', cursor: 'pointer' }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: ws.color, flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>workspace · s3</div>
        </div>
        <I d={P.upDown} size={13} stroke="var(--text-faint)" style={{ flex: 'none' }} />
      </button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% - 2px)', left: 12, right: 12, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow)', zIndex: 50, padding: 6, animation: 'msgIn .12s' }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '6px 8px 4px' }}>Workspaces · scope chats</div>
          {app.workspaces.map((w) => (
            <div key={w.id} onClick={() => { app.pickWorkspace(w.id); setOpen(false); app.showToast(`Switched to ${w.name}`); }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 9px', borderRadius: 8, cursor: 'pointer', margin: '1px 0', background: w.id === app.workspaceId ? 'var(--panel-2)' : 'none' }}>
              <span style={{ width: 9, height: 9, borderRadius: 3, background: w.color, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{w.name}</div>
              </div>
              {w.id === app.workspaceId && <I d={P.check} size={14} stroke="var(--accent)" sw={2.5} />}
            </div>
          ))}
          {adding ? (
            <div style={{ display: 'flex', gap: 6, padding: '8px 9px', borderTop: '1px solid var(--border-soft)', marginTop: 4 }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={creating}
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing || !name.trim() || creating) return;
                  setCreating(true);
                  try {
                    await api.createWorkspace(name.trim());
                    await app.refreshWorkspaces();
                    setName(''); setAdding(false);
                  } finally {
                    setCreating(false);
                  }
                }}
                placeholder="Workspace name" style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 8px', color: 'var(--text)', fontSize: 12.5, outline: 'none' }} />
            </div>
          ) : (
            <div onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 9px', borderRadius: 8, cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12.5, borderTop: '1px solid var(--border-soft)', marginTop: 4 }}>
              <I d={P.plus} size={14} />Add workspace
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionRow({ s }: { s: ChatSession }) {
  const app = useApp();
  const tags = safeJsonParse<string[]>(s.tags, []);
  const active = s.id === app.currentId && app.homeView === 'chat';
  return (
    <div onClick={() => app.openSession(s.id)} style={{ padding: '7px 10px', borderRadius: 9, cursor: 'pointer', margin: '1px 0', background: active ? 'var(--accent-dim)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {s.pinned === 1 && <I d={P.pin} size={11} fill="var(--amber)" style={{ flex: 'none' }} />}
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.autoTitle || 'New chat'}</span>
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

const fileGlyph = (name: string, isFolder: boolean) =>
  isFolder ? '📁' : name.endsWith('.md') ? '📄' : name.endsWith('.json') ? '⚙️' : name.endsWith('.html') ? '🧩' : name.match(/\.(png|jpg|jpeg|gif|svg|webp)$/) ? '🖼️' : '📄';

/** The file tree for whichever fs (workspace or one agent) is currently
 *  loaded in the store — the rail keeps a single fs open, accordion-style. */
function FileTree({ indent }: { indent: number }) {
  const app = useApp();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ knowledge: true, uploads: true });

  const rows = useMemo(() => {
    const folders = new Set<string>();
    for (const f of app.fileList) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    const out: Array<{ path: string; name: string; depth: number; isFolder: boolean; parent: string | null }> = [];
    for (const folder of [...folders].sort()) {
      const depth = folder.split('/').length - 1;
      out.push({ path: folder, name: folder.split('/').pop() + '/', depth, isFolder: true, parent: depth === 0 ? null : folder.split('/').slice(0, -1).join('/') });
    }
    for (const f of app.fileList) {
      const parts = f.path.split('/');
      const depth = parts.length - 1;
      out.push({ path: f.path, name: parts[parts.length - 1], depth, isFolder: false, parent: depth === 0 ? null : parts.slice(0, -1).join('/') });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out.filter((n) => {
      let p = n.parent;
      while (p) {
        if (!expanded[p]) return false;
        p = p.includes('/') ? p.split('/').slice(0, -1).join('/') : null;
      }
      return true;
    });
  }, [app.fileList, expanded]);

  if (app.fileList.length === 0) {
    return <div style={{ padding: '4px 10px 6px', paddingLeft: indent, fontSize: 11.5, color: 'var(--text-faint)' }}>No files yet.</div>;
  }
  return (
    <>
      {rows.map((n) => (
        <div key={n.path}
          onClick={() => n.isFolder ? setExpanded((e) => ({ ...e, [n.path]: !e[n.path] })) : app.openFile(app.fileTarget!, n.path)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', paddingLeft: indent + n.depth * 13, borderRadius: 7, cursor: 'pointer', background: !n.isFolder && n.path === app.currentFile && app.homeView === 'file' ? 'var(--accent-dim)' : 'none' }}>
          {n.isFolder
            ? <I d={P.chevD} size={11} stroke="var(--text-faint)" style={{ transform: expanded[n.path] ? 'rotate(0deg)' : 'rotate(-90deg)', flex: 'none' }} />
            : <span style={{ width: 11, flex: 'none' }} />}
          <span style={{ flex: 'none', fontSize: 11.5 }}>{fileGlyph(n.name, n.isFolder)}</span>
          <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: n.path === app.currentFile && app.homeView === 'file' ? 'var(--accent-hi)' : 'var(--text-dim)' }}>{n.name}</span>
        </div>
      ))}
    </>
  );
}

/** One root in the combined rail — everything about a single agent: identity
 *  row (opens the agent home), its conversations, and its isolated folder. */
function AgentGroup({ id, name, emoji, avatar, items, count, isAgent }: {
  id: string; name: string; emoji: string; avatar: string; items: ChatSession[]; count: number; isAgent: boolean;
}) {
  const app = useApp();
  const [open, setOpen] = useState(true);
  const agentActive = isAgent && app.selectedAgent === id && app.homeView === 'agent';

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 8px', borderRadius: 9, cursor: 'pointer', background: agentActive ? 'var(--accent-dim)' : 'none' }}
        onClick={() => { if (isAgent) app.openAgent(id); else setOpen(!open); }}>
        <div style={{ width: 24, height: 24, borderRadius: 7, background: avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 12.5 }}>{emoji}</div>
        <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        {isAgent && (app.unread[id] ?? 0) > 0 && (
          <span title="Unread activity from loops and proactive work" style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--amber)', borderRadius: 8, padding: '1px 6px' }}>{app.unread[id]}</span>
        )}
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', background: 'var(--panel-2)', borderRadius: 5, padding: '1px 6px' }}>{count}</span>
        <button onClick={(e) => { e.stopPropagation(); void app.newChat(isAgent ? id : null); }} title="New chat" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <I d={P.plus} size={14} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setOpen(!open); }} title={open ? 'Collapse' : 'Expand'} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}>
          <I d={P.chevD} size={12} style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        </button>
      </div>
      {open && (
        <div style={{ paddingLeft: 10, borderLeft: '1px solid var(--border-soft)', marginLeft: 19 }}>
          {items.map((s) => <SessionRow key={s.id} s={s} />)}
          {items.length === 0 && <div style={{ padding: '4px 10px', fontSize: 11.5, color: 'var(--text-faint)' }}>No conversations.</div>}

        </div>
      )}
    </div>
  );
}

/** The Home rail: one tree combining agents, their chats, and their folders,
 *  plus workspace-level chats/files and the archive — the YAAM layout. */
export function HomeRail() {
  const app = useApp();
  const [search, setSearch] = useState('');
  const [archOpen, setArchOpen] = useState(false);
  const q = search.toLowerCase();

  const groups = useMemo(() => {
    const match = (s: ChatSession) => !q || (s.name || s.autoTitle).toLowerCase().includes(q) || s.tags.toLowerCase().includes(q);
    const byPin = (a: ChatSession, b: ChatSession) => (b.pinned - a.pinned) || (a.updatedAt < b.updatedAt ? 1 : -1);
    const out: Array<{ id: string; name: string; emoji: string; avatar: string; count: number; items: ChatSession[]; isAgent: boolean }> = [];
    for (const a of app.agents) {
      const all = app.sessions.filter((s) => s.agentId === a.id);
      const items = all.filter(match).sort(byPin);
      if (q && items.length === 0 && !a.name.toLowerCase().includes(q)) continue;
      out.push({ id: a.id, name: a.name, emoji: a.emoji, avatar: grad(a.colors), count: all.length, items, isAgent: true });
    }
    const direct = app.sessions.filter((s) => !s.agentId);
    const items = direct.filter(match).sort(byPin);
    if (!(q && items.length === 0)) {
      out.push({ id: '__ws', name: 'Workspace', emoji: '🗂️', avatar: 'var(--panel-2)', count: direct.length, items, isAgent: false });
    }
    return out;
  }, [app.agents, app.sessions, q]);

  return (
    <>
      <div style={{ padding: '0 12px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9, padding: '7px 10px', marginBottom: 10 }}>
          <I d={P.search} size={14} stroke="var(--text-faint)" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 13, minWidth: 0 }} />
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
        {groups.map((g) => <AgentGroup key={g.id} {...g} />)}
        {app.archived.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
            <div onClick={() => setArchOpen(!archOpen)} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: 8, borderRadius: 9, cursor: 'pointer', color: 'var(--text-faint)' }}>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>Archived</span>
              <span style={{ fontSize: 10.5, background: 'var(--panel-2)', borderRadius: 5, padding: '1px 6px' }}>{app.archived.length}</span>
              <I d={P.chevD} size={12} style={{ transform: archOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            </div>
            {archOpen && app.archived.map((s) => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 9, margin: '2px 0' }}>
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name || s.autoTitle || 'Chat'}</span>
                <button onClick={() => void app.restoreChat(s.id)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Restore</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** The Workspace tab's rail: the shared file store tree. */
export function WorkspaceRail() {
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
      <FileTree indent={8} />
    </div>
  );
}

export function MarketRail({ cat, setCat }: { cat: string; setCat: (c: string) => void }) {
  const app = useApp();
  const cats = marketCats(app.market);
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
      {cats.map((c) => (
        <div key={c} onClick={() => setCat(c)} style={{ display: 'flex', alignItems: 'center', padding: '7px 9px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, margin: '1px 0', background: c === cat ? 'var(--accent-dim)' : 'none', color: c === cat ? 'var(--text)' : 'var(--text-dim)' }}>
          <span style={{ flex: 1 }}>{c}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{c === 'All' ? app.market.length : app.market.filter((m) => m.cat === c).length}</span>
        </div>
      ))}
      <div style={{ margin: '14px 8px 0', padding: 12, border: '1px solid var(--border-soft)', borderRadius: 11, background: 'var(--panel-2)', fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        Registry profiles get a capability review before install — imported loops enable immediately.
      </div>
    </div>
  );
}

export const SETTINGS_PANES = [
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

export const COMPANY_VIEWS: Array<{ id: CompanyView; label: string; icon: string[] }> = [
  { id: 'board', label: 'Board', icon: P.board },
  { id: 'chart', label: 'Org chart', icon: P.bot },
  { id: 'goals', label: 'Goals', icon: P.star },
  { id: 'approvals', label: 'Approvals', icon: P.shield },
  { id: 'spend', label: 'Spend', icon: P.bolt },
  { id: 'activity', label: 'Activity', icon: P.clock },
  { id: 'chat', label: 'Group chat', icon: P.chat },
  { id: 'brief', label: 'Brief', icon: P.sysLines },
];

/** The Company rail (docs/autonomous-company.md §4.4): org picker plus the
 *  CEO's views. Creating an org happens in the main pane (CompanyView). */
export function CompanyRail() {
  const app = useApp();
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 12px' }}>
      <div style={{ padding: '0 2px 8px' }}>
        <select value={app.orgId ?? ''} onChange={(e) => app.pickOrg(e.target.value || null)}
          style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 10px', color: 'var(--text)', fontSize: 13 }}>
          {app.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.status === 'paused' ? ' · paused' : ''}</option>)}
          <option value="">{app.orgs.length === 0 ? 'No organisation yet — create one' : '+ New organisation'}</option>
        </select>
      </div>
      {app.orgId && COMPANY_VIEWS.map((n) => (
        <div key={n.id} onClick={() => { app.setCompanyView(n.id); app.setMobileDetail(true); }} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', fontSize: 13, margin: '1px 0', color: 'var(--text)', background: n.id === app.companyView ? 'var(--accent-dim)' : 'none' }}>
          <I d={n.icon} size={16} sw={1.9} style={{ flex: 'none' }} />
          <span style={{ flex: 1 }}>{n.label}</span>
        </div>
      ))}
      <div style={{ margin: '14px 8px 0', padding: 12, border: '1px solid var(--border-soft)', borderRadius: 11, background: 'var(--panel-2)', fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        A task board with one owner per task, event wakes instead of heartbeats, and a chief of staff that proposes while you decide.
      </div>
    </div>
  );
}
