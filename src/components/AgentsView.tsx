/** Agents: the directory grid, the create-agent dialog, and the per-agent
 *  home page — tabbed like YAAM: Dashboard (agent-maintained markdown),
 *  Mini apps (self-built, embeddable), Chats, Memory (file brain), Settings. */
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad, gradPair } from '../store';
import { AppHost, CapReviewModal, pendingCaps } from './AppHost';
import { ImportSkillMdButton, MemoryImportModal, RevisionCard, ScanFlags, SkillStats } from './SkillBits';
import { PublishButton } from './RegistryBits';
import { api, authHeaders, type Agent, type AgentApp, type AgentCustomTool, type AgentEvent, type AgentJsonV2, type AgentLesson, type AgentTask, type AgentUsage, type Connection, type ContextCard, type FileEntry, type FilePreview, type HeartbeatView, type LoopState, type Skill } from '../lib/api';
import { UsageBars, UsageRows } from './UsageChart';
import { fmtUsd } from '../lib/pricing';
import { fmtTokens } from '../lib/util';
import { Markdown } from '../lib/md';
import { sealHtml } from '../lib/sandbox';
import { nextFire, untilLabel } from '../lib/cron';
import { RUNS_WHEN, lastFiredLabel, runsWhenOf, triggerGlyph, triggerLabel, type Loop, type LoopTrigger, type RunsWhen } from '../lib/triggers';

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
  profile: AgentJsonV2;
  name: string;
  loops: Loop[];
}

/** FR-11.7: imported loops enable immediately, so review them first. v2
 *  files (execution-plan item 9) also carry lessons, skills, tasks and maybe
 *  a profile; each section is a tick, lessons are quarantined unless the
 *  user says otherwise, and skills always land as drafts. */
function ImportReviewModal({ pending, onClose }: { pending: PendingImport; onClose: () => void }) {
  const app = useApp();
  const v2 = (pending.profile.formatVersion ?? 1) >= 2;
  const counts = {
    lessons: Array.isArray(pending.profile.lessons) ? pending.profile.lessons.length : 0,
    skills: Array.isArray(pending.profile.skills) ? pending.profile.skills.length : 0,
    tasks: Array.isArray(pending.profile.tasks) ? pending.profile.tasks.length : 0,
    profile: typeof pending.profile.profile === 'string' ? pending.profile.profile.split('\n').filter((l) => l.trim()).length : 0,
  };
  const [withLessons, setWithLessons] = useState(true);
  const [trustLessons, setTrustLessons] = useState(false);
  const [withSkills, setWithSkills] = useState(true);
  const [withTasks, setWithTasks] = useState(true);
  const [withProfile, setWithProfile] = useState(false);
  const row = (on: boolean, set: (v: boolean) => void, n: number, text: React.ReactNode, sub: string) => (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 12.5, cursor: n ? 'pointer' : 'default', opacity: n ? 1 : 0.5, padding: '5px 0' }}>
      <input type="checkbox" disabled={!n} checked={on && n > 0} onChange={(e) => set(e.target.checked)} style={{ marginTop: 2 }} />
      <span style={{ flex: 1 }}>
        <span style={{ fontWeight: 600 }}>{n} {text}</span>
        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>{sub}</span>
      </span>
    </label>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 500, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Review before importing {pending.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>AGENT.json v{v2 ? 2 : 1} · identity, charter{pending.loops.length ? `, ${pending.loops.length} loop(s)` : ''}{v2 ? ', memory, skills, tasks' : ''}</div>
        </div>
        <div style={{ padding: '18px 24px' }}>
          {v2 && (
            <div style={{ marginBottom: 14 }}>
              {row(withLessons, setWithLessons, counts.lessons, 'lessons', 'quarantined on arrival — promote them on the Memory tab')}
              {withLessons && counts.lessons > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--amber)', cursor: 'pointer', padding: '2px 0 6px 24px' }}>
                  <input type="checkbox" checked={trustLessons} onChange={(e) => setTrustLessons(e.target.checked)} />
                  Trust imported lessons (they enter the prompt immediately — only for an export you made yourself)
                </label>
              )}
              {row(withSkills, setWithSkills, counts.skills, 'skills', 'land as drafts — you approve each before it is callable')}
              {row(withTasks, setWithTasks, counts.tasks, 'open tasks', 'added to the board as To do')}
              {counts.profile > 0 && row(withProfile, setWithProfile, counts.profile, 'profile lines', 'proposed into this workspace\'s profile for your approval')}
            </div>
          )}
          {pending.loops.length > 0 ? (
            <div style={{ padding: '13px 15px', border: '1px solid var(--amber)', borderRadius: 11, background: 'color-mix(in oklab,var(--amber) 12%,transparent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>
                <I d={P.warn} size={15} />Scheduled loops enable immediately on import
              </div>
              {pending.loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12, color: 'var(--text-dim)', padding: '3px 0' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--amber)', flex: 'none' }} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>{triggerLabel(l)}</span>
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
              const res = await api.importAgent(pending.profile as Record<string, unknown>, {
                lessons: withLessons, trustLessons: withLessons && trustLessons, skills: withSkills, tasks: withTasks,
                profile: withProfile, workspaceId: app.workspaceId || undefined,
              });
              await app.refreshAgents();
              if (withProfile) await app.refreshWorkspaces();
              app.openAgent(res.agent.id);
              const s = res.summary;
              const bits = [s.lessons.added ? `${s.lessons.added} lesson${s.lessons.added === 1 ? '' : 's'}${s.lessons.trusted ? '' : ' quarantined'}` : '', s.skills.added ? `${s.skills.added} skill draft${s.skills.added === 1 ? '' : 's'}` : '', s.tasks.added ? `${s.tasks.added} task${s.tasks.added === 1 ? '' : 's'}` : '', s.profileProposals ? `${s.profileProposals} profile proposal${s.profileProposals === 1 ? '' : 's'}` : ''].filter(Boolean);
              app.showToast(`Imported ${res.agent.name}${bits.length ? ` · ${bits.join(', ')}` : ''}`);
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
              const agent = await api.createAgent({ name: name.trim(), workspaceId: app.workspaceId, role: role.trim(), charter, emoji, colors });
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
        {cell('Next loop', upcoming ? `${upcoming.l.name} · ${untilLabel(upcoming.at)}` : loops.length > 0 ? `${loops.length} ${loops.every((l) => l.trigger) ? 'event-triggered' : 'scheduled'}` : 'no schedule')}
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
      const profile = JSON.parse(await file.text()) as AgentJsonV2;
      setPending({
        profile,
        name: typeof profile.name === 'string' ? profile.name : 'agent',
        loops: Array.isArray(profile.loops) ? (profile.loops as Loop[]) : [],
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
const COLS: Array<{ id: AgentTask['status']; label: string; color: string }> = [
  { id: 'todo', label: 'To do', color: 'var(--text-faint)' },
  { id: 'doing', label: 'In progress', color: 'var(--amber)' },
  { id: 'blocked', label: 'Blocked', color: 'var(--red)' },
  { id: 'done', label: 'Done', color: 'var(--green)' },
  { id: 'abandoned', label: 'Abandoned', color: 'var(--text-faint)' },
];
/** Moving a card here asks for a reason, recorded on the task. */
const NEEDS_REASON: ReadonlySet<string> = new Set(['blocked', 'abandoned']);

/** The agent's own kanban board: drag between columns (or use the arrows),
 *  quick-add into To do. The agent works the same board via list_tasks /
 *  add_task / update_task, so loops and chats land here too. */
function TasksBoard({ a, tasks, reload }: { a: Agent; tasks: AgentTask[]; reload: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState('');
  const dragId = useRef<string | null>(null);

  const move = async (taskId: string, status: AgentTask['status']) => {
    let reason: string | undefined;
    if (NEEDS_REASON.has(status)) {
      const answer = window.prompt(status === 'blocked' ? 'What is it waiting on?' : 'Why is it no longer worth doing?');
      if (!answer || !answer.trim()) return;
      reason = answer.trim();
    }
    try {
      await api.updateAgentTask(a.id, taskId, { status, reason });
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'could not move the task');
    }
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
      <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, alignItems: 'start' }}>
        {COLS.map((col, ci) => {
          const items = tasks.filter((t) => t.status === col.id).sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
          return (
            <div key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (dragId.current) void move(dragId.current, col.id); dragId.current = null; }}
              style={{ ...card, background: 'var(--panel-2)', padding: '10px 10px 12px', minHeight: 120 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 8px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: col.color, flex: 'none' }} />
                <span style={{ ...label }}>{col.label}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 'auto' }}>{items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((t) => (
                  <div key={t.id} draggable onDragStart={() => { dragId.current = t.id; }}
                    style={{ ...card, padding: '10px 12px', cursor: 'grab' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.45, textDecoration: t.status === 'done' || t.status === 'abandoned' ? 'line-through' : 'none', color: t.status === 'done' || t.status === 'abandoned' ? 'var(--text-dim)' : 'var(--text)' }}>{t.title}</div>
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

/** The gated heartbeat (docs/triggers.md "Heartbeat"): every agent has one;
 *  it beats on its cadence, computes reasons without a model, and runs a
 *  turn only when there are some. Toggle, cadence, last beat, last reason,
 *  next due, "Beat now" — no delete. */
function HeartbeatCard({ a }: { a: Agent }) {
  const app = useApp();
  const [hb, setHb] = useState<HeartbeatView | null>(null);
  const [cron, setCron] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => { void api.heartbeat(a.id).then((v) => { setHb(v); setCron(v.cron); }).catch(() => setHb(null)); }, [a.id]);
  useEffect(() => { reload(); const t = setInterval(reload, 30_000); return () => clearInterval(t); }, [reload]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); await app.refreshAgents(); reload(); if (done) app.showToast(done); } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'heartbeat update failed'); } finally { setBusy(false); }
  };
  const when = (iso: string | null) => (iso ? ago(iso) : 'never');
  const field: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', color: 'var(--text)', fontSize: 12, outline: 'none', fontFamily: 'var(--mono)', width: 120 };
  const btn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: busy ? 'default' : 'pointer', flex: 'none', opacity: busy ? 0.6 : 1 };
  if (!hb) return null;
  return (
    <div style={{ ...card, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: hb.enabled ? 'var(--green)' : 'var(--text-faint)', flex: 'none' }} />
        <span title="Gated heartbeat" style={{ color: 'var(--text-faint)', display: 'flex', flex: 'none' }}><I d={P.clock} size={14} /></span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: hb.enabled ? 'var(--text)' : 'var(--text-dim)' }}>Heartbeat</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>last beat {when(hb.lastBeatAt)} · last run {when(hb.lastRunAt)} · {hb.runsToday}/{hb.dailyRunCap} runs today · next {hb.nextDueAt ? untilLabel(new Date(hb.nextDueAt)) : '—'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={hb.lastReason}>
            {hb.lastReason ? `last: ${hb.lastReason.split('\n')[0].slice(0, 90)}${hb.lastReason.includes('\n') ? ' …' : ''}` : 'wakes only with a reason: a stale task, an unread inbox item, an unanswered mention'}
          </div>
        </div>
        <input value={cron} onChange={(e) => setCron(e.target.value)} onBlur={() => { if (cron.trim() && cron.trim() !== hb.cron) void act(() => api.updateHeartbeat(a.id, { cron: cron.trim() }), 'Cadence saved'); }}
          title="Five-field cron (every 5 minutes at most); the workspace default applies when cleared" placeholder={hb.cron} style={field} />
        <button disabled={busy} onClick={() => void act(() => api.beatNow(a.id).then((r) => app.showToast(r.ran ? `Heartbeat ran: ${r.reasons.length} reason(s)` : r.reasons.length ? `Gate ${r.status}: ${r.reasons.length} reason(s), no run` : `Nothing to do (${r.status})`)))} style={btn}>Beat now</button>
        <button disabled={busy} onClick={() => void act(() => api.updateHeartbeat(a.id, { enabled: !hb.enabled }), hb.enabled ? 'Heartbeat paused' : 'Heartbeat resumed')} style={btn}>{hb.enabled ? 'Pause' : 'Resume'}</button>
      </div>
    </div>
  );
}

/** Schedule editor: the agent's loops — each runs on a cron, on an event
 *  trigger (new mail, calendar change, task assigned, webhook), or both
 *  (docs/triggers.md) — firing a real auto-mode turn in its "Loop · name"
 *  conversation. */
function ScheduleTab({ a }: { a: Agent }) {
  const app = useApp();
  const [name, setName] = useState('');
  const [when, setWhen] = useState<RunsWhen>('schedule');
  const [cron, setCron] = useState('0 9 * * *');
  const [alsoCron, setAlsoCron] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  // mail
  const [mailService, setMailService] = useState<'gmail' | 'msmail'>('gmail');
  const [mailQuery, setMailQuery] = useState('');
  const [pollMinutes, setPollMinutes] = useState('5');
  // calendar
  const [calService, setCalService] = useState<'gcal' | 'mscal'>('gcal');
  const [calOn, setCalOn] = useState<'created' | 'changed' | 'starting'>('created');
  const [withinHours, setWithinHours] = useState('24');
  const [leadMinutes, setLeadMinutes] = useState('15');
  const [states, setStates] = useState<LoopState[]>([]);
  /** The webhook secret, shown once right after it is minted. */
  const [revealed, setRevealed] = useState<{ loopName: string; url: string; secret: string } | null>(null);
  const loops = (() => { try { return JSON.parse(a.loops) as Loop[]; } catch { return []; } })();

  const reloadStates = useCallback(() => { void api.loopStates(a.id).then(setStates).catch(() => setStates([])); }, [a.id]);
  useEffect(() => { reloadStates(); const t = setInterval(reloadStates, 30_000); return () => clearInterval(t); }, [reloadStates]);

  const save = async (next: Loop[]) => {
    try {
      await api.updateAgent(a.id, { loops: JSON.stringify(next) });
      await app.refreshAgents();
      return true;
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'saving loops failed');
      return false;
    }
  };

  const reveal = async (loopName: string) => {
    try {
      const res = await api.rotateWebhookSecret(a.id, loopName);
      setRevealed({ loopName, url: res.url, secret: res.secret });
      await app.refreshAgents();
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'minting the secret failed');
    }
  };

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); app.showToast(`${what} copied`); } catch { app.showToast('Copy failed — select the text and copy it'); }
  };

  const trigger = (): LoopTrigger | undefined => {
    const poll = pollMinutes && parseInt(pollMinutes, 10) >= 2 ? { pollMinutes: parseInt(pollMinutes, 10) } : {};
    switch (when) {
      case 'mail': return { kind: 'mail', service: mailService, query: mailQuery.trim(), ...poll };
      case 'calendar': return {
        kind: 'calendar', service: calService, on: calOn, withinHours: Math.max(1, parseInt(withinHours, 10) || 24),
        ...(calOn === 'starting' ? { leadMinutes: Math.max(1, parseInt(leadMinutes, 10) || 15) } : {}), ...poll,
      };
      case 'task': return { kind: 'task' };
      case 'webhook': return { kind: 'webhook' };
      default: return undefined;
    }
  };
  const cronValue = when === 'schedule' ? cron.trim() : alsoCron.trim();
  const canAdd = !!name.trim() && loops.length < 10 && (when !== 'schedule' || !!cronValue) && !loops.some((l) => l.name === name.trim());

  const field: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 12.5, outline: 'none' };
  const select: React.CSSProperties = { ...field, appearance: 'auto' as never };
  const chip = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--accent)' : 'var(--panel-2)', color: active ? '#fff' : 'var(--text-dim)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
  });
  const hint = RUNS_WHEN.find((r) => r.id === when)?.hint ?? '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 18 }}>
      <HeartbeatCard a={a} />
      <div style={{ ...card, padding: '14px 16px' }}>
        <div style={{ ...label, marginBottom: 10 }}>Add a loop</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Loop name, e.g. Morning sweep" style={{ ...field, width: '100%' }} />

        <div style={{ ...label, margin: '14px 0 8px' }}>Runs when</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {RUNS_WHEN.map((r) => (
            <button key={r.id} onClick={() => setWhen(r.id)} style={chip(when === r.id)}>
              <I d={P[triggerGlyph({ trigger: r.id === 'schedule' ? undefined : { kind: r.id } as LoopTrigger })]} size={12} />{r.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>{hint}</div>

        {when === 'schedule' && (
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" style={{ ...field, fontFamily: 'var(--mono)', marginTop: 8, width: '100%' }} />
        )}
        {when === 'mail' && (
          <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '150px 1fr 120px', gap: 8, marginTop: 8 }}>
            <select value={mailService} onChange={(e) => setMailService(e.target.value as 'gmail' | 'msmail')} style={select}>
              <option value="gmail">Gmail</option>
              <option value="msmail">Outlook</option>
            </select>
            <input value={mailQuery} onChange={(e) => setMailQuery(e.target.value)} placeholder={mailService === 'gmail' ? 'Gmail search, e.g. from:boss@acme.com is:unread' : 'Outlook search, e.g. subject:invoice'} style={{ ...field, fontFamily: 'var(--mono)' }} />
            <input value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value.replace(/[^0-9]/g, ''))} placeholder="every (min)" title="Poll every N minutes (min 2)" style={{ ...field, fontFamily: 'var(--mono)' }} />
          </div>
        )}
        {when === 'calendar' && (
          <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '170px 1fr 1fr 120px', gap: 8, marginTop: 8 }}>
            <select value={calService} onChange={(e) => setCalService(e.target.value as 'gcal' | 'mscal')} style={select}>
              <option value="gcal">Google Calendar</option>
              <option value="mscal">Outlook Calendar</option>
            </select>
            <select value={calOn} onChange={(e) => setCalOn(e.target.value as 'created' | 'changed' | 'starting')} style={select}>
              <option value="created">an event is created</option>
              <option value="changed">an event is created or changed</option>
              <option value="starting">an event is about to start</option>
            </select>
            {calOn === 'starting'
              ? <input value={leadMinutes} onChange={(e) => setLeadMinutes(e.target.value.replace(/[^0-9]/g, ''))} placeholder="lead (min)" title="Fire this many minutes before the start" style={{ ...field, fontFamily: 'var(--mono)' }} />
              : <input value={withinHours} onChange={(e) => setWithinHours(e.target.value.replace(/[^0-9]/g, ''))} placeholder="window (hours)" title="Watch events in the next N hours" style={{ ...field, fontFamily: 'var(--mono)' }} />}
            <input value={pollMinutes} onChange={(e) => setPollMinutes(e.target.value.replace(/[^0-9]/g, ''))} placeholder="every (min)" title="Poll every N minutes (min 2)" style={{ ...field, fontFamily: 'var(--mono)' }} />
          </div>
        )}
        {when === 'task' && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>Fires when you, a promoted chat turn, or another agent's <span style={{ fontFamily: 'var(--mono)' }}>delegate_task</span> adds work to this board — tasks the agent queues for itself do not wake it. A burst of assignments within 30 seconds becomes one run.</div>
        )}
        {when === 'webhook' && (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>After you add the loop, a secret URL is shown once. Any system that can POST JSON (≤64KB, 30/min) to it wakes the agent with that body as its payload.</div>
        )}
        {when !== 'schedule' && (
          <input value={alsoCron} onChange={(e) => setAlsoCron(e.target.value)} placeholder="Also on a schedule (optional cron, e.g. 0 9 * * 1-5)" style={{ ...field, fontFamily: 'var(--mono)', marginTop: 8, width: '100%' }} />
        )}

        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt for each run (optional — defaults to 'follow your charter and do this loop's work'; trigger payloads are appended as data, not instructions)"
          style={{ ...field, width: '100%', minHeight: 56, resize: 'vertical', marginTop: 8, lineHeight: 1.5 }} />
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : '1fr 1fr', gap: 8, marginTop: 8 }}>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model override (optional — a cheap model keeps heartbeats near-free)" style={{ ...field, fontFamily: 'var(--mono)' }} />
          <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))} placeholder="Token budget (optional — hard stop, surfaces in Activity)" style={{ ...field, fontFamily: 'var(--mono)' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>runs land in the "Loop · {name.trim() || 'name'}" conversation in auto mode · budget, model, quiet hours and the spend stop apply to every run</span>
          <button disabled={!canAdd} onClick={async () => {
            const loopName = name.trim();
            const t = trigger();
            const ok = await save([...loops, {
              name: loopName,
              ...(cronValue ? { cron: cronValue } : {}),
              ...(t ? { trigger: t } : {}),
              ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
              ...(model.trim() ? { model: model.trim() } : {}),
              ...(budget && parseInt(budget, 10) > 0 ? { budgetTokens: parseInt(budget, 10) } : {}),
            }]);
            if (!ok) return;
            setName(''); setPrompt(''); setModel(''); setBudget(''); setAlsoCron(''); setMailQuery('');
            if (t?.kind === 'webhook') await reveal(loopName);
            else app.showToast(t ? 'Loop added — it fires on the next matching event' : 'Loop added — it fires on the next matching minute');
            reloadStates();
          }} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 15px', fontSize: 12.5, fontWeight: 600, cursor: canAdd ? 'pointer' : 'default', opacity: canAdd ? 1 : 0.5, flex: 'none' }}>Add loop</button>
        </div>
      </div>

      {revealed && (
        <div style={{ ...card, padding: '14px 16px', borderColor: 'var(--amber)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <I d={P.bolt} size={14} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Webhook for "{revealed.loopName}" — shown once</span>
            <button onClick={() => setRevealed(null)} title="Dismiss" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 3, display: 'flex' }}><I d={P.x} size={12} /></button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>Only a hash of the secret is stored. Copy the URL now; "New secret" on the loop below replaces it if you lose it.</div>
          {[{ k: 'URL', v: revealed.url }, { k: 'Secret', v: revealed.secret }].map(({ k, v }) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ ...label, width: 48, flex: 'none' }}>{k}</span>
              <code style={{ flex: 1, minWidth: 0, fontFamily: 'var(--mono)', fontSize: 11.5, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 9px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</code>
              <button onClick={() => void copy(v, k)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Copy</button>
            </div>
          ))}
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8, fontFamily: 'var(--mono)' }}>curl -X POST '{revealed.url}' -H 'content-type: application/json' -d '{'{'}"event":"deploy","ok":true{'}'}'</div>
        </div>
      )}

      <div style={{ ...card, padding: '6px 8px' }}>
        {loops.length === 0 && <div style={{ padding: '12px 10px', fontSize: 12.5, color: 'var(--text-dim)' }}>No loops yet — schedule recurring work above, wire an event trigger, or import an agent profile that ships some.</div>}
        {loops.map((l, i) => {
          const st = states.find((s) => s.name === l.name);
          const kind = runsWhenOf(l);
          return (
          <div key={`${l.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 10px', borderTop: i > 0 ? '1px solid var(--border-soft)' : 'none' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.enabled === false ? 'var(--text-faint)' : st?.lastErrorAt && (!st.lastFiredAt || st.lastErrorAt > st.lastFiredAt) ? 'var(--amber)' : 'var(--green)', flex: 'none' }} />
            <span title={RUNS_WHEN.find((r) => r.id === kind)?.label} style={{ color: 'var(--text-faint)', display: 'flex', flex: 'none' }}><I d={P[triggerGlyph(l)]} size={14} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, textDecoration: l.enabled === false ? 'line-through' : 'none', color: l.enabled === false ? 'var(--text-dim)' : 'var(--text)' }}>{l.name}</span>
                {l.trigger && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{lastFiredLabel(st?.lastFiredAt)}{st?.lastErrorAt && (!st.lastFiredAt || st.lastErrorAt > st.lastFiredAt) ? ' · poll failing (see Activity)' : ''}</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {triggerLabel(l)}{l.model ? ` · ${l.model}` : ''}{l.budgetTokens ? ` · ≤${(l.budgetTokens / 1000).toFixed(0)}k tok` : ''}{l.prompt ? ` · ${l.prompt.replace(/\s+/g, ' ').slice(0, 50)}` : ''}
              </div>
            </div>
            {l.trigger?.kind === 'webhook' && (
              <button onClick={() => { if (window.confirm(`Mint a new secret for "${l.name}"? The current URL stops working.`)) void reveal(l.name); }}
                style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
                New secret
              </button>
            )}
            <button onClick={() => void save(loops.map((x, xi) => (xi === i ? { ...x, enabled: x.enabled === false ? undefined : false } as Loop : x)))}
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 11px', fontSize: 11, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
              {l.enabled === false ? 'Resume' : 'Pause'}
            </button>
            <button onClick={() => { if (window.confirm(`Remove the loop "${l.name}"?`)) void save(loops.filter((_, xi) => xi !== i)); }}
              title="Remove loop" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 3, display: 'flex', flex: 'none' }}>
              <I d={P.x} size={12} />
            </button>
          </div>
          );
        })}
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
              <iframe title={sel ?? 'preview'} sandbox="allow-scripts" srcDoc={sealHtml(preview.text)} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
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

/** Per-provider display strings shared by the grant modal and connections row. */
const CONN_DISPLAY: Record<string, { emoji: string; label: string; mail: string; mailPill: string; drive: string; drivePill: string }> = {
  google: { emoji: '📅', label: 'Google', mail: 'Gmail', mailPill: 'gmail draft/send', drive: 'Drive', drivePill: 'drive' },
  microsoft: { emoji: '💼', label: 'Microsoft', mail: 'Mail', mailPill: 'mail draft/send', drive: 'OneDrive', drivePill: 'onedrive' },
};
const connDisplay = (provider: string) => CONN_DISPLAY[provider] ?? CONN_DISPLAY.google;

/** Activation review for a connection grant (docs/integrations.md §5): show
 *  the literal tools the agent gains — the real artifact, not a summary. */
function GrantConnectionModal({ a, conn, onDone, onClose }: { a: Agent; conn: Connection; onDone: () => void; onClose: () => void }) {
  const app = useApp();
  const d = connDisplay(conn.provider);
  const [allTools, setAllTools] = useState<Array<{ name: string; description: string; provider: string; service: string; level: string }>>([]);
  const [withWrite, setWithWrite] = useState(false);
  const [withGmail, setWithGmail] = useState(false);
  const [withDrive, setWithDrive] = useState(false);
  const [withDriveExport, setWithDriveExport] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.connectionTools().then(setAllTools).catch(() => setAllTools([])); }, []);
  const tools = allTools.filter((t) => t.provider === conn.provider);
  const writeTools = tools.filter((t) => t.service === 'calendar' && t.level === 'write');
  const gmailTools = tools.filter((t) => t.service === 'gmail');
  const driveReadTools = tools.filter((t) => t.service === 'drive' && t.level === 'read');
  const driveWriteTools = tools.filter((t) => t.service === 'drive' && t.level === 'write');
  const writeOffered = conn.writeCapable && writeTools.length > 0;
  const gmailOffered = conn.gmailCapable && gmailTools.length > 0;
  const driveOffered = conn.driveCapable && driveReadTools.length > 0;
  const toolRow = (t: { name: string; description: string }) => (
    <div key={t.name} style={{ padding: '8px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: 'var(--mono)' }}>{t.name}</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2 }}>{t.description}</div>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', backdropFilter: 'blur(2px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '100%', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--elev)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow)', animation: 'pop .16s' }}>
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--border-soft)', flex: 'none' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Give {a.name} access to your {d.label} account?</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>
            {d.label} · {conn.accountEmail} · calendar {withWrite ? 'read + write' : 'read-only'}{withGmail ? ` · ${d.mail.toLowerCase()} draft/send` : ''}{withDrive ? ` · ${d.drive.toLowerCase()} ${withDriveExport ? 'read + export' : 'read'}` : ''}
          </div>
        </div>
        <div style={{ padding: '16px 24px', overflow: 'auto' }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Exactly these tools, nothing else</div>
          {tools.filter((t) => t.service === 'calendar' && t.level === 'read').map(toolRow)}
          {writeOffered && (
            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={withWrite} onChange={(e) => setWithWrite(e.target.checked)} />
                Also allow calendar write tools — each call still needs your approval in Ask mode
              </label>
              <div style={{ opacity: withWrite ? 1 : 0.45 }}>{writeTools.map(toolRow)}</div>
            </div>
          )}
          {gmailOffered && (
            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={withGmail} onChange={(e) => setWithGmail(e.target.checked)} />
                Also allow {d.mail} draft + send — sending confirms with you every time, even in Auto mode
              </label>
              <div style={{ opacity: withGmail ? 1 : 0.45 }}>{gmailTools.map(toolRow)}</div>
            </div>
          )}
          {driveOffered && (
            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={withDrive} onChange={(e) => { setWithDrive(e.target.checked); if (!e.target.checked) setWithDriveExport(false); }} />
                Also allow {d.drive} read — search and read your files
              </label>
              <div style={{ opacity: withDrive ? 1 : 0.45 }}>{driveReadTools.map(toolRow)}</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, cursor: withDrive ? 'pointer' : 'default', opacity: withDrive ? 1 : 0.45, marginTop: 8 }}>
                <input type="checkbox" disabled={!withDrive} checked={withDriveExport} onChange={(e) => setWithDriveExport(e.target.checked)} />
                Also allow exports — creates new {conn.provider === 'microsoft' ? 'Word/Excel files' : 'Docs/Sheets'} only, never edits existing files
              </label>
              <div style={{ opacity: withDriveExport ? 1 : 0.45 }}>{driveWriteTools.map(toolRow)}</div>
            </div>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.6 }}>
            {a.name} never sees your {d.label} token — the server runs these tools and returns results only.
            Revoking the grant is one click and immediate.
          </div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 10, flex: 'none' }}>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button disabled={busy} onClick={async () => {
            if (busy) return;
            setBusy(true);
            try {
              await api.grantConnection(conn.id, a.id, 'calendar', withWrite ? 'write' : 'read');
              if (withGmail) await api.grantConnection(conn.id, a.id, 'gmail', 'write');
              if (withDrive) await api.grantConnection(conn.id, a.id, 'drive', withDriveExport ? 'write' : 'read');
              app.showToast(`${a.name} can now ${withWrite ? 'read and write' : 'read'} the calendar${withGmail ? ', draft/send email' : ''}${withDrive ? `, use ${d.drive}` : ''}`);
              onDone();
            } catch (err) {
              app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'grant failed');
            }
            onClose();
          }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 18px', fontSize: 13, fontWeight: 700, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Granting…' : 'Approve & grant'}</button>
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
  const [conns, setConns] = useState<Connection[]>([]);
  const [cards, setCards] = useState<ContextCard[]>([]);
  const [granting, setGranting] = useState<Connection | null>(null);
  const refresh = (id: string) => {
    void api.skills(app.workspaceId || undefined, id).then((all) => setSkills(all.filter((s) => s.agentId === id))).catch(() => setSkills([]));
    void api.agentCustomTools(id).then(setTools).catch(() => setTools([]));
    void api.connections().then(setConns).catch(() => setConns([]));
    void api.connectionCards().then(setCards).catch(() => setCards([]));
  };
  const installedNames = (() => { try { return new Set((JSON.parse(a.loops) as Loop[]).map((l) => l.name)); } catch { return new Set<string>(); } })();
  const install = async (cardId: string, useId: string) => {
    try {
      const res = await api.installSuggestedLoop(a.id, cardId, useId);
      await app.refreshAgents();
      app.showToast(`Loop "${res.loop.name}" installed — edit it on the Schedule tab`);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'install failed');
    }
  };
  /** The context card for a granted service: summary + suggested uses with
   *  one-click installs (docs/integrations.md "Context cards"). */
  const cardBlock = (c: Connection, service: string, level: string) => {
    const cardDef = cards.find((k) => k.provider === c.provider && k.service === service);
    if (!cardDef) return null;
    return (
      <div key={`${c.id}-${service}`} style={{ margin: '4px 0 8px 36px', padding: '8px 10px', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 9 }}>
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}><span style={{ fontWeight: 600, color: 'var(--text)' }}>{cardDef.title}</span> · {cardDef.summary}</div>
        {cardDef.suggestedUses.map((u) => {
          const installed = installedNames.has(u.loop.name);
          const allowed = u.grantLevel === 'read' || level === 'write';
          return (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{u.title} {pill(u.grantLevel, allowed ? 'var(--text-faint)' : 'var(--amber)')}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{u.why}</div>
              </div>
              {installed ? pill('installed', 'var(--green)') : btn('Install', () => { if (allowed) void install(cardDef.id, u.id); else app.showToast(`needs a write grant on ${cardDef.title}`); })}
            </div>
          );
        })}
      </div>
    );
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={label}>Skills · {skills.length}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 1 }}>installed with {a.name}, captured from work that went well (draft_skill), or imported as SKILL.md</span>
          <ImportSkillMdButton compact scope={{ workspaceId: app.workspaceId || undefined, agentId: a.id }} onDone={() => refresh(a.id)} />
        </div>
        <div style={{ ...card, padding: '6px 8px' }}>
          {skills.map((s) => (
            <div key={s.id} style={{ padding: '9px 10px', borderBottom: '1px solid var(--border-soft)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--mono)' }}>/{s.name}</span>
                    {s.draft === 1 ? pill(s.scanReport ? 'imported · review the scan, then approve' : 'awaiting your approval', 'var(--amber)') : pill('active', 'var(--green)')}
                    {s.pendingRevision && pill('revision pending', 'var(--amber)')}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.description || s.instructions.slice(0, 90)}</div>
                  <div style={{ marginTop: 4 }}><SkillStats s={s} /></div>
                </div>
                {s.draft === 1 && btn('Approve', async () => { await api.resolveSkillDraft(s.id, true); refresh(a.id); app.showToast(`Skill /${s.name} approved`); }, true)}
                {s.draft === 1 && btn('Reject', async () => { await api.resolveSkillDraft(s.id, false); refresh(a.id); }, false, true)}
                {s.draft !== 1 && <a href={api.skillMdUrl(s.id)} download title="Export as agentskills.io SKILL.md" style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 12px', textDecoration: 'none', flex: 'none' }}>SKILL.md</a>}
                {s.draft !== 1 && btn('Share', () => setPromoting(s))}
                {s.draft !== 1 && <PublishButton compact target={{ kind: 'skill', skillId: s.id }} defaultName={s.name} defaultDescription={s.description} />}
                {s.draft !== 1 && btn('Remove', async () => { if (window.confirm(`Remove /${s.name}?`)) { await api.resolveSkillDraft(s.id, false).catch(async () => { await fetch(`/api/skills/${s.id}`, { method: 'DELETE', headers: authHeaders() }); }); refresh(a.id); } }, false, true)}
              </div>
              {s.draft === 1 && <ScanFlags s={s} />}
              {s.draft === 1 && s.scanReport && (
                <pre style={{ margin: '8px 0 0', padding: '9px 11px', background: 'var(--code)', borderRadius: 8, fontSize: 11, fontFamily: 'var(--mono)', lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>{s.instructions}</pre>
              )}
              <RevisionCard s={s} onDone={() => refresh(a.id)} />
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

      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
          <span style={label}>Connections</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>your connected services — access is granted per agent, and {a.name} has none until you say so</span>
        </div>
        <div style={{ ...card, padding: '6px 8px' }}>
          {conns.map((c) => {
            const mine = c.grants.filter((g) => g.agentId === a.id);
            const cal = mine.find((g) => g.service === 'calendar');
            const gmail = mine.find((g) => g.service === 'gmail');
            const drive = mine.find((g) => g.service === 'drive');
            const granted = mine.length > 0;
            const d = connDisplay(c.provider);
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderBottom: '1px solid var(--border-soft)' }}>
                <span style={{ fontSize: 16, flex: 'none' }}>{d.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{d.label}</span>
                    {cal && pill(cal.level === 'write' ? 'calendar read + write' : 'calendar read', 'var(--green)')}
                    {gmail && pill(d.mailPill, 'var(--green)')}
                    {drive && pill(drive.level === 'write' ? `${d.drivePill} read + export` : `${d.drivePill} read`, 'var(--green)')}
                    {!granted && pill('no access', 'var(--text-faint)')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2, fontFamily: 'var(--mono)' }}>{c.accountEmail}</div>
                </div>
                {!granted && btn('Grant…', () => setGranting(c), true)}
                {granted && btn('Revoke', async () => { await api.revokeConnectionGrant(c.id, a.id); refresh(a.id); app.showToast(`${a.name} lost ${d.label} access`); }, false, true)}
              </div>
            );
          })}
          {conns.flatMap((c) => c.grants.filter((g) => g.agentId === a.id).map((g) => cardBlock(c, g.service, g.level)))}
          {conns.length === 0 && <div style={{ padding: '10px 10px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>No services connected yet — link a Google or Microsoft account under Settings → Connections, then grant it here.</div>}
        </div>
      </div>
      {granting && <GrantConnectionModal a={a} conn={granting} onDone={() => refresh(a.id)} onClose={() => setGranting(null)} />}
    </div>
  );
}

const fieldInput: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text)', fontSize: 13, outline: 'none', minWidth: 0 };

/** Identity: name, emoji, role and the avatar gradient. */
function IdentityCard({ a }: { a: Agent }) {
  const app = useApp();
  const colorsOf = (raw: string): [string, string] => { try { const c = JSON.parse(raw) as string[]; if (Array.isArray(c) && c.length === 2) return [c[0], c[1]]; } catch { /* fall through */ } return ['#8b8cf0', '#5cc2f2']; };
  const [name, setName] = useState(a.name);
  const [emoji, setEmoji] = useState(a.emoji);
  const [role, setRole] = useState(a.role);
  const [colors, setColors] = useState<[string, string]>(colorsOf(a.colors));
  useEffect(() => { setName(a.name); setEmoji(a.emoji); setRole(a.role); setColors(colorsOf(a.colors)); }, [a.id, a.name, a.emoji, a.role, a.colors]);
  const dirty = name !== a.name || emoji !== a.emoji || role !== a.role || JSON.stringify(colors) !== JSON.stringify(colorsOf(a.colors));
  const save = async () => {
    try {
      await api.updateAgent(a.id, { name: name.trim(), emoji: emoji.trim() || '🤖', role: role.trim(), colors: JSON.stringify(colors) });
      await app.refreshAgents();
      app.showToast('Identity saved');
    } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'could not save'); }
  };
  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={label}>Identity</span>
        <button disabled={!dirty || !name.trim()} onClick={() => { void save(); }} style={{ background: dirty ? 'var(--accent)' : 'var(--panel-2)', color: dirty ? '#fff' : 'var(--text-faint)', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: dirty ? 'pointer' : 'default' }}>Save</button>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div aria-hidden style={{ width: 48, height: 48, borderRadius: 12, background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flex: 'none' }}>{emoji || '🤖'}</div>
        <div style={{ flex: 1, minWidth: 220, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>Name<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} style={fieldInput} /></label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>Role<input value={role} maxLength={80} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Customer support" style={fieldInput} /></label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>Emoji<input value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} style={{ ...fieldInput, width: 70 }} /></label>
          <div style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>
            Colours
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="color" aria-label="Gradient start colour" value={colors[0]} onChange={(e) => setColors([e.target.value, colors[1]])} style={{ width: 40, height: 32, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }} />
              <input type="color" aria-label="Gradient end colour" value={colors[1]} onChange={(e) => setColors([colors[0], e.target.value])} style={{ width: 40, height: 32, border: 'none', background: 'none', padding: 0, cursor: 'pointer' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Model: the agent type (provider, key, base URL) and the model within it.
 *  Every session kind — private chats, channels, loops, heartbeats, org runs —
 *  runs on it, unless a chat picked a model by hand in its header. */
function ModelCard({ a }: { a: Agent }) {
  const app = useApp();
  const types = app.agentTypes;
  const enabled = types.filter((t) => t.enabled);
  const current = types.find((t) => t.id === a.agentTypeId) ?? null;
  const [typeId, setTypeId] = useState<string>(a.agentTypeId ?? '');
  const [model, setModel] = useState(a.model);
  const [applyToChats, setApplyToChats] = useState(true);
  useEffect(() => { setTypeId(a.agentTypeId ?? ''); setModel(a.model); }, [a.id, a.agentTypeId, a.model]);
  const picked = types.find((t) => t.id === typeId) ?? null;
  const suggestions = (() => { try { const m = JSON.parse(picked?.models || '[]') as unknown; return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } })();
  const dirty = typeId !== (a.agentTypeId ?? '') || model !== a.model;
  const save = async () => {
    try {
      await api.updateAgent(a.id, { agentTypeId: typeId || null, model: model.trim(), applyToChats });
      await app.refreshAgents();
      await app.refreshSessions();
      app.showToast(`${a.name} now runs on ${model.trim() || picked?.model || 'the type default'}${applyToChats ? ', including its existing chats' : ' in new chats'}`);
    } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'could not save'); }
  };
  return (
    <div style={{ ...card, padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={label}>Model</span>
        <button disabled={!dirty} onClick={() => { void save(); }} style={{ background: dirty ? 'var(--accent)' : 'var(--panel-2)', color: dirty ? '#fff' : 'var(--text-faint)', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: dirty ? 'pointer' : 'default' }}>Save</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 11, lineHeight: 1.5 }}>
        What {a.name} runs on everywhere: its chats, channel replies, loops, heartbeat and organization work. A model picked by hand in one chat&apos;s header still wins for that chat.
        {!current && ` Today: ${a.model || 'the default model'} via the ${a.provider} provider.`}
      </div>
      {enabled.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--amber)' }}>No enabled agent types. Add one with an API key in Settings → Models first.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>
            Agent type
            <select value={typeId} onChange={(e) => { const t = types.find((x) => x.id === e.target.value); setTypeId(e.target.value); if (t) setModel(t.model); }} style={{ ...fieldInput, cursor: 'pointer' }}>
              <option value="">Automatic (by provider: {a.provider})</option>
              {enabled.map((t) => <option key={t.id} value={t.id}>{t.name} · {t.provider}{t.hasApiKey ? '' : ' (no key)'}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 11.5, color: 'var(--text-faint)' }}>
            Model
            <input value={model} onChange={(e) => setModel(e.target.value)} list={`models-${a.id}`} placeholder={picked?.model || 'type default'} style={{ ...fieldInput, fontFamily: 'var(--mono)' }} />
            <datalist id={`models-${a.id}`}>{[...new Set([picked?.model, ...suggestions].filter(Boolean) as string[])].map((m) => <option key={m} value={m} />)}</datalist>
          </label>
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text-dim)', marginTop: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={applyToChats} onChange={(e) => setApplyToChats(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
        Also switch {a.name}&apos;s existing chats
      </label>
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

/** What the agent has learned (docs/agent-memory.md). Injected memory has to
 *  be inspectable and revocable: a lesson silently shapes every future turn,
 *  so a memory nobody can see is one nobody can correct. */
function MemoryTab({ a }: { a: Agent }) {
  const app = useApp();
  const [rows, setRows] = useState<AgentLesson[]>([]);
  const [busy, setBusy] = useState(false);
  const isOwner = !app.me || app.me.role === 'owner';
  /** 'shared' | 'private:<member>' → a badge label (docs/shared-agents.md §4). */
  const audienceOf = (r: AgentLesson): { label: string; privateTo: string | null } => {
    const aud = r.audience ?? 'shared';
    if (!aud.startsWith('private:')) return { label: 'shared', privateTo: null };
    const member = aud.slice('private:'.length);
    return { label: `private · ${app.nameOf(member)}`, privateTo: member };
  };
  const reload = useCallback(() => { void api.agentLessons(a.id).then(setRows).catch(() => setRows([])); }, [a.id]);
  useEffect(reload, [reload]);

  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); reload(); } finally { setBusy(false); } };
  const active = rows.filter((r) => r.trusted === 1);
  const pending = rows.filter((r) => r.trusted === 0);

  const Row = ({ r }: { r: AgentLesson }) => (
    <div style={{ ...card, padding: '11px 14px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{r.text}</div>
        <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4, fontFamily: 'var(--mono)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>{r.sourceKind}{r.useCount > 1 ? ` · learned ${r.useCount}×` : ''}{r.pinned ? ' · pinned' : ''} · {r.updatedAt.slice(0, 10)}</span>
          {app.me?.hasMembers && (
            <span title={audienceOf(r).privateTo ? 'Injected only into turns this member starts' : 'Injected for every member'}
              style={{ fontSize: 9.5, fontWeight: 600, borderRadius: 4, padding: '0 5px', color: audienceOf(r).privateTo ? 'var(--amber)' : 'var(--accent)', border: `1px solid ${audienceOf(r).privateTo ? 'var(--amber)' : 'var(--accent)'}` }}>
              {audienceOf(r).label}
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {app.me?.hasMembers && isOwner && audienceOf(r).privateTo && (
          <button disabled={busy} title="Make this lesson visible to every member (the owner's call — no agent tool can do this)" onClick={() => void act(() => api.patchLesson(a.id, r.id, { audience: 'shared' }))}
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer' }}>Share</button>
        )}
        {r.trusted === 0 && (
          <button disabled={busy} onClick={() => void act(() => api.patchLesson(a.id, r.id, { trusted: true }))}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer' }}>Promote</button>
        )}
        {r.trusted === 1 && (
          <button disabled={busy} onClick={() => void act(() => api.patchLesson(a.id, r.id, { pinned: !r.pinned }))}
            style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer' }}>
            {r.pinned ? 'Unpin' : 'Pin'}
          </button>
        )}
        <button disabled={busy} onClick={() => void act(() => api.deleteLesson(a.id, r.id))}
          style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '5px 11px', fontSize: 11.5, cursor: 'pointer' }}>Forget</button>
      </div>
    </div>
  );

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
          <span style={label}>In every turn · {active.length}</span>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
            distilled from completed work — the top entries go into {a.name}&rsquo;s prompt, within a size budget
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {active.map((r) => <Row key={r.id} r={r} />)}
          {active.length === 0 && (
            <div style={{ ...card, padding: 14, fontSize: 12.5, color: 'var(--text-dim)' }}>
              Nothing learned yet. Lessons appear here after conversations go idle and distill.
            </div>
          )}
        </div>
      </div>

      {pending.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 10 }}>
            <span style={label}>Awaiting review · {pending.length}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
              learned from a mini app or a chat channel — never used until you promote it
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pending.map((r) => <Row key={r.id} r={r} />)}
          </div>
        </div>
      )}
    </div>
  );
}

const TABS = ['Dashboard', 'Tasks', 'Schedule', 'Memory', 'Mini apps', 'Skills & tools', 'Trust', 'Chats', 'Files', 'Settings'] as const;
/** The agent's trust levels, its action log and held actions (item 28, SPA item 32). */
const AgentTrustTab = lazy(() => import('./OrgTrustView').then((m) => ({ default: m.AgentTrustTab })));
type HomeTab = (typeof TABS)[number];

export function AgentHome() {
  const app = useApp();
  const a = app.agents.find((x) => x.id === app.selectedAgent);
  // Workspaces whose organization this agent leads (the current one is read
  // from the live org status so shared workspaces count too).
  const chiefOf = Array.from(new Set([
    ...app.workspaces.filter((w) => w.orgMode !== 'off' && w.chiefOfStaffAgentId === a?.id).map((w) => w.name),
    ...(app.wsOrg && app.wsOrg.mode !== 'off' && app.wsOrg.chiefOfStaffAgentId === a?.id ? [app.workspaces.find((w) => w.id === app.wsOrg!.workspaceId)?.name ?? 'this workspace'] : []),
  ]));
  const [tab, setTab] = useState<HomeTab>('Dashboard');
  const [openApp, setOpenApp] = useState<AgentApp | null>(null);
  const [reviewApp, setReviewApp] = useState<AgentApp | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [editingCharter, setEditingCharter] = useState(false);
  const [charterDraft, setCharterDraft] = useState('');
  const [importing, setImporting] = useState(false);
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
  // In-app deep link (e.g. the chat's "needs a grant" hint): one-shot tab
  // request from the store, works even when this agent page is already open.
  useEffect(() => {
    if (app.agentTabRequest && TABS.includes(app.agentTabRequest as HomeTab)) {
      setTab(app.agentTabRequest as HomeTab);
      app.setAgentTabRequest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.agentTabRequest]);
  useEffect(() => {
    if (agentId) {
      void api.agentTasks(agentId).then(setTasks).catch(() => setTasks([]));
      void api.agentEvents(agentId).then(setEvents).catch(() => setEvents([]));
      void api.agentUsage(agentId, 30).then(setUsage).catch(() => setUsage(null));
    } else {
      setTasks([]);
      setEvents([]);
      setUsage(null);
    }
  }, [agentId]);

  if (!a) return null;
  const reloadTasks = () => void api.agentTasks(a.id).then(setTasks).catch(() => {});
  const reloadEvents = () => void api.agentEvents(a.id).then(setEvents).catch(() => {});
  const actOnEvent = async (ev: AgentEvent, decision: 'approve' | 'dismiss') => {
    try {
      const res = await api.actOnAgentEvent(a.id, ev.id, decision);
      app.showToast(decision === 'dismiss' ? 'Dismissed' : res.ok ? 'Approved — action ran' : `Action failed: ${res.error ?? 'unknown error'}`);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'action failed');
    }
    reloadEvents();
  };
  /** A routed approval (docs/shared-agents.md §3): another member's turn
   *  wants to use *your* connection; only you see this and only you decide. */
  const decideEvent = async (ev: AgentEvent, decision: 'allow' | 'deny') => {
    try {
      const res = await api.decideAgentEvent(a.id, ev.id, decision);
      app.showToast(!res.resolved ? 'That request had already expired' : decision === 'allow' ? 'Allowed — the turn continues' : 'Denied');
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'decision failed');
    }
    reloadEvents();
  };
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
              {chiefOf.length > 0 && <span title="This agent leads the organization of the named workspace (docs/group-chat.md §5)" style={{ color: 'var(--accent-hi)', fontWeight: 600 }}>Chief of staff of {chiefOf.join(', ')} · </span>}
              {a.role || 'Durable agent'}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)', fontSize: 11.5 }}> · {a.model || a.provider} · {stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}% approval` : 'unrated'} · {(((stats?.tokensIn ?? 0) + (stats?.tokensOut ?? 0)) / 1000).toFixed(1)}k tokens{usage && usage.totals.turns > 0 ? ` · ${fmtUsd(usage.totals.usd)} / 30d` : ''}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setImporting(true)} title="Bring memory from Claude, Muse, Hermes or OpenClaw into this agent as proposals" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
              <I d={P.download} size={14} style={{ transform: 'rotate(180deg)' }} />Import
            </button>
            <a href={api.agentExportUrl(a.id)} download title="AGENT.json v2: identity, loops, apps, lessons, skills, open tasks (no profile)" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
              <I d={P.download} size={14} />Export
            </a>
            <PublishButton target={{ kind: 'agent', agentId: a.id }} defaultName={a.name} defaultDescription={a.role} />
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
            <HeartbeatCard a={a} />
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
            {usage && usage.totals.turns > 0 && (
              <div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
                  <span style={label}>Usage · 30 days</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
                    {fmtTokens(usage.totals.tokensIn + usage.totals.tokensOut)} tokens · {fmtUsd(usage.totals.usd)} at list prices
                    {usage.unpricedModels.length > 0 ? ` · unpriced: ${usage.unpricedModels.join(', ')}` : ''}
                  </span>
                </div>
                <div style={{ ...card, padding: '12px 14px' }}>
                  <UsageBars series={usage.series} height={64} />
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--border-soft)', paddingTop: 8 }}>
                    <UsageRows rows={usage.byKind} onOpen={(id) => app.openSession(id)} />
                  </div>
                </div>
              </div>
            )}
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
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: ev.kind === 'loop_error' || ev.kind === 'action_failed' || ev.kind === 'budget_stop' || ev.kind === 'approval_denied' ? 'var(--red)' : ev.kind === 'action_pending' || ev.kind === 'approval_request' ? 'var(--amber)' : 'var(--green)', flex: 'none' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.title}</div>
                        {ev.body && <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.body}</div>}
                      </div>
                      {ev.kind === 'action_pending' && (
                        <span style={{ display: 'flex', gap: 6, flex: 'none' }} onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => void actOnEvent(ev, 'approve')} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                          <button onClick={() => void actOnEvent(ev, 'dismiss')} style={{ background: 'none', color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Dismiss</button>
                        </span>
                      )}
                      {ev.kind === 'approval_request' && (
                        <span style={{ display: 'flex', gap: 6, flex: 'none', alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                          <span title="Routed to you: this turn would use your connection" style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 4, padding: '0 5px' }}>for you</span>
                          <button onClick={() => void decideEvent(ev, 'allow')} style={{ background: 'var(--green)', color: '#04140d', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Allow</button>
                          <button onClick={() => void decideEvent(ev, 'deny')} style={{ background: 'none', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Deny</button>
                        </span>
                      )}
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
        {tab === 'Memory' && <MemoryTab a={a} />}
        {tab === 'Skills & tools' && <SkillsToolsTab a={a} />}
        {tab === 'Files' && <AgentFilesTab a={a} />}
        {tab === 'Trust' && (app.workspaceId ? <Suspense fallback={<div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>Loading…</div>}><AgentTrustTab agentId={a.id} wsId={a.workspaceId || app.workspaceId} /></Suspense> : <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>Open a workspace to see this agent's trust levels.</div>)}

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
                      <PublishButton compact target={{ kind: 'app', agentId: a.id, appId: x.id }} defaultName={x.name} defaultDescription={x.description} />
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
            <IdentityCard a={a} />
            <ModelCard a={a} />
            <HeartbeatCard a={a} />
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

            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ ...label, marginBottom: 8 }}>Workspace</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-dim)', minWidth: 200 }}>
                  {a.name} belongs to <b>{app.workspaces.find((w) => w.id === (a.workspaceId || app.workspaceId))?.name ?? 'this workspace'}</b>. Agents are never shared across workspaces; moving takes its chats along and leaves its organization and channels behind.
                </span>
                <select
                  value=""
                  disabled={app.workspaces.length < 2}
                  onChange={async (e) => {
                    const target = e.target.value;
                    if (!target) return;
                    const ws = app.workspaces.find((w) => w.id === target);
                    if (!window.confirm(`Move ${a.name} to ${ws?.name ?? 'that workspace'}?`)) return;
                    try {
                      await api.moveAgent(a.id, target);
                      await app.refreshAgents();
                      await app.refreshSessions();
                      app.setSelectedAgent(null);
                      app.go('overview');
                      app.showToast(`Moved ${a.name} to ${ws?.name ?? 'the workspace'}`);
                    } catch (err) {
                      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'move failed');
                    }
                  }}
                  style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '7px 10px', fontSize: 12, cursor: 'pointer' }}
                >
                  <option value="">Move to workspace…</option>
                  {app.workspaces.filter((w) => w.id !== (a.workspaceId || app.workspaceId)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
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
      {importing && <MemoryImportModal a={a} onClose={() => setImporting(false)} />}
    </div>
  );
}
