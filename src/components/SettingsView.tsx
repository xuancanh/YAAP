/** Settings main pane: providers, MCP servers, skills, permissions, context
 *  budget, and workspace memory — persisted to the real API. */
import { useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { api, PROVIDER_COLORS, type Connection, type ConnectionProvider, type ProfileProposal, type RunnerStatus, type Workspace } from '../lib/api';

const PANE_META: Record<string, [string, string]> = {
  providers: ['Providers & agent types', 'Reusable presets: provider, default model, API key, and persona. A type with no key falls back to the Echo dev provider.'],
  mcp: ['MCP servers', 'Tools discovered from enabled MCP servers are offered to chats and gated by the Ask/Auto policy.'],
  skills: ['Skills & registries', 'Local skills are offered to the model as tools within the turn loop and as slash commands.'],
  permissions: ['Permissions', 'Default permission mode for new chats and remembered approvals.'],
  context: ['Context & budget', 'Token ceiling and automatic compaction threshold.'],
  memory: ['Workspace memory', 'Durable chat memory injected as shared context for this workspace.'],
  channels: ['Channels', 'Talk to your agents where you already are — Telegram first, paired to you alone.'],
  connections: ['Connections', 'Link external services (Google Calendar first). Connecting grants nothing — you approve access per agent.'],
  runner: ['Code runner', 'Where run_js and run_python execute. Every run is disposable, offline, and approval-gated.'],
};

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '15px 17px' };
const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{ width: 38, height: 22, borderRadius: 20, cursor: 'pointer', flex: 'none', padding: 2, display: 'flex', background: on ? 'var(--accent)' : 'var(--border)', justifyContent: on ? 'flex-end' : 'flex-start', transition: 'all .15s' }}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff' }} />
    </div>
  );
}

function ProvidersPane() {
  const app = useApp();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: '', baseUrl: '', persona: '' });
  const defaultId = app.settings.defaultAgentTypeId;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {app.agentTypes.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: PROVIDER_COLORS[t.provider] ?? '#94a3b8', flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{t.name}</span>
                {t.id === defaultId && <span style={{ fontSize: 10, color: 'var(--green)', border: '1px solid var(--green)', borderRadius: 5, padding: '1px 6px' }}>default</span>}
                {!t.hasApiKey && <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--text-faint)', borderRadius: 5, padding: '1px 6px' }}>no key</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3, ...mono }}>{t.provider} · {t.model}</div>
            </div>
            <button onClick={() => void app.saveSettings({ defaultAgentTypeId: t.id })}
              style={{ background: t.id === defaultId ? 'var(--accent-dim)' : 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
              {t.id === defaultId ? 'Default' : 'Set default'}
            </button>
          </div>
        </div>
      ))}
      {adding ? (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {([['name', 'Preset name'], ['model', 'Model id'], ['apiKey', 'API key (stored server-side)'], ['baseUrl', 'Base URL (optional, anthropic-compatible)'], ['persona', 'Persona system prompt (optional)']] as const).map(([k, ph]) => (
            <input key={k} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={ph}
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none' }}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="kimi">Kimi</option>
              <option value="glm">GLM</option>
              <option value="gemini">Gemini</option>
              <option value="anthropic-compatible">Anthropic-compatible</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
              <option value="echo">Echo (dev)</option>
            </select>
            <button onClick={async () => {
              if (!form.name || !form.model) return;
              await api.createAgentType({ name: form.name, provider: form.provider, model: form.model, apiKey: form.apiKey || undefined, baseUrl: form.baseUrl || undefined, persona: form.persona || undefined });
              await app.refreshAgentTypes();
              setAdding(false);
              app.showToast(`Added ${form.name}`);
            }} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Add</button>
            <button onClick={() => setAdding(false)} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', background: 'var(--panel-2)', border: '1px dashed var(--border)', color: 'var(--text-dim)', borderRadius: 13, padding: 13, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <I d={P.plus} size={14} />Add agent type
        </button>
      )}
    </div>
  );
}

function McpPane() {
  const app = useApp();
  const [form, setForm] = useState({ name: '', url: '' });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {app.mcp.map((m) => {
        const tools = (() => {
          try {
            const parsed = JSON.parse(m.tools) as Array<string | { name: string }>;
            return parsed.map((t) => (typeof t === 'string' ? t : t.name));
          } catch { return []; }
        })();
        return (
          <div key={m.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: m.enabled ? 'var(--green)' : 'var(--text-faint)', flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</span>
                  <span style={{ fontSize: 10, color: m.enabled ? 'var(--green)' : 'var(--text-faint)', border: `1px solid ${m.enabled ? 'var(--green)' : 'var(--text-faint)'}`, borderRadius: 5, padding: '1px 6px' }}>
                    {m.enabled ? `${tools.length} tools` : 'disabled'}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3, ...mono }}>{m.url}</div>
              </div>
              <button title="Discover tools" onClick={async () => {
                try {
                  const res = await api.discoverMcp(m.id);
                  await app.refreshMcp();
                  app.showToast(`Discovered ${res.tools.length} tool(s) from ${m.name}`);
                } catch (err) {
                  app.showToast(err instanceof Error ? err.message.slice(0, 120) : 'discovery failed');
                }
              }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '6px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                <I d={P.retry} size={12} />Discover
              </button>
              <Toggle on={m.enabled === 1} onClick={async () => {
                const updated = await api.updateMcp(m.id, { enabled: m.enabled !== 1 });
                app.setMcp(app.mcp.map((x) => (x.id === m.id ? { ...x, enabled: updated.enabled as number } : x)));
              }} />
            </div>
            {m.enabled === 1 && tools.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 11, paddingTop: 11, borderTop: '1px solid var(--border-soft)' }}>
                {tools.map((t) => <span key={t} style={{ fontSize: 10.5, color: 'var(--text-dim)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px', ...mono }}>{t}</span>)}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ ...card, display: 'flex', gap: 8 }}>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Server name" style={{ width: 140, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
        <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="stdio:// or https:// URL" style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', color: 'var(--text)', fontSize: 13, outline: 'none', ...mono }} />
        <button onClick={async () => {
          if (!form.name || !form.url) return;
          await api.createMcp(form.name, form.url);
          await app.refreshMcp();
          setForm({ name: '', url: '' });
        }} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Add</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '0 4px' }}>HTTP(S) MCP servers (Streamable HTTP transport). Discovered tools are offered to chats as mcp_* and always pause for approval in Ask mode.</div>
    </div>
  );
}

function SkillsPane() {
  const app = useApp();
  const drafts = app.skills.filter((s) => s.draft === 1);
  const live = app.skills.filter((s) => s.draft !== 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {drafts.length > 0 && (
        <div style={{ ...card, borderColor: 'var(--amber)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 4 }}>Skill drafts · {drafts.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10 }}>
            Captured by agents from work that went well. A draft only becomes callable after you approve it.
          </div>
          {drafts.map((s) => (
            <div key={s.id} style={{ padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, marginBottom: 8, background: 'var(--panel-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 13, fontWeight: 600, ...mono }}>/{s.name}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>drafted by {s.proposedBy || 'an agent'}</span>
                <span style={{ flex: 1 }} />
                <button onClick={async () => { await api.resolveSkillDraft(s.id, true); await app.refreshSkills(); app.showToast(`Skill /${s.name} approved`); }}
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                <button onClick={async () => { await api.resolveSkillDraft(s.id, false); await app.refreshSkills(); app.showToast('Draft rejected'); }}
                  style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Reject</button>
              </div>
              {s.description && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 5 }}>{s.description}</div>}
              <pre style={{ margin: '8px 0 0', padding: '9px 11px', background: 'var(--code)', borderRadius: 8, fontSize: 11, ...mono, lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto' }}>{s.instructions}</pre>
            </div>
          ))}
        </div>
      )}
      {live.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600, ...mono }}>/{s.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--text-faint)', borderRadius: 5, padding: '1px 6px' }}>{s.builtin ? 'built-in' : s.workspaceId ? 'workspace' : 'global'}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{s.description || 'No description'}</div>
            </div>
            <Toggle on={s.enabled === 1} onClick={async () => {
              await api.updateSkill(s.id, { enabled: s.enabled !== 1 });
              await app.refreshSkills();
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function PermissionsPane() {
  const app = useApp();
  const mode = app.settings.defaultPermissionMode || 'ask';
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 11 }}>Default permission mode</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {[
          { key: 'ask', label: 'Ask', desc: 'Mutations, exec, HTTP & MCP pause for approval' },
          { key: 'auto', label: 'Auto', desc: 'Tools run without prompting' },
        ].map((mc) => (
          <div key={mc.key} onClick={() => void app.saveSettings({ defaultPermissionMode: mc.key })}
            style={{ flex: 1, padding: '12px 14px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${mode === mc.key ? 'var(--accent)' : 'var(--border)'}`, background: mode === mc.key ? 'var(--accent-dim)' : 'var(--panel-2)', color: 'var(--text)' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{mc.label}</div>
            <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{mc.desc}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 12, display: 'flex', gap: 7, alignItems: 'center' }}>
        <I d={P.warn} size={13} stroke="var(--amber)" />Self-modification tools can never be blanket "always allow tool".
      </div>
      <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 15, paddingTop: 15 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Independent action reviewer</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>A second, tool-free model call checks every mutating action that would run without you (Auto mode, remembered approvals) against what you asked. Secrets in the input always hold the action.</div>
          </div>
          <button onClick={() => void app.saveSettings({ actionReview: (app.settings.actionReview ?? 'on') === 'off' ? 'on' : 'off' })}
            style={{ background: (app.settings.actionReview ?? 'on') === 'off' ? 'var(--panel-2)' : 'var(--accent-dim)', color: 'var(--text)', border: `1px solid ${(app.settings.actionReview ?? 'on') === 'off' ? 'var(--border)' : 'var(--accent)'}`, borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
            {(app.settings.actionReview ?? 'on') === 'off' ? 'Off' : 'On'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Reviewer model</span>
          <input defaultValue={app.settings.reviewModel ?? ''} placeholder="cheapest model of the chat's provider"
            onBlur={(e) => void app.saveSettings({ reviewModel: e.target.value.trim() })}
            style={{ flex: 1, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '7px 11px', color: 'var(--text)', fontSize: 12.5, ...mono, outline: 'none' }} />
        </div>
      </div>
    </div>
  );
}

function ContextPane() {
  const app = useApp();
  const [ceiling, setCeiling] = useState(app.settings.defaultTokenCeiling || '200000');
  const [compact, setCompact] = useState(parseInt(app.settings.compactionThresholdTokens || '120000', 10) / 1000);
  useEffect(() => { setCeiling(app.settings.defaultTokenCeiling || '200000'); }, [app.settings.defaultTokenCeiling]);
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Token ceiling</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Turns are refused before the API call once reached. 0 = unlimited. Applies to new chats.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 11 }}>
          <input value={ceiling} onChange={(e) => setCeiling(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => void app.saveSettings({ defaultTokenCeiling: ceiling || '0' })}
            style={{ width: 130, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 13, ...mono, outline: 'none' }} />
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>tokens per chat</span>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 15 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Compaction threshold</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Provider-input size that triggers an automatic /compact.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 11 }}>
          <input type="range" min={40} max={180} value={compact}
            onChange={(e) => setCompact(+e.target.value)}
            onMouseUp={() => void app.saveSettings({ compactionThresholdTokens: String(compact * 1000) })}
            style={{ flex: 1, accentColor: 'var(--accent)' }} />
          <span style={{ fontSize: 12.5, ...mono, color: 'var(--text)', width: 56, textAlign: 'right' }}>{compact}k</span>
        </div>
      </div>
    </div>
  );
}

function MemoryPane() {
  const app = useApp();
  const ws = app.workspaces.find((w) => w.id === app.workspaceId);
  const [value, setValue] = useState(ws?.memory ?? '');
  useEffect(() => { setValue(ws?.memory ?? ''); }, [ws?.id, ws?.memory]);
  if (!ws) return null;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: ws.color }} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>{ws.name} memory</span>
        <button onClick={async () => { await api.updateWorkspace(ws.id, { memory: value }); await app.refreshWorkspaces(); app.showToast('Workspace memory saved'); }}
          style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 11 }}>Injected as shared context for every chat in this workspace.</div>
      <textarea value={value} onChange={(e) => setValue(e.target.value)}
        style={{ width: '100%', minHeight: 180, resize: 'vertical', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 15px', color: 'var(--text-dim)', fontSize: 12.5, ...mono, lineHeight: 1.6, outline: 'none' }} />
      <ProfileSection ws={ws} />
    </div>
  );
}

/** The consented user profile: agents propose entries with
 *  update_user_profile; nothing is remembered until it is approved here. */
function ProfileSection({ ws }: { ws: Workspace }) {
  const app = useApp();
  const pending = (() => { try { return JSON.parse(ws.profilePending) as ProfileProposal[]; } catch { return []; } })();
  const [profile, setProfile] = useState(ws.profile);
  useEffect(() => { setProfile(ws.profile); }, [ws.id, ws.profile]);

  const resolve = async (proposalId: string, approve: boolean) => {
    await api.resolveProfileProposal(ws.id, proposalId, approve);
    await app.refreshWorkspaces();
    app.showToast(approve ? 'Added to your profile' : 'Proposal rejected');
  };

  return (
    <div style={{ marginTop: 22, borderTop: '1px solid var(--border-soft)', paddingTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>What agents know about you</span>
        <button onClick={async () => { await api.updateWorkspace(ws.id, { profile }); await app.refreshWorkspaces(); app.showToast('Profile saved'); }}
          style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 11 }}>
        Your consented profile. Agents propose entries; only what you approve below (or write here yourself) is remembered.
      </div>
      <textarea value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="- Prefers concise answers"
        style={{ width: '100%', minHeight: 110, resize: 'vertical', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '13px 15px', color: 'var(--text-dim)', fontSize: 12.5, ...mono, lineHeight: 1.6, outline: 'none' }} />
      {pending.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--amber)', marginBottom: 8 }}>Pending proposals · {pending.length}</div>
          {pending.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, marginBottom: 7, background: 'var(--panel-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{p.entry}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>proposed by {p.agentName || 'an agent'} · {p.at.slice(0, 10)}</div>
              </div>
              <button onClick={() => void resolve(p.id, true)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Approve</button>
              <button onClick={() => void resolve(p.id, false)} style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Reject</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Telegram channel (phase 4): pairing-code flow + default agent pick. */
function ChannelsPane() {
  const app = useApp();
  const [status, setStatus] = useState<{ configured: boolean; paired: boolean; defaultAgentId: string } | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const refresh = () => void api.telegramStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(refresh, []);

  if (!status) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Loading channel status…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: status.configured ? (status.paired ? 'var(--green)' : 'var(--amber)') : 'var(--text-faint)' }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Telegram</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
            {status.configured ? (status.paired ? 'paired' : 'not paired') : 'not configured'}
          </span>
        </div>
        {!status.configured && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            Create a bot with @BotFather and start the server with <span style={{ fontFamily: 'var(--mono)' }}>TELEGRAM_BOT_TOKEN=…</span> to enable this channel.
            The bot answers no one until it is paired to you.
          </div>
        )}
        {status.configured && !status.paired && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            {pairCode ? (
              <>Send this to your bot within 10 minutes: <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text)', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 9px' }}>/pair {pairCode}</span></>
            ) : (
              <button onClick={async () => setPairCode((await api.telegramPairCode()).code)}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Generate pairing code</button>
            )}
          </div>
        )}
        {status.paired && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
              Messages go to the default agent below in an Ask-mode conversation — approval-gated tools never run from the phone.
            </div>
            <select value={status.defaultAgentId} onChange={async (e) => { await app.saveSettings({ telegramDefaultAgentId: e.target.value }); refresh(); }}
              style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5, padding: '7px 10px', outline: 'none' }}>
              <option value="">Pick a default agent…</option>
              {app.agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}</option>)}
            </select>
            <button onClick={async () => { await api.telegramUnpair(); setPairCode(null); refresh(); app.showToast('Telegram unpaired'); }}
              style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Unpair</button>
          </div>
        )}
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        More channels (email, web push) follow the same shape: outbound-only connections, paired to a single owner, and never a backdoor around tool approvals.
      </div>
    </div>
  );
}

/** Per-provider display strings: same pane renders Google and Microsoft cards. */
const PROV_DISPLAY: Record<'google' | 'microsoft', {
  emoji: string; label: string; mail: string; drive: string;
  connectTitle: string; setupHint: string; envId: string; envSecret: string;
}> = {
  google: {
    emoji: '📅', label: 'Google', mail: 'Gmail', drive: 'Drive',
    connectTitle: 'Google (Calendar, Gmail, Drive)',
    setupHint: 'create an OAuth client in Google Cloud Console (APIs & Services → Credentials, type "Web application")',
    envId: 'GOOGLE_CLIENT_ID', envSecret: 'GOOGLE_CLIENT_SECRET',
  },
  microsoft: {
    emoji: '💼', label: 'Microsoft', mail: 'Mail', drive: 'OneDrive',
    connectTitle: 'Microsoft (Calendar, Outlook Mail, OneDrive)',
    setupHint: 'register an app in the Microsoft Entra admin center (App registrations, "Web" platform, any-tenant + personal accounts)',
    envId: 'MS_CLIENT_ID', envSecret: 'MS_CLIENT_SECRET',
  },
};

/** Connections (docs/integrations.md): user-level OAuth links to external
 *  services. Connecting grants nothing to any agent — per-agent grants live
 *  on each agent's Skills & tools tab (activation gate). */
function ConnectionsPane() {
  const app = useApp();
  const [providers, setProviders] = useState<ConnectionProvider[]>([]);
  const [conns, setConns] = useState<Connection[]>([]);
  const refresh = () => {
    void api.connectionProviders().then(setProviders).catch(() => setProviders([]));
    void api.connections().then(setConns).catch(() => setConns([]));
  };
  useEffect(refresh, []);

  const connect = async (provider: 'google' | 'microsoft', tier: 'read' | 'write' | 'gmail' | 'drive' = 'read') => {
    const d = PROV_DISPLAY[provider];
    try {
      const { url } = await api.connectStart(provider, tier);
      const popup = window.open(url, 'yaam-connect', 'width=520,height=680');
      const mine = (list: Connection[]) => list.filter((c) => c.provider === provider);
      const before = mine(conns).length;
      const capableBefore = {
        write: mine(conns).filter((c) => c.writeCapable).length,
        gmail: mine(conns).filter((c) => c.gmailCapable).length,
        drive: mine(conns).filter((c) => c.driveCapable).length,
      };
      const poll = setInterval(async () => {
        const now = await api.connections().catch(() => null);
        if (!now) return;
        const done = tier === 'write' ? mine(now).filter((c) => c.writeCapable).length > capableBefore.write
          : tier === 'gmail' ? mine(now).filter((c) => c.gmailCapable).length > capableBefore.gmail
            : tier === 'drive' ? mine(now).filter((c) => c.driveCapable).length > capableBefore.drive
              : mine(now).length > before;
        if (done || popup?.closed) {
          clearInterval(poll);
          setConns(now);
          if (done) app.showToast(tier === 'write' ? 'Calendar write access enabled' : tier === 'gmail' ? `${d.mail} enabled` : tier === 'drive' ? `${d.drive} enabled` : `${d.label} connected`);
        }
      }, 2500);
      setTimeout(() => clearInterval(poll), 180_000);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'connect failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {conns.map((c) => {
        const provider = (c.provider === 'microsoft' ? 'microsoft' : 'google') as 'google' | 'microsoft';
        const d = PROV_DISPLAY[provider];
        return (
        <div key={c.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span style={{ fontSize: 20, flex: 'none' }}>{d.emoji}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{d.label}</span>
                <span style={{ fontSize: 10, color: 'var(--green)', border: '1px solid var(--green)', borderRadius: 5, padding: '1px 6px' }}>connected</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3, ...mono }}>{c.accountEmail}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 4 }}>
                {[
                  c.writeCapable ? 'Calendar: read + write (writes approval-gated per agent).' : 'Calendar: read-only.',
                  c.gmailCapable ? `${d.mail}: draft + send (sending confirms every time; no read access).` : `${d.mail}: off.`,
                  c.driveCapable ? `${d.drive}: read + export.` : `${d.drive}: off.`,
                ].join(' ')}
                {' '}{c.grants.length === 0 ? 'No agents have access yet — grant it per agent on their Skills & tools tab.' : `Granted to ${new Set(c.grants.map((g) => g.agentId)).size} agent(s).`}
              </div>
            </div>
            {!c.writeCapable && (
              <button onClick={() => connect(provider, 'write')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Enable write…</button>
            )}
            {!c.gmailCapable && (
              <button onClick={() => connect(provider, 'gmail')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Enable {d.mail}…</button>
            )}
            {!c.driveCapable && (
              <button onClick={() => connect(provider, 'drive')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Enable {d.drive}…</button>
            )}
            <button onClick={async () => {
              if (!window.confirm(`Disconnect ${c.accountEmail}? Agent grants are removed and the token is revoked.`)) return;
              await api.removeConnection(c.id);
              refresh();
            }} style={{ background: 'none', border: '1px solid var(--red)', color: 'var(--red)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Disconnect</button>
          </div>
        </div>
        );
      })}
      {providers.filter((p) => !conns.some((c) => c.provider === p.provider)).map((p) => {
        const provider = (p.provider === 'microsoft' ? 'microsoft' : 'google') as 'google' | 'microsoft';
        const d = PROV_DISPLAY[provider];
        return (
        <div key={p.provider} style={card}>
          {p.configured ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span style={{ fontSize: 20, flex: 'none' }}>{d.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{d.connectTitle}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>Calendar read-only to start — write, {d.mail}, and {d.drive} are separate upgrades. You approve which agents can use it.</div>
              </div>
              <button onClick={() => connect(provider)} style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 8, padding: '8px 16px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', flex: 'none' }}>Connect</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{d.connectTitle} — not configured</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6, lineHeight: 1.65 }}>
                Self-hosted setups bring their own OAuth client: {d.setupHint}, add the redirect URI below,
                then set <span style={mono}>{d.envId}</span> and <span style={mono}>{d.envSecret}</span> in the server environment and restart.
              </div>
              <div style={{ fontSize: 11.5, marginTop: 8, padding: '7px 10px', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 8, ...mono }}>{p.redirectUri}</div>
            </div>
          )}
        </div>
        );
      })}
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Connections are yours, not your agents&apos;. Tokens stay on the server, sealed at rest, and are never shown to agents or the model —
        agents get a handful of reviewed calendar tools, and only after you grant them per agent.
      </div>
    </div>
  );
}

/** Code runner (docs/code-execution.md): read-only status. The backend is an
 *  environment decision, not a click-to-enable toggle — running code is the
 *  operator's call, so it is configured where the server starts. */
function RunnerPane() {
  const [status, setStatus] = useState<RunnerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.runnerStatus().then(setStatus).catch(() => setFailed(true)); }, []);

  if (failed) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read runner status.</div>;
  if (!status) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>;

  const live = status.backend !== null;
  const label = status.backend === 'cloudflare' ? 'Cloudflare Sandboxes' : status.backend === 'local' ? 'Local OS sandbox' : 'Off';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, flex: 'none' }}>{status.backend === 'cloudflare' ? '☁️' : live ? '🧱' : '🚫'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
              <span style={{ fontSize: 10, color: live ? 'var(--green)' : 'var(--text-faint)', border: `1px solid ${live ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '1px 6px' }}>
                {live ? 'active' : 'no backend'}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>{status.detail}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
              {live
                ? `Tools offered: ${status.languages.map((l) => (l === 'python' ? 'run_python' : 'run_js')).join(', ')}. Each call pauses for your approval in Ask mode and shows the full program.`
                : 'run_js and run_python are not offered to any agent while no backend is available.'}
            </div>
          </div>
        </div>
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Both backends give the same guarantee: <strong>no network, no filesystem beyond a scratch directory, a fresh
        environment every run, and a hard time limit.</strong> Data reaches a program only through the <span style={mono}>stdin</span>
        {' '}the agent passes, which you see in the approval card. Background loop turns never execute code — they queue it in the agent&apos;s inbox for you.
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Configure with <span style={mono}>RUNNER_BACKEND</span> (<span style={mono}>auto</span> · <span style={mono}>local</span> · <span style={mono}>cloudflare</span> · <span style={mono}>off</span>).
        The Cloudflare backend also needs <span style={mono}>RUNNER_CF_URL</span> and <span style={mono}>RUNNER_CF_TOKEN</span> — deploy <span style={mono}>cloudflare/runner-worker</span> and restart the server.
        The local backend needs <span style={mono}>sandbox-exec</span> (macOS, built in) or <span style={mono}>bubblewrap</span> (Linux).
      </div>
    </div>
  );
}

export function SettingsView({ pane }: { pane: string }) {
  const app = useApp();
  const [title, sub] = PANE_META[pane] ?? PANE_META.providers;
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 28px 60px' }}>
        {app.stacked && app.mobileDetail && (
          <button onClick={() => app.setMobileDetail(false)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: 12.5, cursor: 'pointer', padding: 0, marginBottom: 14 }}>
            <I d={P.chevL} size={14} />Settings
          </button>
        )}
        <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-.3px' }}>{title}</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>{sub}</div>
        <div style={{ marginTop: 22 }}>
          {pane === 'providers' && <ProvidersPane />}
          {pane === 'mcp' && <McpPane />}
          {pane === 'skills' && <SkillsPane />}
          {pane === 'permissions' && <PermissionsPane />}
          {pane === 'context' && <ContextPane />}
          {pane === 'memory' && <MemoryPane />}
          {pane === 'channels' && <ChannelsPane />}
          {pane === 'connections' && <ConnectionsPane />}
          {pane === 'runner' && <RunnerPane />}
        </div>
      </div>
    </div>
  );
}
