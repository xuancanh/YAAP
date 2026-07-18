/** Agents: the directory grid, the create-agent dialog, and the per-agent
 *  home page — tabbed like YAAM: Dashboard (agent-maintained markdown),
 *  Mini apps (self-built, embeddable), Chats, Memory (file brain), Settings. */
import { useEffect, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, gradPair } from '../store';
import { AppHost, CapReviewModal, pendingCaps } from './AppHost';
import { api, type Agent, type AgentApp, type AgentCustomTool, type AgentEvent, type AgentTask, type FileEntry, type FilePreview, type Skill } from '../lib/api';
import { Markdown } from '../lib/md';
import { nextFire, untilLabel } from '../lib/cron';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)' };
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--text-faint)' };

function ago(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function parseApps(a: Agent): AgentApp[] {
  try { return JSON.parse(a.apps) as AgentApp[]; } catch { return []; }
}

interface PendingImport {
  profile: Record<string, unknown>;
  name: string;
  loops: Array<{ name: string; cron: string }>;
}

/** FR-11.7: imported loops enable immediately, so review them first. */
function ImportReviewModal({ pending, onClose }: { pending: PendingImport; onClose: () => void }) {
  const app = useApp();
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 480, maxWidth: '100%', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Review before importing {pending.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>AGENT.json · profile, charter{pending.loops.length ? ` and ${pending.loops.length} loop(s)` : ''}</div>
        </div>
        <div style={{ padding: '18px 24px' }}>
          {pending.loops.length > 0 ? (
            <div style={{ padding: '13px 15px', border: '1px solid var(--amber)', borderRadius: 11, background: 'color-mix(in oklab,var(--amber) 12%,transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>
                <I d={P.warn} size={15} />Scheduled loops enable immediately on import
              </div>
              {pending.loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{l.cron}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>No scheduled loops in this profile.</div>
          )}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10 }}>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={async () => {
            try {
              const agent = await api.importAgent(pending.profile);
              await app.refreshAgents();
              app.openAgent(agent.id);
              app.showToast(`Imported ${agent.name}`);
            } catch (err) {
              app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'import failed');
            }
            onClose();
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Approve & import</button>
        </div>
      </div>
    </div>
  );
}

const EMOJIS = ['🤖', '🛡️', '🗺️', '⏱️', '📚', '🧾', '🎨', '🔭', '🧠', '⚙️', '🌱', '🦉'];
const COLOR_PAIRS: Array<[string, string]> = [
  ['#8b8cf0', '#5cc2f2'], ['#f0708b', '#f2b45c'], ['#5cc98f', '#3aa7c9'],
  ['#c98bf0', '#f070b4'], ['#f2c94c', '#f2784b'], ['#6bd1c6', '#8b8cf0'],
];

/** Create-agent dialog, opened from the Home rail's "New agent" button. */
export function NewAgentDialog() {
  const app = useApp();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [charter, setCharter] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [colors, setColors] = useState<[string, string]>(COLOR_PAIRS[0]);
  const [busy, setBusy] = useState(false);
  if (!app.newAgentOpen) return null;
  const close = () => { app.setNewAgentOpen(false); setName(''); setRole(''); setCharter(''); };

  const field: React.CSSProperties = { width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 12px', color: 'var(--text)', fontSize: 13, outline: 'none' };
  return (
    <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 500, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 13 }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: gradPair(colors), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 21, flex: 'none' }}>{emoji}</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>New durable agent</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 1 }}>A persistent identity with its own charter, memory, and home page.</div>
          </div>
        </div>
        <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <div style={{ ...label, marginBottom: 6 }}>Name</div>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sentinel" style={field} />
          </div>
          <div>
            <div style={{ ...label, marginBottom: 6 }}>Role</div>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Security watchdog" style={field} />
          </div>
          <div>
            <div style={{ ...label, marginBottom: 6 }}>Charter</div>
            <textarea value={charter} onChange={(e) => setCharter(e.target.value)} placeholder="Who is this agent, what does it own, how should it act?" style={{ ...field, minHeight: 90, resize: 'vertical', lineHeight: 1.55 }} />
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <div>
              <div style={{ ...label, marginBottom: 6 }}>Avatar</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 240 }}>
                {EMOJIS.map((e) => (
                  <button key={e} onClick={() => setEmoji(e)} style={{ width: 32, height: 32, borderRadius: 9, fontSize: 16, cursor: 'pointer', background: e === emoji ? 'var(--accent-dim)' : 'var(--panel-2)', border: e === emoji ? '1px solid var(--accent)' : '1px solid var(--border-soft)' }}>{e}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ ...label, marginBottom: 6 }}>Colors</div>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {COLOR_PAIRS.map((c) => (
                  <button key={c[0]} onClick={() => setColors(c)} style={{ width: 32, height: 32, borderRadius: 9, cursor: 'pointer', background: gradPair(c), border: c[0] === colors[0] ? '2px solid var(--text)' : '1px solid var(--border-soft)' }} />
                ))}
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding: '14px 24px 18px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10 }}>
          <button onClick={close} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button disabled={!name.trim() || busy} onClick={async () => {
            setBusy(true);
            try {
              const agent = await api.createAgent({ name: name.trim(), role: role.trim(), charter, emoji, colors });
              await app.refreshAgents();
              close();
              app.openAgent(agent.id);
              app.showToast(`Created ${agent.name} — start its first conversation`);
            } catch (err) {
              app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'create failed');
            }
            setBusy(false);
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: name.trim() ? 'pointer' : 'default', opacity: name.trim() ? 1 : 0.5 }}>Create agent</button>
        </div>
      </div>
    </div>
  );
}

/** Fleet row: what one agent is doing right now — current/next task, next
 *  scheduled loop, latest activity — with one-click ways in. */
function FleetRow({ a }: { a: Agent }) {
  const app = useApp();
  const stats = app.agentStats[a.id];
  const unread = app.unread[a.id] ?? 0;
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [latest, setLatest] = useState<AgentEvent | null>(null);
  useEffect(() => {
    void api.agentTasks(a.id).then(setTasks).catch(() => setTasks([]));
    void api.agentEvents(a.id).then((ev) => setLatest(ev[0] ?? null)).catch(() => setLatest(null));
  }, [a.id]);

  const doing = tasks.filter((t) => t.status === 'doing').sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  const todo = tasks.filter((t) => t.status === 'todo').sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  const loops = (() => { try { return (JSON.parse(a.loops) as Loop[]).filter((l) => l.enabled !== false); } catch { return []; } })();
  const upcoming = loops
    .map((l) => ({ l, at: l.cron ? nextFire(l.cron) : null }))
    .filter((x): x is { l: Loop; at: Date } => x.at !== null)
    .sort((x, y) => x.at.getTime() - y.at.getTime())[0];
  const working = doing.length > 0;

  const cell = (labelText: string, value: React.ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 3 }}>{labelText}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );

  return (
    <div onClick={() => app.openAgent(a.id)} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: '16px 18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: grad(a.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 20, position: 'relative' }}>
          {a.emoji}
          <span style={{ position: 'absolute', right: -2, bottom: -2, width: 11, height: 11, borderRadius: '50%', background: working ? 'var(--amber)' : 'var(--green)', border: '2px solid var(--panel)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, letterSpacing: '-.2px' }}>{a.name}</span>
            <span style={{ fontSize: 11, fontWeight: 600, color: working ? 'var(--amber)' : 'var(--text-faint)' }}>{working ? 'working' : 'idle'}</span>
            {unread > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: 'var(--amber)', borderRadius: 8, padding: '1px 6px' }}>{unread} new</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.role || 'Durable agent'}</div>
        </div>
        <span style={{ fontSize: 11.5, color: 'var(--green)', fontWeight: 600, flex: 'none' }}>{stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}%` : ''}</span>
        <button onClick={(e) => { e.stopPropagation(); void app.newChat(a.id); }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
          <I d={P.chat} size={13} />Chat
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '1fr 1fr 1fr', gap: 12, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
        {cell('Now', doing[0] ? doing[0].title : latest ? `${latest.title} · ${ago(latest.createdAt)}` : 'nothing in progress')}
        {cell('Next task', todo[0] ? `${todo[0].title}${todo.length > 1 ? `  (+${todo.length - 1} queued)` : ''}` : 'board is clear')}
        {cell('Next loop', upcoming ? `${upcoming.l.name} · ${untilLabel(upcoming.at)}` : loops.length > 0 ? `${loops.length} scheduled` : 'no schedule')}
      </div>
    </div>
  );
}

export function AgentsDirectory() {
  const app = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);

  const onPickFile = async (file: File) => {
    try {
      const profile = JSON.parse(await file.text()) as Record<string, unknown>;
      setPending({
        profile,
        name: typeof profile.name === 'string' ? profile.name : 'agent',
        loops: Array.isArray(profile.loops) ? (profile.loops as Array<{ name: string; cron: string }>) : [],
      });
    } catch {
      app.showToast('Not a valid AGENT.json file');
    }
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '30px 28px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: '-.4px' }}>Your agents</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13.5, marginTop: 4 }}>What everyone is doing right now — current work, queued tasks, and the next scheduled run.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <I d={P.download} size={15} style={{ transform: 'rotate(180deg)' }} />Import AGENT.json
            </button>
            <button onClick={() => app.go('market')} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <I d={P.market} size={15} />Hire an agent
            </button>
            <button onClick={() => app.setNewAgentOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <I d={P.plus} size={15} />New agent
            </button>
          </div>
        </div>
        {app.agents.length === 0 && (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13.5 }}>No agents yet — create one, or hire from the Market.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 22 }}>
          {app.agents.map((a) => <FleetRow key={a.id} a={a} />)}
        </div>
      </div>
      {pending && <ImportReviewModal pending={pending} onClose={() => setPending(null)} />}
    </div>
  );
}

/** Full-screen sandboxed viewer for one mini app — same trust model as chat
 *  artifacts: opaque origin, allow-scripts only, no network (FR-13.1); the
 *  window.yaam bridge (AppHost) adds only what the manifest granted. */
export function AppViewer({ agentId, miniApp, onClose }: { agentId: string; miniApp: AgentApp; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 90, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 4vw' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', maxWidth: 1100, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)' }}>
        <div style={{ height: 42, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{miniApp.name}</span>
          {miniApp.description && <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{miniApp.description}</span>}
          <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--mono)' }}>
            {(miniApp.approved ?? []).length > 0 ? `caps: ${(miniApp.approved ?? []).join(' ')} · ` : ''}sandboxed · no network · updated {ago(miniApp.updatedAt)}
          </span>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 }}>
            <I d={P.x} size={14} />
          </button>
        </div>
        <AppHost agentId={agentId} miniApp={miniApp} />
      </div>
    </div>
  );
}

function ConversationRow({ s, onOpen }: { s: { id: string; name: string; autoTitle: string; updatedAt: string }; onOpen: () => void }) {
  return (
    <div onClick={onOpen} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--panel-2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <I d={P.chat} size={13} stroke="var(--text-faint)" style={{ flex: 'none' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name || s.autoTitle || 'New chat'}</span>
      <span style={{ fontSize: 10, color: 'var(--text-faint)', flex: 'none', fontFamily: 'var(--mono)' }}>{ago(s.updatedAt)}</span>
    </div>
  );
}

const ORIGIN_BADGE: Record<AgentTask['origin'], string> = { user: 'you', agent: 'self', promote: 'chat', loop: 'loop' };
const COLS: Array<{ id: AgentTask['status']; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'doing', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

/** The agent's own kanban board: drag between columns (or use the arrows),
 *  quick-add into To do. The agent works the same board via list_tasks /
 *  add_task / update_task, so loops and chats land here too. */
function TasksBoard({ a, tasks, reload }: { a: Agent; tasks: AgentTask[]; reload: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const dragId = useRef<string | null>(null);

  const move = async (taskId: string, status: AgentTask['status']) => {
    await api.updateAgentTask(a.id, taskId, { status });
    reload();
  };
  const add = async () => {
    if (!title.trim()) return;
    await api.addAgentTask(a.id, { title: title.trim() });
    setTitle('');
    reload();
  };

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder={`Add a task for ${a.name}…`}
          style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 12px', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
        <button onClick={() => void add()} disabled={!title.trim()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: title.trim() ? 'pointer' : 'default', opacity: title.trim() ? 1 : 0.5 }}>Add</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(3,1fr)', gap: 12, alignItems: 'start' }}>
        {COLS.map((col, ci) => {
          const items = tasks.filter((t) => t.status === col.id).sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
          return (
            <div key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragId.current) void move(dragId.current, col.id); dragId.current = null; }}
              style={{ ...card, background: 'var(--panel-2)', padding: '10px 10px 12px', minHeight: 120 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 8px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: col.id === 'done' ? 'var(--green)' : col.id === 'doing' ? 'var(--amber)' : 'var(--text-faint)', flex: 'none' }} />
                <span style={{ ...label }}>{col.label}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 'auto' }}>{items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((t) => (
                  <div key={t.id} draggable onDragStart={() => { dragId.current = t.id; }}
                    style={{ ...card, padding: '10px 12px', cursor: 'grab' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.45, textDecoration: t.status === 'done' ? 'line-through' : 'none', color: t.status === 'done' ? 'var(--text-dim)' : 'var(--text)' }}>{t.title}</div>
                    {t.note && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{t.note}</div>}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                      <span style={{ fontSize: 9.5, fontFamily: 'var(--mono)', color: 'var(--text-faint)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 5, padding: '1px 6px' }}>{ORIGIN_BADGE[t.origin] ?? t.origin}</span>
                      {t.sessionId && (
                        <button onClick={() => app.openSession(t.sessionId!)} title="Open the source conversation" style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 10.5, cursor: 'pointer', padding: 0 }}>from chat</button>
                      )}
                      <span style={{ flex: 1 }} />
                      {ci > 0 && (
                        <button onClick={() => void move(t.id, COLS[ci - 1].id)} title={`Move to ${COLS[ci - 1].label}`} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                          <I d={P.chevL} size={13} />
                        </button>
                      )}
                      {ci < COLS.length - 1 && (
                        <button onClick={() => void move(t.id, COLS[ci + 1].id)} title={`Move to ${COLS[ci + 1].label}`} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                          <I d={P.chevL} size={13} style={{ transform: 'rotate(180deg)' }} />
                        </button>
                      )}
                      <button onClick={async () => { await api.deleteAgentTask(a.id, t.id); reload(); }} title="Delete task" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                        <I d={P.x} size={11} />
                      </button>
                    </div>
                  </div>
                ))}
                {items.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '6px 4px' }}>Nothing here.</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 12, lineHeight: 1.5 }}>
        {a.name} works this board too: it queues work with <span style={{ fontFamily: 'var(--mono)' }}>add_task</span> and moves cards with <span style={{ fontFamily: 'var(--mono)' }}>update_task</span> — including during scheduled loops. Promoting a chat turn drops it into To do.
      </div>
    </div>
  );
}

interface Loop { name: string; cron: string; prompt?: string; enabled?: boolean; model?: string; budgetTokens?: number }

/** Schedule editor: the agent's recurring loops (cron + prompt), each firing a
 *  real auto-mode turn in its "Loop · name" conversation. */
function ScheduleTab({ a }: { a: Agent }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const loops = (() => { try { return JSON.parse(a.loops) as Loop[]; } catch { return []; } })();

  const save = async (next: Loop[]) => {
    try {
      await api.updateAgent(a.id, { loops: JSON.stringify(next) });
      await app.refreshAgents();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'saving loops failed');
    }
  };

  const field: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 12.5, outline: 'none' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
      <div style={{ ...card, padding: '14px 16px' }}>
        <div style={{ ...label, marginBottom: 10 }}>Add a loop</div>
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '1fr 150px', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Loop name, e.g. Morning sweep" style={field} />
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" style={{ ...field, fontFamily: 'var(--mono)' }} />
        </div>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt for each run (optional — defaults to 'follow your charter and do this loop's work')"
          style={{ ...field, width: '100%', minHeight: 56, resize: 'vertical', marginTop: 8, lineHeight: 1.5 }} />
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '1fr 1fr', gap: 8, marginTop: 8 }}>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model override (optional — a cheap model keeps heartbeats near-free)" style={{ ...field, fontFamily: 'var(--mono)' }} />
          <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Token budget (optional — hard stop, surfaces in Activity)" style={{ ...field, fontFamily: 'var(--mono)' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>5-field cron · runs land in the "Loop · {name.trim() || 'name'}" conversation in auto mode</span>
          <button disabled={!name.trim() || !cron.trim() || loops.length >= 10} onClick={async () => {
            await save([...loops, {
              name: name.trim(), cron: cron.trim(),
              ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
              ...(model.trim() ? { model: model.trim() } : {}),
              ...(budget && parseInt(budget, 10) > 0 ? { budgetTokens: parseInt(budget, 10) } : {}),
            }]);
            setName(''); setPrompt(''); setModel(''); setBudget('');
            app.showToast('Loop added — it fires on the next matching minute');
          }} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 15px', fontSize: 12.5, fontWeight: 600, cursor: name.trim() && cron.trim() ? 'pointer' : 'default', opacity: name.trim() && cron.trim() && loops.length < 10 ? 1 : 0.5 }}>Add loop</button>
        </div>
      </div>

      <div style={{ ...card, padding: '6px 8px' }}>
        {loops.length === 0 && <div style={{ padding: '12px 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>No loops yet — schedule recurring work above, or import an agent profile that ships some.</div>}
        {loops.map((l, i) => (
          <div key={`${l.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 10px', borderTop: i > 0 ? '1px solid var(--border-soft)' : 'none' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.enabled === false ? 'var(--text-faint)' : 'var(--green)', flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, textDecoration: l.enabled === false ? 'line-through' : 'none', color: l.enabled === false ? 'var(--text-dim)' : 'var(--text)' }}>{l.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.cron}{l.model ? ` · ${l.model}` : ''}{l.budgetTokens ? ` · ≤${(l.budgetTokens / 1000).toFixed(0)}k tok` : ''}{l.prompt ? ` · ${l.prompt.replace(/\s+/g, ' ').slice(0, 50)}` : ''}
              </div>
            </div>
            <button onClick={() => void save(loops.map((x, xi) => (xi === i ? { ...x, enabled: x.enabled === false ? undefined : false } as Loop : x)))}
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
              {l.enabled === false ? 'Resume' : 'Pause'}
            </button>
            <button onClick={() => { if (window.confirm(`Remove the loop "${l.name}"?`)) void save(loops.filter((_, xi) => xi !== i)); }}
              title="Remove loop" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 3, display: 'flex', flex: 'none' }}>
              <I d={P.x} size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The agent's isolated folder as a tab: file list + rich preview. The brain
 *  (LESSONS.md / JOURNAL.md / knowledge/) lives here. */
function AgentFilesTab({ a }: { a: Agent }) {
  const app = useApp();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [sel, setSel] = useState<string | null>('LESSONS.md');
  const [preview, setPreview] = useState<FilePreview | null>(null);

  useEffect(() => {
    void api.agentFiles(a.id, app.workspaceId || undefined).then((f) => {
      setFiles(f.sort((x, y) => x.path.localeCompare(y.path)));
      setSel((cur) => (cur && f.some((e) => e.path === cur) ? cur : f[0]?.path ?? null));
    }).catch(() => setFiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id]);
  useEffect(() => {
    setPreview(null);
    if (sel) void api.agentPreview(a.id, sel, app.workspaceId || undefined).then(setPreview).catch(() => setPreview(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, sel]);

  const glyph = (p: string) => p.startsWith('shared/') ? '🔗' : p.endsWith('.md') ? '📄' : p.endsWith('.html') ? '🧩' : p.match(/\.(png|jpg|jpeg|gif|svg|webp)$/) ? '🖼️' : '📄';
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '230px 1fr', gap: 12, alignItems: 'start' }}>
        <div style={{ ...card, padding: '6px 6px', maxHeight: 480, overflowY: 'auto' }}>
          {files.map((f) => (
            <div key={f.path} onClick={() => setSel(f.path)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 9px', borderRadius: 8, cursor: 'pointer', background: f.path === sel ? 'var(--accent-dim)' : 'none' }}>
              <span style={{ fontSize: 12, flex: 'none' }}>{glyph(f.path)}</span>
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: f.path === sel ? 'var(--accent-hi)' : 'var(--text-dim)' }}>{f.path}</span>
              <span style={{ fontSize: 9.5, color: 'var(--text-faint)', flex: 'none' }}>{(f.size / 1024).toFixed(1)}K</span>
            </div>
          ))}
          {files.length === 0 && <div style={{ padding: '10px 10px', fontSize: 12, color: 'var(--text-faint)' }}>No files yet.</div>}
        </div>
        <div style={{ ...card, overflow: 'hidden', height: 480, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', borderBottom: '1px solid var(--border-soft)', background: 'var(--panel-2)' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sel ?? 'no file selected'}</span>
            {preview?.kind === 'html' && preview.text && (
              <button onClick={() => app.openArtifact(sel!.split('/').pop()!, preview.text!)} style={{ marginLeft: 'auto', background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Open preview</button>
            )}
            {sel?.startsWith('.checkpoints/') && preview?.text !== undefined && (
              <button title="Copy this snapshot back over the live file" onClick={async () => {
                const target = sel.split('/').slice(2).join('/');
                if (!target || !window.confirm(`Restore ${target} to this ${sel.split('/')[1]} snapshot? The live file is overwritten.`)) return;
                await api.putAgentFile(a.id, target, btoa(unescape(encodeURIComponent(preview.text!))), 'text/markdown');
                app.showToast(`Restored ${target}`);
              }} style={{ marginLeft: 'auto', background: 'var(--panel)', border: '1px solid var(--amber)', color: 'var(--amber)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Restore this version</button>
            )}
          </div>
          <div style={{ flex: 1, overflow: 'auto', background: 'var(--code)' }}>
            {sel && preview === null && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>}
            {preview?.kind === 'image' && preview.base64 && (
              <div style={{ padding: 16 }}><img src={`data:${preview.contentType};base64,${preview.base64}`} alt={sel ?? ''} style={{ maxWidth: '100%', borderRadius: 8 }} /></div>
            )}
            {preview?.kind === 'html' && preview.text && (
              <iframe title={sel ?? 'preview'} sandbox="allow-scripts" srcDoc={preview.text} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
            )}
            {(preview?.kind === 'markdown' || preview?.kind === 'text') && (
              <pre style={{ margin: 0, padding: '14px 16px', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{preview.text}{preview.truncated ? '\n…(truncated)' : ''}</pre>
            )}
            {preview?.kind === 'binary' && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-faint)' }}>Binary file · {preview.size} bytes</div>}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 10 }}>
        {a.name}'s working folder — its file tools, uploads, and attachments all operate here. <span style={{ fontFamily: 'var(--mono)' }}>LESSONS.md</span> and <span style={{ fontFamily: 'var(--mono)' }}>JOURNAL.md</span> are its memory; <span style={{ fontFamily: 'var(--mono)' }}>.checkpoints/</span> is read-only rollback history.
      </div>
    </div>
  );
}

/** What this agent taught itself: private skills (from draft_skill) and
 *  self-built HTTP tools (from save_tool). Creation is free; activation is
 *  the user's call, always. */
/** Permissions §5: promotion widens blast radius, so the user re-reviews the
 *  full instructions — the real artifact, not a summary — before sharing. */
function PromoteSkillModal({ a, skill, onDone, onClose }: { a: Agent; skill: Skill; onDone: () => void; onClose: () => void }) {
  const app = useApp();
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-soft)', flex: 'none' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Share /{skill.name} with the workspace</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>
            Now private to {a.name} · after sharing, every agent {app.workspaceId ? 'in this workspace' : 'everywhere'} can load it
          </div>
        </div>
        <div style={{ padding: '16px 24px', overflow: 'auto' }}>
          {skill.description && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 10 }}>{skill.description}</div>}
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Full instructions — review what you are sharing</div>
          <pre style={{ margin: 0, padding: '12px 14px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 10, fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>{skill.instructions}</pre>
          {skill.proposedBy && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>Drafted by {a.name} ({skill.proposedBy})</div>}
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, flex: 'none' }}>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={async () => {
            try {
              await api.promoteSkill(skill.id, app.workspaceId || undefined);
              app.showToast(`/${skill.name} is now shared`);
              onDone();
            } catch (err) {
              app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'promotion failed');
            }
            onClose();
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Approve & share</button>
        </div>
      </div>
    </div>
  );
}

function SkillsToolsTab({ a }: { a: Agent }) {
  const app = useApp();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [promoting, setPromoting] = useState<Skill | null>(null);
  const [tools, setTools] = useState<AgentCustomTool[]>([]);
  const refresh = (id: string) => {
    void api.skills(app.workspaceId || undefined, id).then((all) => setSkills(all.filter((s) => s.agentId === id))).catch(() => setSkills([]));
    void api.agentCustomTools(id).then(setTools).catch(() => setTools([]));
  };
  useEffect(() => { refresh(a.id); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [a.id]);

  const pill = (text: string, color: string) => (
    <span style={{ fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 6, padding: '1px 7px' }}>{text}</span>
  );
  const btn = (label: string, onClick: () => void, primary = false, danger = false): React.ReactNode => (
    <button onClick={onClick} style={{
      background: primary ? 'var(--accent)' : 'none', color: primary ? '#fff' : danger ? 'var(--red)' : 'var(--text-dim)',
      border: primary ? 'none' : `1px solid ${danger ? 'var(--red)' : 'var(--border)'}`,
      borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none',
    }}>{label}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
          <span style={label}>Skills · {skills.length}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>installed with {a.name} or captured from work that went well (draft_skill)</span>
        </div>
        <div style={{ ...card, padding: '6px 8px' }}>
          {skills.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)' }}>/{s.name}</span>
                  {s.draft === 1 ? pill('awaiting your approval', 'var(--amber)') : pill('active', 'var(--green)')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.description || s.instructions.slice(0, 90)}</div>
              </div>
              {s.draft === 1 && btn('Approve', async () => { await api.resolveSkillDraft(s.id, true); refresh(a.id); app.showToast(`Skill /${s.name} approved`); }, true)}
              {s.draft === 1 && btn('Reject', async () => { await api.resolveSkillDraft(s.id, false); refresh(a.id); }, false, true)}
              {s.draft !== 1 && btn('Share', () => setPromoting(s))}
              {s.draft !== 1 && btn('Remove', async () => { if (window.confirm(`Remove /${s.name}?`)) { await api.resolveSkillDraft(s.id, false).catch(async () => { await fetch(`/api/skills/${s.id}`, { method: 'DELETE' }); }); refresh(a.id); } }, false, true)}
            </div>
          ))}
          {skills.length === 0 && <div style={{ padding: '10px 10px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>None yet — when work goes well, {a.name} drafts the procedure and you approve it here.</div>}
        </div>
      </div>
      {promoting && <PromoteSkillModal a={a} skill={promoting} onDone={() => refresh(a.id)} onClose={() => setPromoting(null)} />}

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
          <span style={label}>Self-built tools · {tools.length}/12</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>HTTP tools built from your requests (save_tool) — inert until you enable them, SSRF-guarded, approval-gated per call in Ask mode</span>
        </div>
        <div style={{ ...card, padding: '6px 8px' }}>
          {tools.map((t) => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)' }}>tool_{t.slug}</span>
                  {t.enabled ? pill('enabled', 'var(--green)') : pill('review the URL, then enable', 'var(--amber)')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{t.description || t.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', fontFamily: 'var(--mono)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.method} {t.url}</div>
              </div>
              {!t.enabled && btn('Enable', async () => { await api.approveAgentTool(a.id, t.id); refresh(a.id); app.showToast(`tool_${t.slug} enabled`); }, true)}
              {btn(t.enabled ? 'Revoke' : 'Reject', async () => { await api.deleteAgentTool(a.id, t.id); refresh(a.id); }, false, true)}
            </div>
          ))}
          {tools.length === 0 && <div style={{ padding: '10px 10px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>None yet — ask for the same lookup twice and {a.name} will offer to build it as a tool.</div>}
        </div>
      </div>
    </div>
  );
}

/** Assign a workspace folder: the agent sees it as shared/ next to its own
 *  working folder, in every workspace it chats in. */
function SharedFolderCard({ a }: { a: Agent }) {
  const app = useApp();
  const [value, setValue] = useState(a.workspaceFolder ?? '');
  useEffect(() => { setValue(a.workspaceFolder ?? ''); }, [a.id, a.workspaceFolder]);
  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={label}>Assigned workspace folder</span>
        <button onClick={async () => {
          try {
            await api.updateAgent(a.id, { workspaceFolder: value.trim() });
            await app.refreshAgents();
            app.showToast(value.trim() ? `Assigned ${value.trim()} — mounted as shared/` : 'Assignment cleared');
          } catch (err) {
            app.showToast(err instanceof Error ? err.message.slice(0, 120) : 'invalid folder');
          }
        }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 9, lineHeight: 1.5 }}>
        A folder in the shared workspace store this agent may work in, mounted as <span style={{ fontFamily: 'var(--mono)' }}>shared/</span> beside its own folder. Leave empty for no access to workspace files.
      </div>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. projects/website"
        style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '9px 12px', color: 'var(--text)', fontSize: 13, fontFamily: 'var(--mono)', outline: 'none' }} />
    </div>
  );
}

const TABS = ['Dashboard', 'Tasks', 'Schedule', 'Mini apps', 'Skills & tools', 'Chats', 'Files', 'Settings'] as const;
type HomeTab = (typeof TABS)[number];

export function AgentHome() {
  const app = useApp();
  const a = app.agents.find((x) => x.id === app.selectedAgent);
  const [tab, setTab] = useState<HomeTab>('Dashboard');
  const [openApp, setOpenApp] = useState<AgentApp | null>(null);
  const [reviewApp, setReviewApp] = useState<AgentApp | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [chatQuery, setChatQuery] = useState('');
  const [editingCharter, setEditingCharter] = useState(false);
  const [charterDraft, setCharterDraft] = useState('');
  const stats = a ? app.agentStats[a.id] : undefined;
  const agentId = a?.id;

  // ?tab= deep link (screenshot verification); consumed on the first open
  const urlTab = useRef<HomeTab | null>((() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return TABS.includes(q as HomeTab) ? (q as HomeTab) : null;
  })());
  useEffect(() => {
    if (!agentId) return; // agents not loaded yet — keep the deep link intact
    setTab(urlTab.current ?? 'Dashboard');
    urlTab.current = null;
    setEditingCharter(false);
    setChatQuery('');
  }, [agentId]);
  useEffect(() => {
    if (agentId) {
      void api.agentTasks(agentId).then(setTasks).catch(() => setTasks([]));
      void api.agentEvents(agentId).then(setEvents).catch(() => setEvents([]));
    } else {
      setTasks([]);
      setEvents([]);
    }
  }, [agentId]);

  if (!a) return null;
  const reloadTasks = () => void api.agentTasks(a.id).then(setTasks).catch(() => {});
  const apps = parseApps(a);
  const loops = (() => { try { return JSON.parse(a.loops) as Loop[]; } catch { return []; } })();
  const activeLoops = loops.filter((l) => l.enabled !== false);
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const conversations = app.sessions
    .filter((s) => s.agentId === a.id)
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  const filteredChats = chatQuery.trim()
    ? conversations.filter((c) => (c.name || c.autoTitle).toLowerCase().includes(chatQuery.trim().toLowerCase()))
    : conversations;
  const counts: Partial<Record<HomeTab, number>> = {
    Tasks: openTasks.length, Schedule: activeLoops.length, 'Mini apps': apps.length, Chats: conversations.length,
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 26px 60px' }}>
        <button onClick={() => { app.setSelectedAgent(null); app.go('overview'); }} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12.5, cursor: 'pointer', padding: 0, marginBottom: 16 }}>
          <I d={P.chevL} size={14} />All agents
        </button>

        {/* identity header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 15, flexWrap: 'wrap' }}>
          <div style={{ width: 54, height: 54, borderRadius: 15, background: grad(a.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 26 }}>{a.emoji}</div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.3px' }}>{a.name}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 2 }}>
              {a.role || 'Durable agent'}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)', fontSize: 11.5 }}> · {a.model || a.provider} · {stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}% approval` : 'unrated'} · {(((stats?.tokensIn ?? 0) + (stats?.tokensOut ?? 0)) / 1000).toFixed(1)}k tokens</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={api.agentExportUrl(a.id)} download style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
              <I d={P.download} size={14} />Export
            </a>
            <button onClick={() => void app.newChat(a.id)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
              <I d={P.plus} size={14} />New conversation
            </button>
          </div>
        </div>

        {/* tab bar */}
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', overflowX: 'auto', marginTop: 20 }}>
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '7px 13px 9px', fontSize: 12.5,
              fontWeight: tab === t ? 600 : 500, whiteSpace: 'nowrap',
              color: tab === t ? 'var(--text)' : 'var(--text-dim)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>
              {t}
              {counts[t] ? <span style={{ marginLeft: 6, fontSize: 10, color: t === 'Tasks' ? 'var(--amber)' : 'var(--text-faint)' }}>{counts[t]}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'Dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                { v: String(openTasks.length), l: 'open tasks', go: 'Tasks' as HomeTab },
                { v: String(activeLoops.length), l: 'active loops', go: 'Schedule' as HomeTab },
                { v: String(apps.length), l: 'mini apps', go: 'Mini apps' as HomeTab },
                { v: String(conversations.length), l: 'conversations', go: 'Chats' as HomeTab },
              ].map((c) => (
                <button key={c.l} onClick={() => setTab(c.go)} style={{ ...card, padding: '10px 16px', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 17, fontWeight: 700 }}>{c.v}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{c.l}</span>
                </button>
              ))}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
                <span style={label}>Dashboard</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>maintained by {a.name} (update_dashboard)</span>
              </div>
              <div style={{ ...card, padding: a.dashboard.trim() ? '10px 20px 14px' : 22 }}>
                {a.dashboard.trim() ? (
                  <div style={{ fontSize: 13, color: 'var(--text)' }}><Markdown text={a.dashboard} /></div>
                ) : (
                  <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                    No dashboard yet. {a.name} builds and maintains this page itself — start a conversation and ask it
                    to set up its dashboard (it uses the <span style={{ fontFamily: 'var(--mono)' }}>update_dashboard</span> tool and refreshes it as its work evolves).
                  </div>
                )}
              </div>
            </div>
            {events.length > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
                  <span style={label}>Activity</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>proactive work is never silent — every loop run and failure lands here</span>
                </div>
                <div style={{ ...card, padding: '6px 8px' }}>
                  {events.slice(0, 6).map((ev) => (
                    <div key={ev.id} onClick={() => ev.sessionId && app.openSession(ev.sessionId)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: ev.sessionId ? 'pointer' : 'default' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: ev.kind === 'loop_error' ? 'var(--red)' : 'var(--green)', flex: 'none' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.title}</div>
                        {ev.body && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.body}</div>}
                      </div>
                      <span style={{ fontSize: 9.5, color: 'var(--text-faint)', flex: 'none', fontFamily: 'var(--mono)' }}>{ago(ev.createdAt)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {conversations.length > 0 && (
              <div>
                <div style={{ ...label, marginBottom: 8 }}>Recent conversations</div>
                <div style={{ ...card, padding: '6px 8px' }}>
                  {conversations.slice(0, 5).map((c) => <ConversationRow key={c.id} s={c} onOpen={() => app.openSession(c.id)} />)}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'Tasks' && <TasksBoard a={a} tasks={tasks} reload={reloadTasks} />}
        {tab === 'Schedule' && <ScheduleTab a={a} />}
        {tab === 'Skills & tools' && <SkillsToolsTab a={a} />}
        {tab === 'Files' && <AgentFilesTab a={a} />}

        {tab === 'Mini apps' && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
              <span style={label}>Mini apps · {apps.length}/12</span>
              <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>built by the agent (save_app) — sandboxed, no network</span>
            </div>
            {apps.length ? (
              <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(auto-fill, minmax(230px, 1fr))', gap: 12 }}>
                {apps.map((x) => (
                  <div key={x.id} onClick={() => setOpenApp(x)} style={{ ...card, padding: '13px 15px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 3, background: grad(a.colors), flex: 'none' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.name}</span>
                      <button title="Delete this mini app" onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`Delete mini app "${x.name}"? The agent can rebuild it with save_app.`)) return;
                        await api.deleteAgentApp(a.id, x.id);
                        await app.refreshAgents();
                      }} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex', flex: 'none' }}>
                        <I d={P.x} size={11} />
                      </button>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45, minHeight: 16 }}>{x.description || 'no description'}</span>
                    {(x.capabilities ?? []).length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(x.capabilities ?? []).map((c) => (
                          <span key={c} style={{ fontSize: 9, fontFamily: 'var(--mono)', borderRadius: 5, padding: '1px 6px', border: '1px solid var(--border-soft)', color: (x.approved ?? []).includes(c) ? 'var(--green)' : 'var(--text-faint)' }}>{c}</span>
                        ))}
                        {pendingCaps(x).length > 0 && (
                          <button onClick={(e) => { e.stopPropagation(); setReviewApp(x); }}
                            style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--amber)', border: '1px solid var(--amber)', background: 'none', borderRadius: 5, padding: '1px 7px', cursor: 'pointer' }}>
                            review {pendingCaps(x).length}
                          </button>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: 9.5, color: 'var(--text-faint)', flex: 1, fontFamily: 'var(--mono)' }}>updated {ago(x.updatedAt)}</span>
                      <button title="Open beside this agent's latest conversation" onClick={(e) => { e.stopPropagation(); void app.embedApp(a.id, x); }}
                        style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
                        Embed in chat
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ ...card, padding: 18, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
                None yet. Ask {a.name} to build one — a tracker, calculator, or visualization for its domain.
                It writes a self-contained HTML tool with <span style={{ fontFamily: 'var(--mono)' }}>save_app</span>, and the app appears here.
              </div>
            )}
          </div>
        )}

        {tab === 'Chats' && (
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={label}>Conversations · {conversations.length}</span>
              <input value={chatQuery} onChange={(e) => setChatQuery(e.target.value)} placeholder="search titles…"
                style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none', width: 200 }} />
            </div>
            <div style={{ ...card, padding: '6px 8px' }}>
              {filteredChats.map((c) => <ConversationRow key={c.id} s={c} onOpen={() => app.openSession(c.id)} />)}
              {!filteredChats.length && (
                <div style={{ padding: '10px 10px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>
                  {conversations.length ? 'No conversations match.' : 'No conversations yet — start the first one.'}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'Settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={label}>Charter</span>
                {editingCharter ? (
                  <button onClick={async () => { await api.updateAgent(a.id, { charter: charterDraft }); await app.refreshAgents(); setEditingCharter(false); app.showToast('Charter updated'); }}
                    style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
                ) : (
                  <button onClick={() => { setCharterDraft(a.charter); setEditingCharter(true); }} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <I d={P.edit} size={12} />Edit
                  </button>
                )}
              </div>
              {editingCharter ? (
                <textarea value={charterDraft} onChange={(e) => setCharterDraft(e.target.value)} style={{ width: '100%', minHeight: 120, resize: 'vertical', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', color: 'var(--text)', fontSize: 13, lineHeight: 1.6, outline: 'none' }} />
              ) : (
                <div style={{ lineHeight: 1.65, color: 'var(--text-dim)', fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{a.charter || 'No charter yet — click Edit to define who this agent is.'}</div>
              )}
            </div>

            <SharedFolderCard a={a} />

            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ ...label, marginBottom: 12 }}>Ratings</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--green)' }}>{stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}%` : '—'}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>👍 {stats?.up ?? 0} · 👎 {stats?.down ?? 0}</div>
                </div>
                <div style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  Pending feedback since the last turn is surfaced to the model on its next reply, then cleared.
                </div>
              </div>
            </div>

            <div style={{ ...card, padding: '16px 18px', borderColor: 'color-mix(in oklab,var(--red) 40%,var(--border))' }}>
              <div style={{ ...label, marginBottom: 8, color: 'var(--red)' }}>Danger zone</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-dim)', minWidth: 200 }}>Deleting removes the agent, its file brain, tasks, and mini apps. Conversations stay in the workspace.</span>
                <button onClick={async () => {
                  if (!window.confirm(`Delete ${a.name}? Its file brain and mini apps are removed permanently.`)) return;
                  await api.deleteAgent(a.id);
                  await app.refreshAgents();
                  await app.refreshSessions();
                  app.setSelectedAgent(null);
                  app.go('overview');
                  app.showToast(`Deleted ${a.name}`);
                }} style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Delete agent</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {openApp && <AppViewer agentId={a.id} miniApp={openApp} onClose={() => setOpenApp(null)} />}
      {reviewApp && <CapReviewModal agentId={a.id} miniApp={reviewApp} onClose={() => setReviewApp(null)} />}
    </div>
  );
}
