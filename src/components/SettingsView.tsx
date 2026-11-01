/** Settings main pane: providers, MCP servers, skills, permissions, context
 *  budget, and workspace memory — persisted to the real API. */
import { useEffect, useState } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { ImportSkillMdButton, RevisionCard, ScanFlags, SkillStats } from './SkillBits';
import { api, PROVIDER_COLORS, type BrowserStatus, type Connection, type ConnectionProvider, type EmailStatus, type PricingInfo, type ProfileProposal, type QuietHours, type QuietPolicy, type RunnerStatus, type Workspace, type WorkspaceUsage } from '../lib/api';
import { fmtTokens, safeJsonParse, workspaceSpend } from '../lib/util';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { fmtUsd } from '../lib/pricing';
import { UsageBars, UsageRows } from './UsageChart';

const PANE_META: Record<string, [string, string]> = {
  providers: ['Providers & agent types', 'Reusable presets: provider, default model, API key, and persona. A type with no key falls back to the Echo dev provider.'],
  mcp: ['MCP servers', 'Tools discovered from enabled MCP servers are offered to chats and gated by the Ask/Auto policy.'],
  skills: ['Skills & registries', 'Local skills are offered to the model as tools within the turn loop and as slash commands.'],
  permissions: ['Permissions', 'Default permission mode for new chats and remembered approvals.'],
  context: ['Context & budget', 'Token ceiling and automatic compaction threshold.'],
  memory: ['Workspace memory', 'Durable chat memory injected as shared context for this workspace.'],
  workspace: ['Workspace', 'Quiet hours, the interrupt policy, and the monthly spend stop. Loops keep working; what changes is when you hear about it and how much it may cost.'],
  usage: ['Usage', 'Tokens and dollars over the last 30 days — per agent, per loop, per day — and the price table behind the estimate.'],
  channels: ['Channels', 'Talk to your agents where you already are — Telegram, email, and push to this device, paired to you alone.'],
  connections: ['Connections', 'Link external services (Google Calendar first). Connecting grants nothing — you approve access per agent.'],
  runner: ['Code runner & browser', 'Where run_js / run_python execute and where browser_open / browser_act render. Both are disposable and approval-gated; the browser is credential-free and visible to you.'],
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
  const revisions = live.filter((s) => s.pendingRevision);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-faint)', flex: 1 }}>
          Skills record which turns loaded them and how those turns were rated; a 👎 lets the agent propose a revision you accept as a diff.
        </span>
        <ImportSkillMdButton scope={{ workspaceId: app.workspaceId || undefined }} onDone={() => void app.refreshSkills()} />
      </div>
      {revisions.length > 0 && (
        <div style={{ ...card, borderColor: 'var(--amber)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 4 }}>Proposed revisions · {revisions.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 6 }}>
            An agent revised a skill after a reply that used it was rated down. Nothing changes until you accept the diff; the previous text is kept in history.
          </div>
          {revisions.map((s) => (
            <div key={s.id} style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, ...mono }}>/{s.name}</span>
              <RevisionCard s={s} onDone={() => void app.refreshSkills()} />
            </div>
          ))}
        </div>
      )}
      {drafts.length > 0 && (
        <div style={{ ...card, borderColor: 'var(--amber)' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--amber)', marginBottom: 4 }}>Skill drafts · {drafts.length}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10 }}>
            Captured by agents from work that went well, or imported from a SKILL.md (with its scan flags). A draft only becomes callable after you approve it.
          </div>
          {drafts.map((s) => (
            <div key={s.id} style={{ padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, marginBottom: 8, background: 'var(--panel-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 13, fontWeight: 600, ...mono }}>/{s.name}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{s.scanReport ? 'imported' : 'drafted'} by {s.proposedBy || 'an agent'}</span>
                <span style={{ flex: 1 }} />
                <button onClick={async () => { await api.resolveSkillDraft(s.id, true); await app.refreshSkills(); app.showToast(`Skill /${s.name} approved`); }}
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Approve</button>
                <button onClick={async () => { await api.resolveSkillDraft(s.id, false); await app.refreshSkills(); app.showToast('Draft rejected'); }}
                  style={{ background: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Reject</button>
              </div>
              {s.description && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 5 }}>{s.description}</div>}
              <ScanFlags s={s} />
              <pre style={{ margin: '8px 0 0', padding: '9px 11px', background: 'var(--code)', borderRadius: 8, fontSize: 11, ...mono, lineHeight: 1.55, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto' }}>{s.instructions}</pre>
            </div>
          ))}
        </div>
      )}
      {live.map((s) => (
        <div key={s.id} style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, ...mono }}>/{s.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--text-faint)', borderRadius: 5, padding: '1px 6px' }}>{s.builtin ? 'built-in' : s.workspaceId ? 'workspace' : 'global'}</span>
                {s.pendingRevision && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 5, padding: '1px 6px' }}>revision pending</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{s.description || 'No description'}</div>
              <div style={{ marginTop: 5 }}><SkillStats s={s} /></div>
            </div>
            <a href={api.skillMdUrl(s.id)} download title="Export as agentskills.io SKILL.md" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 7, padding: '4px 10px', textDecoration: 'none', flex: 'none' }}>SKILL.md</a>
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
      <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 15, paddingTop: 15 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Read replies aloud</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Shows a speaker button on assistant replies that plays them through the configured OpenAI-compatible speech endpoint (TRANSCRIPTION_* in .env; docs/voice.md). Voice notes transcribe on upload regardless.</div>
          </div>
          <button onClick={() => void app.saveSettings({ ttsEnabled: app.settings.ttsEnabled === 'on' ? 'off' : 'on' })}
            style={{ background: app.settings.ttsEnabled === 'on' ? 'var(--accent-dim)' : 'var(--panel-2)', color: 'var(--text)', border: `1px solid ${app.settings.ttsEnabled === 'on' ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>
            {app.settings.ttsEnabled === 'on' ? 'On' : 'Off'}
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Voice</span>
          <input defaultValue={app.settings.ttsVoice ?? ''} placeholder="alloy"
            onBlur={(e) => void app.saveSettings({ ttsVoice: e.target.value.trim() })}
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

const inputStyle: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '7px 10px', color: 'var(--text)', fontSize: 12.5, outline: 'none' };

/** Every IANA zone the browser knows, with the browser's own zone first;
 *  older engines without supportedValuesOf get a short useful list. */
function timezoneOptions(current: string): string[] {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let all: string[];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch { all = []; }
  if (all.length === 0) all = ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Asia/Singapore', 'Australia/Sydney'];
  return [...new Set([own, current, ...all].filter(Boolean))];
}

const POLICIES: Array<{ key: QuietPolicy; label: string; desc: string }> = [
  { key: 'queue', label: 'Queue', desc: 'Notifications wait until the window ends, then go out together.' },
  { key: 'silent', label: 'Silent', desc: 'Events land in the inbox only — nothing is pushed to channels, even later.' },
  { key: 'allow-urgent', label: 'Allow urgent', desc: 'Like Queue, but loop failures and budget stops come through immediately.' },
];

/** Settings → Workspace (roadmap phase 2.3 / 2.5): quiet hours + interrupt
 *  policy, and the monthly hard spend stop. */
function WorkspacePane() {
  const app = useApp();
  const ws = app.workspaces.find((w) => w.id === app.workspaceId);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const saved = safeJsonParse<QuietHours | null>(ws?.quietHours, null);
  const [enabled, setEnabled] = useState(Boolean(saved));
  const [q, setQ] = useState<QuietHours>(saved ?? { start: '22:00', end: '07:00', timezone: browserTz, policy: 'queue' });
  const [budget, setBudget] = useState(String(ws?.spendBudgetTokens ?? 0));
  useEffect(() => {
    const cur = safeJsonParse<QuietHours | null>(ws?.quietHours, null);
    setEnabled(Boolean(cur));
    if (cur) setQ(cur);
    setBudget(String(ws?.spendBudgetTokens ?? 0));
  }, [ws?.id, ws?.quietHours, ws?.spendBudgetTokens]);
  if (!ws) return null;

  const spend = workspaceSpend(ws);
  const pct = spend.budgetTokens > 0 ? Math.min(100, (spend.spentTokens / spend.budgetTokens) * 100) : 0;
  const crossesMidnight = q.start > q.end;

  const saveQuiet = async (next: { enabled: boolean; q: QuietHours }) => {
    try {
      await api.updateWorkspace(ws.id, { quietHours: next.enabled ? JSON.stringify(next.q) : '' });
      await app.refreshWorkspaces();
      app.showToast(next.enabled ? 'Quiet hours saved' : 'Quiet hours off');
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'save failed');
    }
  };
  const saveBudget = async () => {
    const n = parseInt(budget || '0', 10);
    try {
      await api.updateWorkspace(ws.id, { spendBudgetTokens: Number.isFinite(n) ? n : 0 });
      await app.refreshWorkspaces();
      app.showToast(n > 0 ? `Budget set to ${fmtTokens(n)} tokens / month` : 'Budget removed');
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 140) : 'save failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Quiet hours</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>
              Loops still run on schedule inside the window; their notifications are held or muted according to the policy.
            </div>
          </div>
          <Toggle on={enabled} onClick={() => { const next = !enabled; setEnabled(next); void saveQuiet({ enabled: next, q }); }} />
        </div>
        {enabled && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                From
                <input type="time" value={q.start} onChange={(e) => setQ({ ...q, start: e.target.value })} style={{ ...inputStyle, ...mono }} />
              </label>
              <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                Until
                <input type="time" value={q.end} onChange={(e) => setQ({ ...q, end: e.target.value })} style={{ ...inputStyle, ...mono }} />
              </label>
              <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 200 }}>
                Timezone
                <select value={q.timezone} onChange={(e) => setQ({ ...q, timezone: e.target.value })} style={inputStyle}>
                  {timezoneOptions(q.timezone).map((tz) => <option key={tz} value={tz}>{tz}{tz === browserTz ? ' (this device)' : ''}</option>)}
                </select>
              </label>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              {q.start === q.end ? 'Start and end must differ.' : `Quiet from ${q.start} to ${q.end}${crossesMidnight ? ' the next day' : ''}, ${q.timezone} time.`}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {POLICIES.map((pol) => (
                <div key={pol.key} onClick={() => setQ({ ...q, policy: pol.key })}
                  style={{ flex: 1, minWidth: 160, padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${q.policy === pol.key ? 'var(--accent)' : 'var(--border)'}`, background: q.policy === pol.key ? 'var(--accent-dim)' : 'var(--panel-2)' }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>{pol.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>{pol.desc}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex' }}>
              <button disabled={q.start === q.end} onClick={() => void saveQuiet({ enabled: true, q })}
                style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: q.start === q.end ? 0.5 : 1 }}>Save quiet hours</button>
            </div>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Monthly spend stop</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>
          Every completed turn in this workspace counts toward one monthly token total. At the limit, scheduled loops are refused before any model call (one budget_stop notice per loop per day); you can still chat, with a warning. 0 = unlimited.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))} onBlur={() => void saveBudget()}
            style={{ ...inputStyle, ...mono, width: 140 }} />
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>tokens per month</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, ...mono, color: spend.over ? 'var(--red)' : 'var(--text-dim)' }}>
            {fmtTokens(spend.spentTokens)} used in {spend.month}{spend.budgetTokens > 0 ? ` / ${fmtTokens(spend.budgetTokens)}` : ''}
          </span>
        </div>
        {spend.budgetTokens > 0 && (
          <div style={{ height: 6, background: 'var(--panel-2)', borderRadius: 3, marginTop: 10, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct > 75 ? 'var(--amber)' : 'var(--accent)', borderRadius: 3 }} />
          </div>
        )}
        {spend.over && (
          <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 10, display: 'flex', gap: 7, alignItems: 'center' }}>
            <I d={P.warn} size={13} stroke="var(--red)" />Budget reached — loops are paused until {spend.month} ends or the budget is raised.
          </div>
        )}
      </div>
    </div>
  );
}

/** Settings → Usage (roadmap phase 2.5): the workspace bill made visible
 *  before it arrives, plus the override hatch for the price table. */
function UsagePane() {
  const app = useApp();
  const ws = app.workspaces.find((w) => w.id === app.workspaceId);
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [pricing, setPricing] = useState<PricingInfo | null>(null);
  const [overrides, setOverrides] = useState(app.settings.pricingOverrides || '');
  const [editing, setEditing] = useState(false);
  const wsId = ws?.id;
  useEffect(() => {
    if (!wsId) return;
    setFailed(false);
    void api.workspaceUsage(wsId, days).then(setUsage).catch(() => { setUsage(null); setFailed(true); });
  }, [wsId, days, app.settings.pricingOverrides]);
  useEffect(() => { void api.pricing().then(setPricing).catch(() => setPricing(null)); }, [app.settings.pricingOverrides]);
  useEffect(() => { setOverrides(app.settings.pricingOverrides || ''); }, [app.settings.pricingOverrides]);
  if (!ws) return null;

  const saveOverrides = async () => {
    const text = overrides.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, { input?: unknown; output?: unknown }>;
        const bad = Object.entries(parsed).find(([, v]) => typeof v?.input !== 'number' || typeof v?.output !== 'number');
        if (bad) { app.showToast(`"${bad[0]}" needs numeric input and output (USD per million tokens)`); return; }
      } catch { app.showToast('Overrides must be JSON: { "model-id": { "input": 3, "output": 15 } }'); return; }
    }
    await app.saveSettings({ pricingOverrides: text });
    setEditing(false);
    app.showToast(text ? 'Price overrides saved' : 'Price overrides cleared');
  };

  const budget = usage?.budget ?? workspaceSpend(ws);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ width: 9, height: 9, borderRadius: 3, background: ws.color }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{ws.name}</span>
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>all agents, all conversations</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[7, 30, 90].map((d) => (
              <button key={d} onClick={() => setDays(d)} style={{ background: days === d ? 'var(--accent-dim)' : 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '4px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>{d}d</button>
            ))}
          </div>
        </div>
        {failed && <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 12 }}>Could not load usage.</div>}
        {usage && (
          <>
            <div style={{ display: 'flex', gap: 22, marginTop: 14, flexWrap: 'wrap' }}>
              {[
                ['Spent', fmtUsd(usage.totals.usd), `${usage.days} days, list prices`],
                ['Tokens', fmtTokens(usage.totals.tokensIn + usage.totals.tokensOut), `${fmtTokens(usage.totals.tokensIn)} in · ${fmtTokens(usage.totals.tokensOut)} out`],
                ['Turns', String(usage.totals.turns), 'completed, stopped, or failed'],
                ['This month', `${fmtTokens(budget.spentTokens)}${budget.budgetTokens > 0 ? ` / ${fmtTokens(budget.budgetTokens)}` : ''}`, budget.budgetTokens > 0 ? (budget.over ? 'budget reached — loops paused' : 'of the workspace budget') : 'no budget set (Settings → Workspace)'],
              ].map(([k, v, sub]) => (
                <div key={k} style={{ minWidth: 120 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{k}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2, ...mono, color: k === 'This month' && budget.over ? 'var(--red)' : 'var(--text)' }}>{v}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>{sub}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16 }}><UsageBars series={usage.series} height={80} /></div>
            {usage.unpricedModels.length > 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 10, display: 'flex', gap: 7, alignItems: 'center' }}>
                <I d={P.warn} size={13} stroke="var(--amber)" />Not in the price table (tokens counted, dollars not): {usage.unpricedModels.join(', ')}. Add them to the overrides below.
              </div>
            )}
          </>
        )}
      </div>

      {usage && (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>By agent</div>
          <UsageRows rows={usage.byAgent.map((a) => ({ key: a.agentId || 'direct', label: a.name, tokensIn: a.tokensIn, tokensOut: a.tokensOut, usd: a.usd, turns: a.turns }))} />
          <div style={{ fontSize: 13, fontWeight: 600, margin: '16px 0 8px', paddingTop: 14, borderTop: '1px solid var(--border-soft)' }}>By kind</div>
          <UsageRows rows={usage.byKind} onOpen={(id) => app.openSession(id)} />
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 10 }}>Each loop is its own row across agents; open an agent’s home page for its own breakdown.</div>
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Price table</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{pricing ? `${pricing.listed} models listed · ${pricing.overridden.length} overridden` : ''}</span>
          {editing ? (
            <button onClick={() => void saveOverrides()} style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save</button>
          ) : (
            <button onClick={() => setEditing(true)} style={{ marginLeft: 'auto', background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '5px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Edit overrides</button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.55 }}>
          {pricing?.note ?? 'List prices, Oct 2026 (USD per million tokens).'} Dollar figures everywhere are estimates at these rates — cache discounts and batch tiers are not modelled. Overrides win over the list; they also price models the list does not know.
        </div>
        {editing ? (
          <textarea value={overrides} onChange={(e) => setOverrides(e.target.value)} placeholder={'{ "claude-sonnet-4-5": { "input": 3, "output": 15 } }'}
            style={{ width: '100%', minHeight: 120, resize: 'vertical', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', color: 'var(--text-dim)', fontSize: 12, ...mono, lineHeight: 1.6, outline: 'none' }} />
        ) : pricing && (
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-soft)', borderRadius: 9 }}>
            {Object.entries(pricing.prices).sort(([a], [b]) => a.localeCompare(b)).map(([model, price]) => (
              <div key={model} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 70px 70px', gap: 8, padding: '5px 10px', fontSize: 11.5, ...mono, color: pricing.overridden.includes(model) ? 'var(--accent-hi)' : 'var(--text-dim)', borderBottom: '1px solid var(--border-soft)' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model}{pricing.overridden.includes(model) ? ' *' : ''}</span>
                <span style={{ textAlign: 'right' }}>${price.input}</span>
                <span style={{ textAlign: 'right' }}>${price.output}</span>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 70px 70px', gap: 8, padding: '5px 10px', fontSize: 10, color: 'var(--text-faint)' }}>
              <span>USD per million tokens</span><span style={{ textAlign: 'right' }}>input</span><span style={{ textAlign: 'right' }}>output</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Channels (phase 4): Telegram pairing + default agent, the email channel
 *  (per-agent addresses, owner pairing, inbox digest) and web push for this
 *  device. */
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
              Its inbox events (loop runs, failures, budget stops) are pushed back here within a minute, batched, each with a link to the conversation; quiet hours apply.
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
      <EmailCard />
      <PushCard />
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Every channel follows the same shape: paired to a single owner, Ask-mode turns, and never a backdoor around tool approvals (docs/channels.md).
      </div>
    </div>
  );
}

const smallBtn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const selectStyle: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5, padding: '7px 10px', outline: 'none' };

/** Email channel: each agent's address, the owner pairing flow, and the
 *  inbox digest mode. */
function EmailCard() {
  const app = useApp();
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const refresh = () => void api.emailStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(refresh, []);
  if (!status) return null;
  const paired = status.ownerAddresses.length > 0;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: status.configured ? (paired ? 'var(--green)' : 'var(--amber)') : 'var(--text-faint)' }} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>Email</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>
          {status.configured ? `@${status.domain} · ${paired ? `${status.ownerAddresses.length} paired` : 'not paired'} · send: ${status.sendProvider}` : 'not configured'}
        </span>
      </div>
      {!status.configured && (
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Set <span style={mono}>EMAIL_DOMAIN</span> and <span style={mono}>EMAIL_INBOUND_SECRET</span>, deploy <span style={mono}>cloudflare/email-worker</span> (or any forwarder that POSTs signed JSON to <span style={mono}>/api/channels/email/inbound</span>), and pick a sending provider. Each agent then has an address.
        </div>
      )}
      {status.configured && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0 10px' }}>
            {status.addresses.map((a) => (
              <div key={a.agentId} style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'baseline' }}>
                <span style={{ minWidth: 120, color: 'var(--text-dim)' }}>{a.name}</span>
                <span style={{ ...mono, color: 'var(--text)', userSelect: 'all' }}>{a.address}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: 8 }}>
            {paired
              ? <>Mail from {status.ownerAddresses.map((a) => <span key={a} style={{ ...mono, color: 'var(--text)' }}>{a} </span>)} becomes an Ask-mode turn in <i>Email · agent</i>; the reply comes back in the thread. Approval-gated tools never run from mail.</>
              : <>Nobody is paired yet. Send any mail to an agent address from your own mailbox, then generate a code here and reply with it. Unknown senders get one pairing note and are otherwise ignored.</>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {pairCode ? (
              <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>Reply to the agent's mail with this code within 10 minutes: <span style={{ ...mono, fontSize: 14, color: 'var(--text)', background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 9px' }}>{pairCode}</span></span>
            ) : (
              <button onClick={async () => setPairCode((await api.emailPairCode()).code)} style={{ ...smallBtn, background: 'var(--accent)', color: '#fff', border: 'none' }}>Generate pairing code</button>
            )}
            {status.ownerAddresses.map((a) => (
              <button key={a} onClick={async () => { await api.emailUnpair(a); refresh(); app.showToast(`Unpaired ${a}`); }}
                style={{ ...smallBtn, border: '1px solid var(--red)', color: 'var(--red)', background: 'none' }}>Unpair {a}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text-dim)' }}>
            <span>Inbox by email:</span>
            <select value={status.digest} onChange={async (e) => { await app.saveSettings({ emailDigest: e.target.value }); refresh(); }} style={selectStyle}>
              <option value="off">off</option>
              <option value="immediate">as it happens</option>
              <option value="daily">daily digest</option>
            </select>
            {status.digest === 'daily' && (
              <>
                <span>at</span>
                <select value={String(status.digestHour)} onChange={async (e) => { await app.saveSettings({ emailDigestHour: e.target.value }); refresh(); }} style={selectStyle}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
                <span style={{ color: 'var(--text-faint)' }}>in your quiet-hours timezone (else UTC)</span>
              </>
            )}
            {status.sendProvider === 'off' && status.digest !== 'off' && <span style={{ color: 'var(--amber)' }}>EMAIL_SEND_PROVIDER is off — nothing can go out.</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** Web push for this browser: subscribe/unsubscribe against the VAPID key. */
function PushCard() {
  const app = useApp();
  const [server, setServer] = useState<{ enabled: boolean; subscriptions: number } | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  const refresh = () => {
    void api.pushPublicKey().then(setServer).catch(() => setServer(null));
    void currentSubscription().then((s) => setOn(Boolean(s))).catch(() => setOn(false));
  };
  useEffect(refresh, []);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) { await disablePush(); app.showToast('Notifications off on this device'); }
      else { await enablePush(); app.showToast('Notifications on — inbox events reach this device'); }
    } catch (err) {
      app.showToast(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: server?.enabled ? (on ? 'var(--green)' : 'var(--amber)') : 'var(--text-faint)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Notifications on this device</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55, marginTop: 2 }}>
            {!supported && 'This browser cannot receive web push (on iPhone, install the app to the home screen first).'}
            {supported && server && !server.enabled && <>The server has no VAPID keys — run <span style={mono}>npm run push:keys</span> and add them to .env.</>}
            {supported && server?.enabled && <>Inbox events (loop runs, failures, budget stops) arrive as system notifications within a minute, each opening the conversation. Quiet hours apply. {server.subscriptions} device{server.subscriptions === 1 ? '' : 's'} subscribed.</>}
          </div>
        </div>
        {supported && server?.enabled && <Toggle on={on} onClick={() => void toggle()} />}
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

  const connect = async (provider: 'google' | 'microsoft', tier: 'read' | 'write' | 'gmail' | 'mailread' | 'drive' = 'read') => {
    const d = PROV_DISPLAY[provider];
    try {
      const { url } = await api.connectStart(provider, tier);
      const popup = window.open(url, 'yaam-connect', 'width=520,height=680');
      const mine = (list: Connection[]) => list.filter((c) => c.provider === provider);
      const before = mine(conns).length;
      const capableBefore = {
        write: mine(conns).filter((c) => c.writeCapable).length,
        gmail: mine(conns).filter((c) => c.gmailCapable).length,
        mailread: mine(conns).filter((c) => c.mailReadCapable).length,
        drive: mine(conns).filter((c) => c.driveCapable).length,
      };
      const poll = setInterval(async () => {
        const now = await api.connections().catch(() => null);
        if (!now) return;
        const done = tier === 'write' ? mine(now).filter((c) => c.writeCapable).length > capableBefore.write
          : tier === 'gmail' ? mine(now).filter((c) => c.gmailCapable).length > capableBefore.gmail
            : tier === 'mailread' ? mine(now).filter((c) => c.mailReadCapable).length > capableBefore.mailread
              : tier === 'drive' ? mine(now).filter((c) => c.driveCapable).length > capableBefore.drive
                : mine(now).length > before;
        if (done || popup?.closed) {
          clearInterval(poll);
          setConns(now);
          if (done) app.showToast(tier === 'write' ? 'Calendar write access enabled' : tier === 'gmail' ? `${d.mail} enabled` : tier === 'mailread' ? `${d.mail} reading enabled for mail triggers` : tier === 'drive' ? `${d.drive} enabled` : `${d.label} connected`);
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
                  c.gmailCapable ? `${d.mail}: draft + send (sending confirms every time${c.mailReadCapable ? '; mail triggers may poll a query' : '; no read access'}).` : c.mailReadCapable ? `${d.mail}: trigger polling only (no tools).` : `${d.mail}: off.`,
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
            {provider === 'google' && !c.mailReadCapable && (
              <button onClick={() => connect(provider, 'mailread')} title="Lets an agent's mail trigger poll a Gmail search (metadata only). The tools never read mail." style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none' }}>Enable {d.mail} reading…</button>
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
      <BrowserSection />
    </div>
  );
}

/** Browser tool (docs/browser-tool.md): read-only status, same pattern as
 *  the runner — an environment decision shown live, not a toggle. */
function BrowserSection() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.browserStatus().then(setStatus).catch(() => setFailed(true)); }, []);

  const heading = <div style={{ fontSize: 15, fontWeight: 700, marginTop: 10, letterSpacing: '-.2px' }}>Browser</div>;
  if (failed) return <>{heading}<div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read browser status.</div></>;
  if (!status) return <>{heading}<div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div></>;

  const live = status.backend !== null;
  const label = status.backend === 'cloudflare' ? 'Cloudflare Browser Rendering' : status.backend === 'playwright' ? 'Local Chromium (Playwright)' : 'Off';
  return (
    <>
      {heading}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, flex: 'none' }}>{status.backend === 'cloudflare' ? '☁️' : live ? '🖥️' : '🚫'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
              <span style={{ fontSize: 10, color: live ? 'var(--green)' : 'var(--text-faint)', border: `1px solid ${live ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '1px 6px' }}>
                {live ? 'active' : 'no backend'}
              </span>
              {live && (
                <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px' }}>
                  {status.interactive ? 'interactive' : 'links + GET forms'}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3 }}>{status.detail}</div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
              {live
                ? 'Tools offered: browser_open, browser_read, browser_screenshot (read-only) and browser_act (needs approval in Ask mode). Every page the agent renders appears as a screenshot in the chat’s Browser panel.'
                : 'The browser tools are not offered to any agent while no backend is available.'}
            </div>
          </div>
        </div>
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        <strong>Credential-free and disposable.</strong> No cookies or logins survive a turn, password / one-time-code / card fields are never filled
        (the agent asks you to do that part), and every URL — including redirects and link clicks — passes the same private-address guard as <span style={mono}>web_fetch</span>.
        Page text reaches the model wrapped as untrusted data. Background loop turns never click or type; they queue the action in the agent&apos;s inbox.
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Configure with <span style={mono}>BROWSER_BACKEND</span> (<span style={mono}>auto</span> · <span style={mono}>cloudflare</span> · <span style={mono}>playwright</span> · <span style={mono}>off</span>).
        Cloudflare needs <span style={mono}>BROWSER_CF_ACCOUNT_ID</span> and <span style={mono}>BROWSER_CF_TOKEN</span> (an API token with Browser Rendering edit permission) and is stateless: it follows links and submits GET forms but cannot click arbitrary buttons.
        The local backend needs <span style={mono}>playwright-core</span> and a Chromium at <span style={mono}>BROWSER_CHROMIUM_PATH</span>; it drives a real page, one private window per turn.
      </div>
    </>
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
          {pane === 'workspace' && <WorkspacePane />}
          {pane === 'usage' && <UsagePane />}
          {pane === 'channels' && <ChannelsPane />}
          {pane === 'connections' && <ConnectionsPane />}
          {pane === 'runner' && <RunnerPane />}
        </div>
      </div>
    </div>
  );
}
