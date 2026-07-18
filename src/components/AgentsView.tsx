/** Agents: the directory grid, the create-agent dialog, and the per-agent
 *  home page — tabbed like YAAM: Dashboard (agent-maintained markdown),
 *  Mini apps (self-built, embeddable), Chats, Memory (file brain), Settings. */
import { useEffect, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, gradPair } from '../store';
import { api, type Agent, type AgentApp } from '../lib/api';
import { Markdown } from '../lib/md';

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

function AgentCard({ a }: { a: Agent }) {
  const app = useApp();
  const stats = app.agentStats[a.id];
  const count = app.sessions.filter((s) => s.agentId === a.id).length;
  return (
    <div onClick={() => app.openAgent(a.id)} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: grad(a.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 22, position: 'relative' }}>
          {a.emoji}
          <span style={{ position: 'absolute', right: -2, bottom: -2, width: 11, height: 11, borderRadius: '50%', background: 'var(--green)', border: '2px solid var(--panel)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.2px' }}>{a.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{a.role || 'Durable agent'}</div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 7, padding: '3px 8px', fontFamily: 'var(--mono)' }}>{a.model || a.provider}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55, minHeight: 32, overflow: 'hidden' }}>{a.charter.split('\n')[0].slice(0, 120)}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, paddingTop: 12, borderTop: '1px solid var(--border-soft)' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{count}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>chats</div>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{parseApps(a).length}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>mini apps</div>
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green)' }}>{stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}%` : '—'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>approval</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); void app.newChat(a.id); }} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '7px 13px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
          <I d={P.chat} size={14} />New chat
        </button>
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
            <div style={{ color: 'var(--text-dim)', fontSize: 13.5, marginTop: 4 }}>Durable identities with their own charter, isolated file brain, and scheduled work.</div>
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
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 22 }}>
          {app.agents.map((a) => <AgentCard key={a.id} a={a} />)}
        </div>
      </div>
      {pending && <ImportReviewModal pending={pending} onClose={() => setPending(null)} />}
    </div>
  );
}

/** Full-screen sandboxed viewer for one mini app — same trust model as chat
 *  artifacts: opaque origin, allow-scripts only, no network (FR-13.1). */
function AppViewer({ miniApp, onClose }: { miniApp: AgentApp; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 90, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4vh 4vw' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: '100%', height: '100%', maxWidth: 1100, background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow)' }}>
        <div style={{ height: 42, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{miniApp.name}</span>
          {miniApp.description && <span style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{miniApp.description}</span>}
          <span style={{ fontSize: 10, color: 'var(--text-faint)', marginLeft: 'auto', flexShrink: 0, fontFamily: 'var(--mono)' }}>sandboxed · no network · updated {ago(miniApp.updatedAt)}</span>
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: 4, display: 'flex', flexShrink: 0 }}>
            <I d={P.x} size={14} />
          </button>
        </div>
        <iframe title={miniApp.name} sandbox="allow-scripts" srcDoc={miniApp.html} style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }} />
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

const TABS = ['Dashboard', 'Mini apps', 'Chats', 'Memory', 'Settings'] as const;
type HomeTab = (typeof TABS)[number];

export function AgentHome() {
  const app = useApp();
  const a = app.agents.find((x) => x.id === app.selectedAgent);
  const [tab, setTab] = useState<HomeTab>('Dashboard');
  const [openApp, setOpenApp] = useState<AgentApp | null>(null);
  const [brain, setBrain] = useState<{ lessons: string; journal: string } | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [editingCharter, setEditingCharter] = useState(false);
  const [charterDraft, setCharterDraft] = useState('');
  const stats = a ? app.agentStats[a.id] : undefined;

  const refreshBrain = (id: string) => {
    void Promise.all([
      api.agentPreview(id, 'LESSONS.md').then((p) => p.text ?? '').catch(() => ''),
      api.agentPreview(id, 'JOURNAL.md').then((p) => p.text ?? '').catch(() => ''),
    ]).then(([lessons, journal]) => setBrain({ lessons, journal }));
  };
  useEffect(() => {
    setBrain(null);
    setTab('Dashboard');
    setEditingCharter(false);
  }, [a?.id]);
  useEffect(() => {
    if (tab === 'Memory' && brain === null && a) refreshBrain(a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, a?.id]);

  if (!a) return null;
  const apps = parseApps(a);
  const loops = (() => { try { return JSON.parse(a.loops) as Array<{ name: string; cron: string }>; } catch { return []; } })();
  const conversations = app.sessions
    .filter((s) => s.agentId === a.id)
    .sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
  const filteredChats = chatQuery.trim()
    ? conversations.filter((c) => (c.name || c.autoTitle).toLowerCase().includes(chatQuery.trim().toLowerCase()))
    : conversations;
  const counts: Partial<Record<HomeTab, number>> = { 'Mini apps': apps.length, Chats: conversations.length };

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 880, margin: '0 auto', padding: '24px 26px 60px' }}>
        <button onClick={() => { app.setSelectedAgent(null); app.setHomeView('agent'); }} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12.5, cursor: 'pointer', padding: 0, marginBottom: 16 }}>
          <I d={P.chevL} size={14} />All agents
        </button>

        {/* identity header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 15, flexWrap: 'wrap' }}>
          <div style={{ width: 54, height: 54, borderRadius: 15, background: grad(a.colors), display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 26 }}>{a.emoji}</div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.3px' }}>{a.name}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 2 }}>
              {a.role || 'Durable agent'}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)', fontSize: 11.5 }}> · {a.model || a.provider} · {stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}% approval` : 'unrated'}</span>
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
              {counts[t] ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-faint)' }}>{counts[t]}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'Dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
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

        {tab === 'Memory' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => app.openFile({ kind: 'agent', id: a.id }, 'LESSONS.md')} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                Open in files<I d={P.external} size={12} />
              </button>
              <button onClick={() => refreshBrain(a.id)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Refresh</button>
            </div>
            {(['lessons', 'journal'] as const).map((k) => (
              <div key={k}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
                  <span style={label}>{k === 'lessons' ? 'Lessons' : 'Journal'}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {k === 'lessons' ? 'corrections and learnings (distill, your 👎 notes)' : 'episodic log distilled after conversations'}
                  </span>
                </div>
                <div style={{ ...card, maxHeight: 380, overflowY: 'auto' }}>
                  <pre style={{ margin: 0, padding: 16, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
                    {brain === null ? 'loading…' : brain[k].trim() || (k === 'lessons' ? 'No lessons yet — they accumulate from feedback and distillation.' : 'No journal entries yet — the agent reflects after conversations.')}
                  </pre>
                </div>
              </div>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              The file brain lives in this agent's isolated fs — <span style={{ fontFamily: 'var(--mono)' }}>LESSONS.md · JOURNAL.md · knowledge/</span> — browsable from its Files folder in the rail.
            </span>
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

            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={label}>Scheduled loops</span>
                <span style={{ fontSize: 11, color: 'var(--green)' }}>{loops.length} configured</span>
              </div>
              {loops.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-faint)', padding: '8px 0' }}>No loops — scheduled prompts land in a "Loop · name" conversation.</div>}
              {loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderTop: '1px solid var(--border-soft)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{l.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>{l.cron}</div>
                  </div>
                </div>
              ))}
            </div>

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
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-dim)', minWidth: 200 }}>Deleting removes the agent, its file brain, and its mini apps. Conversations stay in the workspace.</span>
                <button onClick={async () => {
                  if (!window.confirm(`Delete ${a.name}? Its file brain and mini apps are removed permanently.`)) return;
                  await api.deleteAgent(a.id);
                  await app.refreshAgents();
                  await app.refreshSessions();
                  app.setSelectedAgent(null);
                  app.showToast(`Deleted ${a.name}`);
                }} style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Delete agent</button>
              </div>
            </div>
          </div>
        )}
      </div>
      {openApp && <AppViewer miniApp={openApp} onClose={() => setOpenApp(null)} />}
    </div>
  );
}
