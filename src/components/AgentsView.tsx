/** Agents section: the directory grid and the per-agent home page
 *  (charter, file brain, loops, ratings, mini apps). */
import { useEffect, useRef, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp, grad } from '../store';
import { api, type Agent } from '../lib/api';

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
              app.setSelectedAgent(agent.id);
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

function AgentCard({ a }: { a: Agent }) {
  const app = useApp();
  const stats = app.agentStats[a.id];
  const count = app.sessions.filter((s) => s.agentId === a.id).length;
  return (
    <div onClick={() => app.setSelectedAgent(a.id)} style={{ border: '1px solid var(--border)', borderRadius: 16, background: 'var(--panel)', padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green)' }}>{stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}%` : '—'}</div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>approval</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); app.setFileTarget({ kind: 'agent', id: a.id }); app.setCurrentFile(null); app.go('files'); }}
          title="Browse fs" style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 9, padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <I d={P.folder} size={13} />fs
        </button>
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
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <I d={P.download} size={15} style={{ transform: 'rotate(180deg)' }} />Import AGENT.json
            </button>
            <button onClick={() => app.go('market')} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 10, padding: '9px 15px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              <I d={P.market} size={15} />Hire an agent
            </button>
          </div>
        </div>
        {app.agents.length === 0 && (
          <div style={{ marginTop: 40, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13.5 }}>No agents yet — hire one from the Market or create one via the API.</div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? '1fr' : 'repeat(2,1fr)', gap: 16, marginTop: 22 }}>
          {app.agents.map((a) => <AgentCard key={a.id} a={a} />)}
        </div>
      </div>
      {pending && <ImportReviewModal pending={pending} onClose={() => setPending(null)} />}
    </div>
  );
}

export function AgentHome() {
  const app = useApp();
  const a = app.agents.find((x) => x.id === app.selectedAgent);
  const [brain, setBrain] = useState('');
  const [apps, setApps] = useState<Array<{ path: string; size: number }>>([]);
  const [editingCharter, setEditingCharter] = useState(false);
  const [charterDraft, setCharterDraft] = useState('');
  const stats = a ? app.agentStats[a.id] : undefined;

  useEffect(() => {
    if (!a) return;
    void api.agentPreview(a.id, 'LESSONS.md').then((p) => setBrain(p.text ?? '')).catch(() => setBrain(''));
    void api.agentFiles(a.id).then((files) => setApps(files.filter((f) => f.path.startsWith('apps/') && f.path.endsWith('.html')))).catch(() => setApps([]));
  }, [a]);

  if (!a) return null;
  const loops = (() => { try { return JSON.parse(a.loops) as Array<{ name: string; cron: string }>; } catch { return []; } })();
  const count = app.sessions.filter((s) => s.agentId === a.id).length;
  const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 14, background: 'var(--panel)' };
  const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--text-faint)' };

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '24px 26px 60px' }}>
        <button onClick={() => app.setSelectedAgent(null)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12.5, cursor: 'pointer', padding: 0, marginBottom: 16 }}>
          <I d={P.chevL} size={14} />All agents
        </button>
        <div style={{ border: '1px solid var(--border)', borderRadius: 18, background: 'var(--panel)', overflow: 'hidden' }}>
          <div style={{ height: 70, background: grad(a.colors) }} />
          <div style={{ padding: '0 22px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginTop: -28, flexWrap: 'wrap' }}>
              <div style={{ width: 66, height: 66, borderRadius: 17, background: grad(a.colors), border: '4px solid var(--panel)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', fontSize: 30 }}>{a.emoji}</div>
              <div style={{ flex: 1, paddingBottom: 6, minWidth: 140 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.3px' }}>{a.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--green)', border: '1px solid var(--green)', borderRadius: 20, padding: '2px 9px', fontWeight: 600, whiteSpace: 'nowrap', flex: 'none' }}>Global identity</span>
                </div>
                <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 3, fontFamily: 'var(--mono)' }}>{a.provider} · {a.model || 'default model'} · agents/{a.id.slice(0, 8)}</div>
              </div>
              <div style={{ display: 'flex', gap: 8, paddingBottom: 6, flexWrap: 'wrap' }}>
                <button onClick={() => { app.setFileTarget({ kind: 'agent', id: a.id }); app.setCurrentFile(null); app.go('files'); }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <I d={P.folder} size={14} />Files
                </button>
                <button onClick={() => void app.newChat(a.id)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <I d={P.plus} size={14} />New chat
                </button>
                <a href={api.agentExportUrl(a.id)} download style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, textDecoration: 'none' }}>
                  <I d={P.download} size={14} />Export
                </a>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 24, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
              {[
                { value: String(count), label: 'chats here', color: 'var(--text)' },
                { value: stats?.rating !== null && stats?.rating !== undefined ? `${stats.rating}%` : '—', label: 'approval', color: 'var(--green)' },
                { value: String(loops.length), label: 'loops', color: 'var(--text)' },
                { value: `${apps.length}/12`, label: 'mini apps', color: 'var(--text)' },
              ].map((st) => (
                <div key={st.label}>
                  <div style={{ fontSize: 19, fontWeight: 700, color: st.color }}>{st.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>{st.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: '18px 20px', ...card }}>
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

        <div style={{ display: 'grid', gridTemplateColumns: app.width < 1000 ? '1fr' : '1fr 1fr', gap: 16, marginTop: 16 }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border-soft)', background: 'var(--panel-2)' }}>
              <span style={label}>File brain</span>
              <button onClick={() => { app.setFileTarget({ kind: 'agent', id: a.id }); app.setCurrentFile('LESSONS.md'); app.go('files'); }} style={{ background: 'none', border: 'none', color: 'var(--accent-hi)', fontSize: 11.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                Open fs<I d={P.external} size={12} />
              </button>
            </div>
            <pre style={{ margin: 0, padding: 16, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', height: 250, overflowY: 'auto' }}>{brain || '# LESSONS.md\n\n(empty)'}</pre>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ ...card, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={label}>Scheduled loops</span>
                <span style={{ fontSize: 11, color: 'var(--green)' }}>{loops.length} configured</span>
              </div>
              {loops.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-faint)', padding: '8px 0' }}>No loops — scheduled prompts land in a follow-up.</div>}
              {loops.map((l) => (
                <div key={l.name} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderTop: '1px solid var(--border-soft)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', flex: 'none' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{l.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>{l.cron}</div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>scheduled</span>
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
          </div>
        </div>

        <div style={{ marginTop: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={label}>Self-built mini apps</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{apps.length} / 12 · run only when opened, network-denied sandbox</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: app.stacked ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: 14, marginTop: 12 }}>
          {apps.map((f) => (
            <div key={f.path} onClick={async () => {
              const p = await api.agentPreview(a.id, f.path);
              if (p.text) app.openArtifact(f.path.split('/').pop()!, p.text);
            }} style={{ border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: 15, cursor: 'pointer', aspectRatio: '1', display: 'flex', flexDirection: 'column' }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19 }}>🧩</div>
              <div style={{ marginTop: 'auto' }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path.split('/').pop()!.replace('.html', '')}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>html · {(f.size / 1024).toFixed(1)} KB</div>
              </div>
            </div>
          ))}
          <div onClick={() => app.showToast('Mini apps are built by the agent through chat')} style={{ border: '1px dashed var(--border)', borderRadius: 13, padding: 15, aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-faint)', cursor: 'pointer' }}>
            <I d={P.plus} size={22} />
            <span style={{ fontSize: 11.5 }}>Build app</span>
          </div>
        </div>
      </div>
    </div>
  );
}
