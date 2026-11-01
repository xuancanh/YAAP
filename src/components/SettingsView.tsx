/** Settings main pane: providers, MCP servers, skills, permissions, context
 *  budget, and workspace memory — persisted to the real API. */
import { useEffect, useState, lazy, Suspense } from 'react';
import { I, P } from '../lib/icons';
import { useApp } from '../store';
import { useAuth } from '../auth';
import { ImportSkillMdButton, RevisionCard, ScanFlags, SkillStats } from './SkillBits';
import { PublishButton } from './RegistryBits';
import { NewWorkspaceWizard } from './NewWorkspaceWizard';
import { api, PROVIDER_COLORS, type AccountDetail, type BrowserStatus, type ComputerAction, type ComputerStatus, type Connection, type ConnectionProvider, type EmailStatus, type FlowKind, type FlowRule, type MemberGrant, type MemberRole, type OrgCaps, type OrgMode, type PricingInfo, type ProfileProposal, type QuietHours, type QuietPolicy, type RegistryList, type RegistryStatus, type RunnerStatus, type SecurityPolicy, type Workspace, type WorkspaceInvite, type WorkspaceMember, type WorkspaceUsage, type OrgTunable } from '../lib/api';
import { AREA_LABEL, groupTunables, SLO_TARGET_OF, tunableError } from '../lib/org';
import { KIND_LABEL } from '../lib/registry';
import { PLAN_LABEL, capLine, ceilingPct, usageLine } from '../lib/account';
import { fmtTokens, safeJsonParse, workspaceSpend } from '../lib/util';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { fmtUsd } from '../lib/pricing';
import { UsageBars, UsageRows } from './UsageChart';

const PANE_META: Record<string, [string, string]> = {
  account: ['Account', 'Who you are signed in as, your plan, this month in dollars against its ceiling, and the provider keys your agents run on.'],
  providers: ['Providers & agent types', 'Reusable presets: provider, default model, API key, and persona. A type with no key falls back to the Echo dev provider.'],
  mcp: ['MCP servers', 'Tools discovered from enabled MCP servers are offered to chats and gated by the Ask/Auto policy.'],
  skills: ['Skills & registries', 'Local skills are offered to the model as tools within the turn loop and as slash commands.'],
  permissions: ['Permissions', 'Default permission mode for new chats and remembered approvals.'],
  context: ['Context & budget', 'Token ceiling and automatic compaction threshold.'],
  memory: ['Workspace memory', 'Durable chat memory injected as shared context for this workspace.'],
  workspace: ['Workspace', 'Who else works here and as what, quiet hours, the interrupt policy, and the monthly spend stop. Loops keep working; what changes is when you hear about it and how much it may cost.'],
  usage: ['Usage', 'Tokens and dollars over the last 30 days — per agent, per loop, per day — and the price table behind the estimate.'],
  channels: ['Channels', 'Talk to your agents where you already are — Telegram, email, and push to this device, paired to you alone.'],
  connections: ['Connections', 'Link external services (Google Calendar first). Connecting grants nothing — you approve access per agent.'],
  runner: ['Code runner & browser', 'Where run_js / run_python execute and where browser_open / browser_act render. Both are disposable and approval-gated; the browser is credential-free and visible to you.'],
  computer: ['Computer', 'Let agents act on your own computer through a paired companion you run. Every action is approved by you, scoped to what you granted, and recorded here.'],
  market: ['Market', 'The Community registry: which hosted registry this instance browses, whether Publish can push there, and what you have published.'],
  security: ['Security', 'The threat model this product is held to, as published in docs/security.md — and where to report a vulnerability.'],
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
  const auth = useAuth();
  /** In accounts mode non-admins manage keys in Settings → Account; the
   *  preset form here then has no key field (docs/accounts.md §6). */
  const keysInAccount = auth.mode === 'accounts' && !auth.account?.isAdmin;
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
          {keysInAccount && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Provider keys are managed in Settings → Account; this preset uses the key you set there.</div>}
          {([['name', 'Preset name'], ['model', 'Model id'], ['apiKey', 'API key (stored server-side)'], ['baseUrl', 'Base URL (optional, anthropic-compatible)'], ['persona', 'Persona system prompt (optional)']] as const).filter(([k]) => k !== 'apiKey' || !keysInAccount).map(([k, ph]) => (
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
            {!s.builtin && <PublishButton compact target={{ kind: 'skill', skillId: s.id }} defaultName={s.name} defaultDescription={s.description} />}
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
  const [channelBudget, setChannelBudget] = useState(app.settings.channelDailyTokenBudget ?? '200000');
  useEffect(() => { setCeiling(app.settings.defaultTokenCeiling || '200000'); }, [app.settings.defaultTokenCeiling]);
  useEffect(() => { setChannelBudget(app.settings.channelDailyTokenBudget ?? '200000'); }, [app.settings.channelDailyTokenBudget]);
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
      <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 15 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Channel daily token budget</div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Default for agent replies in each group-chat channel per day (docs/group-chat.md §2); a channel&apos;s own setting overrides it. 0 = unlimited.</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 11 }}>
          <input value={channelBudget} onChange={(e) => setChannelBudget(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => void app.saveSettings({ channelDailyTokenBudget: channelBudget || '0' })}
            style={{ width: 130, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 11px', color: 'var(--text)', fontSize: 13, ...mono, outline: 'none' }} />
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>tokens per channel per day</span>
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
      <MembersSection ws={ws} />
      {app.companiesEnabled && <OrganizationSection ws={ws} />}
      <HeartbeatDefaultsSection ws={ws} />
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

/** Settings → Workspace → Organization (docs/group-chat.md §5): the
 *  workspace is the company. Mode, chief of staff, the company envelope and
 *  the agent cap live here; the panes (board, goals, org chart, approvals,
 *  spend, brief, audit) appear under the workspace in the rail while the
 *  mode is on. */
const MODE_COPY: Record<OrgMode, { label: string; blurb: string }> = {
  off: { label: 'Off', blurb: 'No company. Your agents stay individuals; existing company data is kept but paused and its panes are hidden.' },
  supervised: { label: 'Supervised', blurb: 'A chief of staff runs a shared board and proposes hires, scope widening, reorganizations, budget raises and terminations as approval cards you decide (in the app or by answering the brief). Narrowing a scope, assigning and reviewing it does alone.' },
  autonomous: { label: 'Autonomous', blurb: 'The chief of staff acts on its own within hard caps: it hires from the catalog, widens scopes up to its own holdings, reorganizes, allocates envelopes and terminates — each action audited with its reason, announced in #company and listed in the next brief. Outside the caps a tool refuses with the reason; nothing is queued. It also reviews the structure when a task blocks, escalates, a budget warns or you add a goal, and once a day at the brief hour. Strategy, escalations and outward actions still come to you; budgets still hard-stop; the pause button still stops everything.' },
};

function OrganizationSection({ ws }: { ws: Workspace }) {
  const app = useApp();
  const st = app.wsOrg;
  const [mode, setMode] = useState<OrgMode>(st?.mode ?? ws.orgMode);
  const [chief, setChief] = useState(st?.chiefOfStaffAgentId ?? ws.chiefOfStaffAgentId ?? '');
  const [usd, setUsd] = useState(String(st?.orgMonthlyUsd ?? ws.orgMonthlyUsd ?? 0));
  const [cap, setCap] = useState(String(st?.orgAgentCap ?? ws.orgAgentCap ?? 12));
  const [caps, setCaps] = useState<OrgCaps | null>(null);
  const [busy, setBusy] = useState(false);
  /** The onboarding wizard (item 25) from the mode step, for a workspace that exists. */
  const [wizard, setWizard] = useState(false);
  useEffect(() => {
    setMode(st?.mode ?? ws.orgMode);
    setChief(st?.chiefOfStaffAgentId ?? ws.chiefOfStaffAgentId ?? '');
    setUsd(String(st?.orgMonthlyUsd ?? ws.orgMonthlyUsd ?? 0));
    setCap(String(st?.orgAgentCap ?? ws.orgAgentCap ?? 12));
  }, [ws.id, ws.orgMode, ws.chiefOfStaffAgentId, ws.orgMonthlyUsd, ws.orgAgentCap, st?.mode, st?.chiefOfStaffAgentId, st?.orgMonthlyUsd, st?.orgAgentCap]);
  useEffect(() => { api.orgCaps(ws.id).then(setCaps).catch(() => setCaps(null)); }, [ws.id]);
  const isOwner = !app.me || app.me.role === 'owner';
  const current = st?.mode ?? ws.orgMode;
  const save = async () => {
    setBusy(true);
    try {
      const r = await api.setWorkspaceOrg(ws.id, { mode, chiefOfStaffAgentId: mode !== 'off' && chief ? chief : undefined, monthlyUsd: Math.max(0, Number(usd) || 0), agentCap: Math.min(50, Math.max(1, parseInt(cap || '12', 10) || 12)) });
      await Promise.all([app.refreshWsOrg(), app.refreshWorkspaces(), app.refreshAgents()]);
      if (mode === 'off') app.showToast('Organization mode off — the company is paused, nothing deleted');
      else if (r.enrolled) app.showToast(`${MODE_COPY[mode].label} mode on — ${r.enrolled.length} agent(s) joined the company${r.notEnrolled?.length ? `, ${r.notEnrolled.length} could not be seated` : ''}`);
      else app.showToast(`Organization: ${MODE_COPY[mode].label}`);
    } catch (err) {
      app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'save failed');
    } finally { setBusy(false); }
  };
  const toggleRun = async () => {
    try {
      if (st?.orgStatus === 'active') { if (!confirm(`Pause the company? Every queued wake is dropped and in-flight runs are aborted.`)) return; await api.pauseOrg(ws.id); } else await api.resumeOrg(ws.id);
      await app.refreshWsOrg();
    } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'failed'); }
  };
  const open = () => { app.go('workspace'); app.setOrgPane('board'); };
  const members = st?.org?.members.filter((m) => m.status !== 'terminated').length ?? 0;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Organization</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>
            The workspace is the company. Turn it on and every agent here joins, with a chief of staff at the top; the board, goals, org chart, spend, brief and audit appear under the workspace.
          </div>
        </div>
        {current === 'off' && isOwner && (
          <button type="button" onClick={() => setWizard(true)} title="Set up a company step by step: chief of staff, vision, values and culture, budget, rhythm, first hires" style={{ background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Enable company…</button>
        )}
        {wizard && <NewWorkspaceWizard existing={{ id: ws.id, name: ws.name }} onClose={() => setWizard(false)} />}
        {current !== 'off' && st && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: st.orgStatus === 'paused' ? '#fff' : 'var(--text-dim)', background: st.orgStatus === 'paused' ? 'var(--red)' : 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '2px 8px' }}>{st.orgStatus === 'paused' ? 'paused' : `${current} · ${members} member${members === 1 ? '' : 's'}${st.pendingApprovals ? ` · ${st.pendingApprovals} pending` : ''}`}</span>
            <button onClick={open} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Open the board</button>
            {isOwner && <button onClick={() => void toggleRun()} style={{ background: st.orgStatus === 'active' ? 'var(--red)' : 'var(--accent)', border: 'none', color: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }} title={st.orgStatus === 'active' ? 'Kill switch: stop every wake and run' : 'Resume wakes and runs'}>{st.orgStatus === 'active' ? 'Pause' : 'Resume'}</button>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {(['off', 'supervised', 'autonomous'] as OrgMode[]).map((m) => (
          <div key={m} onClick={() => { if (isOwner) setMode(m); }}
            style={{ flex: 1, minWidth: 200, padding: '10px 12px', borderRadius: 10, cursor: isOwner ? 'pointer' : 'default', border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`, background: mode === m ? 'var(--accent-dim)' : 'var(--panel-2)' }}>
            <div style={{ fontWeight: 600, fontSize: 12.5 }}>{MODE_COPY[m].label}{current === m ? <span style={{ fontSize: 10.5, color: 'var(--text-faint)', fontWeight: 500 }}> · current</span> : null}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.45 }}>{MODE_COPY[m].blurb}</div>
          </div>
        ))}
      </div>
      {mode !== 'off' && (
        <div style={{ marginTop: 14, display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Chief of staff
            <select value={chief} onChange={(e) => setChief(e.target.value)} disabled={!isOwner} style={inputStyle}>
              {!chief && <option value="">{app.agents.length ? 'Pick an agent…' : 'Create one for me'}</option>}
              {app.agents.map((a) => <option key={a.id} value={a.id}>{a.emoji} {a.name}{a.role ? ` · ${a.role}` : ''}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Company envelope (USD / month, 100% is a hard stop)
            <input value={usd} onChange={(e) => setUsd(e.target.value.replace(/[^\d.]/g, ''))} disabled={!isOwner} style={{ ...inputStyle, ...mono }} placeholder="0 = none" />
          </label>
          <label style={{ fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            Agent cap (members, chief included)
            <input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} disabled={!isOwner} style={{ ...inputStyle, ...mono }} />
          </label>
        </div>
      )}
      {mode === 'autonomous' && caps && (
        <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>What the chief may do on its own</div>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {caps.rules.map((r) => <li key={r}>{r.replace('the agent cap', `the agent cap (${cap || caps.defaultAgentCap})`).replace('the company envelope', `the company envelope ($${(Number(usd) || 0).toFixed(2)}/month)`)}</li>)}
          </ul>
          {(Number(usd) || 0) <= 0 && <div style={{ color: 'var(--amber)', marginTop: 6 }}>With no company envelope the chief cannot allocate any budget: hires come without an envelope and allocations are refused until you set one.</div>}
        </div>
      )}
      {current !== 'off' && st?.orgId && <TunablesEditor ws={ws} />}
      {current !== 'off' && st?.orgId && <Suspense fallback={null}><BlueprintCard ws={ws} /></Suspense>}
      {isOwner && (
        <div style={{ display: 'flex', marginTop: 12 }}>
          <button disabled={busy || (mode !== 'off' && !chief && app.agents.length > 0)} onClick={() => void save()}
            style={{ marginLeft: 'auto', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {current === 'off' && mode !== 'off' ? `Turn on ${MODE_COPY[mode].label.toLowerCase()} mode` : 'Save organization'}
          </button>
        </div>
      )}
      {!isOwner && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 10 }}>Only the workspace owner changes the organization mode, chief and caps.</div>}
    </div>
  );
}

/** Blueprints (docs/blueprints.md, item 24) load on demand: export COMPANY.json, import one with its dry-run plan, publish to the registry. */
const BlueprintCard = lazy(() => import('./OrgBlueprintBits').then((m) => ({ default: m.BlueprintCard })));

/** The tunables (docs/company-vision.md §1b, items 18–20): every threshold
 *  the company reads — intent, planning, rituals, assurance — as a default
 *  with a bound and the org's effective value, grouped by area. The CEO
 *  writes within the fence (the bound stays in code); `slo.*` targets go
 *  through PATCH …/org/slo, everything else through PUT …/org/tunables. */
function TunablesEditor({ ws }: { ws: Workspace }) {
  const app = useApp();
  const [list, setList] = useState<OrgTunable[] | null>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [why, setWhy] = useState('');
  const reload = async () => setList(await api.orgTunables(ws.id).catch(() => null));
  useEffect(() => { if (open) void reload(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ws.id]);
  const save = async (t: OrgTunable) => {
    const raw = drafts[t.key] ?? String(t.value);
    const err = tunableError(t, raw);
    if (err) { app.showToast(`${t.key}: ${err}`); return; }
    const value = Number(raw);
    try {
      const slo = SLO_TARGET_OF[t.key];
      if (slo) await api.setOrgSlo(ws.id, { [slo]: value }); else await api.setOrgTunable(ws.id, { key: t.key, value, why: why.trim() || undefined });
      setDrafts((d) => { const n = { ...d }; delete n[t.key]; return n; });
      await reload(); void app.refreshWsOrg();
      app.showToast(`${t.key} = ${value}`);
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'save failed'); }
  };
  const reset = async (t: OrgTunable) => {
    try {
      const slo = SLO_TARGET_OF[t.key];
      if (slo) await api.setOrgSlo(ws.id, { tunables: { [t.key]: null } }); else await api.setOrgTunable(ws.id, { key: t.key, value: t.default, why: 'back to the default' });
      await reload(); app.showToast(`${t.key} back to ${t.default}`);
    } catch (e) { app.showToast(e instanceof Error ? e.message.slice(0, 160) : 'reset failed'); }
  };
  const overridden = list?.filter((t) => t.stored !== null).length ?? 0;
  return (
    <div style={{ marginTop: 14, borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Tunables</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>Nothing in the company is a fixed rule: every threshold is a default with a bound. The chief tunes within the fence (<span style={mono}>org_tune</span>); you tune here. Every change is a decision-shaped audit row.{list ? ` ${overridden} of ${list.length} changed from the default.` : ''}</div>
        </div>
        <button onClick={() => setOpen(!open)} aria-expanded={open} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{open ? 'Hide' : 'Edit tunables'}</button>
      </div>
      {open && list === null && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 8 }}>Loading…</div>}
      {open && list && (
        <div style={{ marginTop: 10 }}>
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why (recorded with each change; optional)" style={{ ...inputStyle, width: '100%', marginBottom: 8 }} aria-label="Reason for the change" />
          {groupTunables(list).map((g) => (
            <div key={g.area} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 4 }}>{AREA_LABEL[g.area]}</div>
              {g.rows.map((t) => {
                const raw = drafts[t.key] ?? String(t.value);
                const err = drafts[t.key] !== undefined ? tunableError(t, raw) : null;
                const changed = t.stored !== null;
                return (
                  <div key={t.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 96px auto', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    <div style={{ minWidth: 0 }}>
                      <label htmlFor={`tun-${t.key}`} style={{ fontSize: 12.5, fontWeight: 600, ...mono }}>{t.key}{changed && <span style={{ fontSize: 10, color: 'var(--amber)', marginLeft: 6, fontFamily: 'inherit' }}>changed</span>}</label>
                      <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{t.description} <span style={{ color: 'var(--text-faint)' }}>default {t.default} · bound {t.min}–{t.max}</span></div>
                      {err && <div style={{ fontSize: 11, color: 'var(--red)' }}>{err}</div>}
                    </div>
                    <input id={`tun-${t.key}`} value={raw} inputMode="decimal" onChange={(e) => setDrafts({ ...drafts, [t.key]: e.target.value.replace(/[^\d.-]/g, '') })} onKeyDown={(e) => { if (e.key === 'Enter') void save(t); }}
                      style={{ ...inputStyle, ...mono, width: '100%', borderColor: err ? 'var(--red)' : undefined }} />
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button disabled={drafts[t.key] === undefined || Boolean(err)} onClick={() => void save(t)} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: drafts[t.key] === undefined || err ? .5 : 1 }}>Set</button>
                      {changed && <button onClick={() => void reset(t)} title={`Back to the default (${t.default})`} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Reset</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings → Workspace → Heartbeat defaults (docs/triggers.md "Heartbeat",
 *  docs/company-vision.md §13): the cadence, daily run cap and staleness
 *  every agent of the workspace inherits unless it overrides them on its
 *  page. Bounded by the server (cadence ≥ 5 min, ≤ 48 runs a day, staleness
 *  5 min..7 d); '{}' means the built-in defaults. */
function HeartbeatDefaultsSection({ ws }: { ws: Workspace }) {
  const app = useApp();
  const saved = safeJsonParse<{ cron?: string; dailyRunCap?: number; staleMinutes?: number }>(ws.heartbeatDefaults || '{}', {});
  const [cron, setCron] = useState(saved.cron ?? '');
  const [cap, setCap] = useState(saved.dailyRunCap === undefined ? '' : String(saved.dailyRunCap));
  const [stale, setStale] = useState(saved.staleMinutes === undefined ? '' : String(saved.staleMinutes));
  useEffect(() => {
    const cur = safeJsonParse<{ cron?: string; dailyRunCap?: number; staleMinutes?: number }>(ws.heartbeatDefaults || '{}', {});
    setCron(cur.cron ?? ''); setCap(cur.dailyRunCap === undefined ? '' : String(cur.dailyRunCap)); setStale(cur.staleMinutes === undefined ? '' : String(cur.staleMinutes));
  }, [ws.id, ws.heartbeatDefaults]);
  const isOwner = !app.me || app.me.role === 'owner';
  const save = async () => {
    const next: { cron?: string; dailyRunCap?: number; staleMinutes?: number } = {};
    if (cron.trim()) next.cron = cron.trim();
    if (cap.trim()) next.dailyRunCap = parseInt(cap, 10);
    if (stale.trim()) next.staleMinutes = parseInt(stale, 10);
    try {
      await api.updateWorkspace(ws.id, { heartbeatDefaults: JSON.stringify(next) });
      await app.refreshWorkspaces();
      app.showToast(Object.keys(next).length ? 'Heartbeat defaults saved — agents without an override follow them' : 'Heartbeat defaults back to built-in');
    } catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'save failed'); }
  };
  const field: React.CSSProperties = { ...inputStyle, ...mono, width: '100%' };
  const lab: React.CSSProperties = { fontSize: 11.5, color: 'var(--text-dim)', display: 'flex', flexDirection: 'column', gap: 4 };
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Heartbeat defaults</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>Every agent beats on a cadence and runs a turn only with a reason (a stale task, an unread inbox item, an unanswered mention, a due check-in, a ritual it facilitates). These are the workspace defaults; an agent's page overrides them. Built-in: every 30 minutes, 12 runs a day, stale after 30 minutes. Fence: cadence ≥ 5 min, ≤ 48 runs a day, staleness 5 min to 7 days.</div>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginTop: 12 }}>
        <label style={lab}>Cadence (five-field cron)<input value={cron} onChange={(e) => setCron(e.target.value)} disabled={!isOwner} placeholder="*/30 * * * *" style={field} /></label>
        <label style={lab}>Daily run cap<input value={cap} onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ''))} disabled={!isOwner} placeholder="12" style={field} inputMode="numeric" /></label>
        <label style={lab}>Stale after (minutes)<input value={stale} onChange={(e) => setStale(e.target.value.replace(/[^\d]/g, ''))} disabled={!isOwner} placeholder="30" style={field} inputMode="numeric" /></label>
      </div>
      {isOwner && <div style={{ display: 'flex', marginTop: 10, gap: 6, justifyContent: 'flex-end' }}>
        <button onClick={() => { setCron(''); setCap(''); setStale(''); }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Clear</button>
        <button onClick={() => void save()} style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Save defaults</button>
      </div>}
    </div>
  );
}

const ROLE_HINT: Record<MemberRole, string> = {
  owner: 'settings, budgets, members, rules, everyone\'s connections',
  member: 'chat, tasks, files, their own connection grants and channel pairings',
  viewer: 'read-only',
};

/** Settings → Workspace → Members (docs/shared-agents.md): the owner invites
 *  by email with a role, changes roles, removes people, writes
 *  information-flow rules and sees which members' connections agents may use;
 *  a member grants their own connections to agents here. Nothing here is
 *  reachable by an agent tool. */
function MembersSection({ ws }: { ws: Workspace }) {
  const app = useApp();
  const auth = useAuth();
  const isOwner = !app.me || app.me.role === 'owner';
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [rules, setRules] = useState<FlowRule[]>([]);
  const [grants, setGrants] = useState<MemberGrant[]>([]);
  const [mine, setMine] = useState<Connection[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'viewer'>('member');
  const [rule, setRule] = useState<{ fromMember: string; toMember: string; kind: FlowKind; effect: 'allow' | 'deny' }>({ fromMember: '', toMember: '*', kind: 'lessons', effect: 'allow' });
  const [grant, setGrant] = useState<{ connectionId: string; agentId: string; service: string; level: 'read' | 'write' }>({ connectionId: '', agentId: '', service: 'calendar', level: 'read' });
  const [busy, setBusy] = useState(false);
  const accountsMode = auth.mode === 'accounts';

  const refresh = async () => {
    const [m, g] = await Promise.all([api.workspaceMembers(ws.id).catch(() => []), api.memberGrants(ws.id).catch(() => [])]);
    setMembers(m); setGrants(g);
    if (isOwner) {
      setInvites(await api.workspaceInvites(ws.id).catch(() => []));
      setRules(await api.flowRules(ws.id).catch(() => []));
    } else {
      setMine(await api.myConnections(ws.id).catch(() => []));
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, [ws.id, isOwner]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); await refresh(); await app.refreshMe(); if (done) app.showToast(done); }
    catch (err) { app.showToast(err instanceof Error ? err.message.slice(0, 160) : 'failed'); }
    finally { setBusy(false); }
  };
  const people = [{ id: app.me?.ownerAccountId ?? '', name: `${app.nameOf(null)} (owner)` }, ...members.map((m) => ({ id: m.memberAccountId, name: m.displayName || m.email }))];
  const nameOf = (id: string) => (id === '*' ? 'everyone' : app.nameOf(id));

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Members{members.length > 0 ? ` · ${members.length + 1}` : ''}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>
            {isOwner
              ? 'Other people who may use these agents, each with a role. Their sessions start private, their lessons are theirs, and a tool that would use their connection asks them — not you.'
              : `You are a ${app.me?.role} here. Your own connections can be granted to this workspace's agents below; a turn you start uses yours, and a turn someone else starts asks you first.`}
          </div>
        </div>
      </div>
      {!accountsMode && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text-dim)' }}>Single-user mode: there is no second account to invite. Shared workspaces need <code style={mono}>AUTH_MODE=accounts</code>.</div>
      )}
      {accountsMode && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9, background: 'var(--panel-2)' }}>
            <span style={{ fontSize: 14 }}>🧑</span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600 }}>{app.nameOf(null)}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 7px' }} title={ROLE_HINT.owner}>owner</span>
          </div>
          {members.map((m) => (
            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9, background: 'var(--panel-2)' }}>
              <span style={{ fontSize: 14 }}>🧑</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.displayName || m.email}{m.memberAccountId === app.me?.actorId ? ' (you)' : ''}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>{m.email} · joined {m.joinedAt.slice(0, 10)}</div>
              </div>
              {isOwner ? (
                <>
                  <select disabled={busy} value={m.role} title={ROLE_HINT[m.role]} onChange={(e) => void act(() => api.setMemberRole(ws.id, m.memberAccountId, e.target.value as MemberRole), 'Role changed')} style={{ ...inputStyle, width: 'auto', padding: '3px 6px' }}>
                    <option value="owner">owner</option><option value="member">member</option><option value="viewer">viewer</option>
                  </select>
                  <button disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.displayName || m.email} from this workspace? Their private sessions and lessons stay, unreadable to anyone else.`)) void act(() => api.removeMember(ws.id, m.memberAccountId), 'Removed'); }}
                    style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer' }}>Remove</button>
                </>
              ) : <span style={{ fontSize: 10.5, color: 'var(--text-dim)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 7px' }} title={ROLE_HINT[m.role]}>{m.role}</span>}
            </div>
          ))}
          {isOwner && invites.map((inv) => (
            <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9, border: '1px dashed var(--border)' }}>
              <span style={{ fontSize: 14, opacity: 0.6 }}>✉️</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{inv.email}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)', ...mono }}>invited as {inv.role} · expires {inv.expiresAt.slice(0, 10)}</div>
              </div>
              <button disabled={busy} onClick={() => void act(() => api.revokeInvite(ws.id, inv.id), 'Invitation revoked')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer' }}>Revoke</button>
            </div>
          ))}
          {isOwner && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                onKeyDown={(e) => { if (e.key === 'Enter' && email.trim()) void act(async () => { const r = await api.inviteMember(ws.id, email.trim(), role); setEmail(''); if (!r.sent) app.showToast('Mail is off: the invitation link was logged on the server'); }, 'Invitation sent'); }} />
              <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'viewer')} style={{ ...inputStyle, width: 'auto' }} title={ROLE_HINT[role]}>
                <option value="member">member</option><option value="viewer">viewer</option>
              </select>
              <button disabled={busy || !email.trim()} onClick={() => void act(async () => { const r = await api.inviteMember(ws.id, email.trim(), role); setEmail(''); if (!r.sent) app.showToast('Mail is off: the invitation link was logged on the server'); }, 'Invitation sent')}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: !email.trim() ? 0.5 : 1 }}>Invite</button>
            </div>
          )}

          {(grants.length > 0 || !isOwner) && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Members' connections</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>An agent uses a member's connection only in turns that member starts; a turn someone else starts pauses for that member's approval. Nothing is ever used implicitly.</div>
              {grants.map((g) => (
                <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: PROVIDER_COLORS[g.provider] ?? 'var(--text-faint)', flex: 'none' }} />
                  <span style={{ flex: 1 }}>{nameOf(g.memberAccountId)}'s {g.provider} {g.service} ({g.level}) → {app.agents.find((a) => a.id === g.agentId)?.name ?? g.agentId.slice(0, 8)}</span>
                  {(isOwner || g.memberAccountId === app.me?.actorId) && <button disabled={busy} onClick={() => void act(() => api.removeMemberGrant(ws.id, g.id), 'Grant removed')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>Revoke</button>}
                </div>
              ))}
              {!isOwner && app.me?.role !== 'viewer' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                  <select value={grant.connectionId} onChange={(e) => setGrant({ ...grant, connectionId: e.target.value })} style={{ ...inputStyle, width: 'auto', flex: 1, minWidth: 160 }}>
                    <option value="">Your connection…</option>
                    {mine.map((c) => <option key={c.id} value={c.id}>{c.provider} · {c.accountEmail}</option>)}
                  </select>
                  <select value={grant.agentId} onChange={(e) => setGrant({ ...grant, agentId: e.target.value })} style={{ ...inputStyle, width: 'auto' }}>
                    <option value="">Agent…</option>
                    {app.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <select value={grant.service} onChange={(e) => setGrant({ ...grant, service: e.target.value })} style={{ ...inputStyle, width: 'auto' }}><option value="calendar">calendar</option><option value="gmail">mail</option><option value="drive">drive</option></select>
                  <select value={grant.level} onChange={(e) => setGrant({ ...grant, level: e.target.value as 'read' | 'write' })} style={{ ...inputStyle, width: 'auto' }}><option value="read">read</option><option value="write">write</option></select>
                  <button disabled={busy || !grant.connectionId || !grant.agentId} onClick={() => void act(() => api.setMemberGrant(ws.id, grant), 'Granted')}
                    style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Grant</button>
                  {mine.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Connect a service first: switch to one of your own workspaces → Settings → Connections.</span>}
                </div>
              )}
            </div>
          )}

          {isOwner && members.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>Information-flow rules</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>By default nobody sees another member's private lessons or connection content. An allow row opens one member's material to another (or to everyone); a deny row pins an exception. Agents cannot write these.</div>
              {rules.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: r.effect === 'allow' ? 'var(--green)' : 'var(--red)', border: `1px solid ${r.effect === 'allow' ? 'var(--green)' : 'var(--red)'}`, borderRadius: 4, padding: '0 5px' }}>{r.effect}</span>
                  <span style={{ flex: 1 }}>{nameOf(r.fromMember)}'s {r.kind} → {nameOf(r.toMember)}</span>
                  <button disabled={busy} onClick={() => void act(() => api.removeFlowRule(ws.id, r.id), 'Rule removed')} style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-dim)', borderRadius: 7, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>Remove</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <select value={rule.effect} onChange={(e) => setRule({ ...rule, effect: e.target.value as 'allow' | 'deny' })} style={{ ...inputStyle, width: 'auto' }}><option value="allow">allow</option><option value="deny">deny</option></select>
                <select value={rule.fromMember} onChange={(e) => setRule({ ...rule, fromMember: e.target.value })} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="">whose…</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value as FlowKind })} style={{ ...inputStyle, width: 'auto' }}><option value="lessons">lessons</option><option value="connections">connection content</option><option value="files">files</option></select>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>→</span>
                <select value={rule.toMember} onChange={(e) => setRule({ ...rule, toMember: e.target.value })} style={{ ...inputStyle, width: 'auto' }}>
                  <option value="*">everyone</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button disabled={busy || !rule.fromMember} onClick={() => void act(() => api.addFlowRule(ws.id, rule), 'Rule added')}
                  style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Add rule</button>
              </div>
            </div>
          )}
          {!isOwner && (
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Channels: a pairing code minted under Settings → Channels while this workspace is open pairs Telegram or email to <em>you</em>, so your messages there count as yours and approvals routed to you reach you.</div>
          )}
        </div>
      )}
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

/** Desktop computer control (docs/computer-control.md): pair the companion,
 *  see what it may do, pause or disconnect it, and read the audit trail. */
function ComputerPane() {
  const app = useApp();
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [actions, setActions] = useState<ComputerAction[]>([]);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void api.computerStatus().then(setStatus).catch(() => setFailed(true));
    void api.computerActions(50).then(setActions).catch(() => {});
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5_000);
    return () => clearInterval(t);
  }, []);
  const act = async (fn: () => Promise<ComputerStatus>, toast: string) => {
    if (busy) return;
    setBusy(true);
    try { setStatus(await fn()); app.showToast(toast); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); refresh(); }
  };
  const btn = (danger = false): React.CSSProperties => ({
    background: danger ? 'none' : 'var(--panel-2)', border: `1px solid ${danger ? 'var(--red)' : 'var(--border)'}`, color: danger ? 'var(--red)' : 'var(--text)',
    borderRadius: 8, padding: '6px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flex: 'none',
  });

  if (failed) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read computer-control status.</div>;
  if (!status) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>;
  const r = status.runner;
  const dot = !status.enabled ? 'var(--text-faint)' : !r ? 'var(--text-faint)' : r.paused ? 'var(--amber)' : r.online ? 'var(--green)' : 'var(--red)';
  const state = !status.enabled ? 'disabled on this server' : !r ? 'not paired' : r.paused ? 'paused' : r.online ? 'connected' : 'paired · companion offline';
  const scopeLabel = (s: string) => s === 'screen' ? 'see the screen' : s === 'input' ? 'use mouse & keyboard' : s === 'shell' ? 'run shell commands' : `files in ${s.slice('files:'.length)}`;
  const statusColor: Record<string, string> = { ok: 'var(--green)', error: 'var(--red)', timeout: 'var(--red)', refused: 'var(--red)', queued: 'var(--amber)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...card, borderColor: 'var(--red)', background: 'color-mix(in srgb, var(--red) 7%, var(--panel))', fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--text)' }}>This is the one place agents can reach your real machine.</strong> Nothing here runs without a click from you in this app:
        every computer action pauses for approval, even in Auto mode and even if you said &quot;always allow&quot; to something else; shell commands and file writes can never be
        auto-approved; scheduled loops and Telegram turns are refused outright. The companion connects outbound — nothing listens on your computer.
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{r ? r.name : 'Companion'}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', ...mono }}>{state}{r?.platform ? ` · ${r.platform}` : ''}</span>
          {r && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-faint)' }}>last seen {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleTimeString() : 'never'}</span>}
        </div>
        {!status.enabled && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
            The server was started with <span style={mono}>COMPUTER_CONTROL_ENABLED=false</span>. No computer tool exists for any agent and the companion is refused, whatever is paired.
          </div>
        )}
        {status.enabled && !r && (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.7 }}>
            <div style={{ marginBottom: 8 }}>Install the companion on the computer you want agents to use, then pair it with a one-time code. You choose the scopes on that computer, at the keyboard; the server can only narrow them later.</div>
            {pairCode ? (
              <div style={{ background: 'var(--code)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 13px', ...mono, fontSize: 12.5, color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                npx yaam-companion pair {window.location.origin} {pairCode} --scopes screen,input,files:$HOME/Projects{'\n'}
                <span style={{ color: 'var(--text-faint)' }}># add shell to let agents run commands · code valid 10 minutes · then: npx yaam-companion run</span>
              </div>
            ) : (
              <button disabled={busy} onClick={async () => { try { setPairCode((await api.computerPairCode()).code); } catch (e) { app.showToast(e instanceof Error ? e.message : 'failed'); } }}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 15px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>Generate pairing code</button>
            )}
          </div>
        )}
        {status.enabled && r && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {r.scopes.map((s) => (
                <span key={s} style={{ fontSize: 11.5, color: 'var(--text)', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 7, padding: '3px 9px', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {scopeLabel(s)}
                  {r.scopes.length > 1 && (
                    <button title="Remove this scope (scopes can only be narrowed here)" disabled={busy}
                      onClick={() => void act(() => api.computerNarrowScopes(r.scopes.filter((x) => x !== s)), `Scope removed: ${scopeLabel(s)}`)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'flex' }}><I d={P.x} size={11} /></button>
                  )}
                </span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 10, lineHeight: 1.5 }}>
              Scopes were chosen on the companion when it paired. Removing one here is immediate; to add one, disconnect and pair again with the wider set.
              {!r.online && !r.paused && <> The companion is not polling right now — start it with <span style={mono}>yaam-companion run</span>.</>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {r.paused
                ? <button disabled={busy} onClick={() => void act(api.computerResume, 'Computer control resumed')} style={{ ...btn(), background: 'var(--accent-dim)', borderColor: 'var(--accent)' }}>Resume</button>
                : <button disabled={busy} onClick={() => void act(api.computerPause, 'Computer control paused — pairing kept, every action refused')} style={btn()}>Pause</button>}
              <button disabled={busy} onClick={() => { if (window.confirm('Disconnect the companion? Its token stops working immediately and any action in flight is refused.')) void act(api.computerDisconnect, 'Companion disconnected — token revoked'); }} style={{ ...btn(true), marginLeft: 'auto' }}>Disconnect</button>
            </div>
          </>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Recent actions</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>last {actions.length} · every action, including refused ones</span>
        </div>
        {actions.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Nothing yet.</div>}
        {actions.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor[a.status] ?? 'var(--text-faint)', flex: 'none' }} />
            <span style={{ color: 'var(--text-faint)', flex: 'none', ...mono, fontSize: 11 }}>{new Date(a.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span style={{ ...mono, fontWeight: 600, flex: 'none' }}>{a.tool.replace(/^computer_/, '')}</span>
            <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={a.resultSummary}>{a.inputSummary}</span>
            <span style={{ color: statusColor[a.status] ?? 'var(--text-faint)', fontWeight: 600, flex: 'none', fontSize: 11 }}>{a.status}</span>
            {a.sessionId && <button onClick={() => app.openSession(a.sessionId)} title="Open the conversation" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex' }}><I d={P.external} size={12} /></button>}
          </div>
        ))}
      </div>

      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Kill switches, strongest first: <span style={mono}>COMPUTER_CONTROL_ENABLED=false</span> on the server (tools vanish, companion refused) · <strong>Disconnect</strong> (token revoked now) · <strong>Pause</strong> (pairing kept, actions refused) ·
        and on the computer itself, stopping <span style={mono}>yaam-companion run</span>. Screenshots are saved as workspace files under <span style={mono}>computer/&lt;chat&gt;/</span>. See <span style={mono}>docs/computer-control.md</span>.
      </div>
    </div>
  );
}

/** Market registry (docs/registry.md): remote URL + reachability, publish
 *  token presence, and the items this instance has published. Read-only —
 *  the registry is an environment decision, like the runner. */
function MarketPane() {
  const [status, setStatus] = useState<RegistryStatus | null>(null);
  const [list, setList] = useState<RegistryList | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void api.registryStatus().then(setStatus).catch(() => setFailed(true));
    void api.registry().then(setList).catch(() => {});
  }, []);
  if (failed) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read registry status.</div>;
  if (!status) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>;
  const mine = (list?.items ?? []).filter((i) => i.source === 'local');
  const remoteOk = !!list && list.remote.ok;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 20, flex: 'none' }}>{status.remoteUrl ? '🌐' : '🏠'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{status.remoteUrl ? 'Remote registry' : 'Local registry only'}</span>
              {status.remoteUrl && (
                <span style={{ fontSize: 10, color: remoteOk ? 'var(--green)' : 'var(--amber)', border: `1px solid ${remoteOk ? 'var(--green)' : 'var(--amber)'}`, borderRadius: 5, padding: '1px 6px' }}>
                  {remoteOk ? 'reachable' : list ? 'unreachable' : 'checking…'}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 3, ...mono, wordBreak: 'break-all' }}>{status.remoteUrl || 'REGISTRY_URL is not set'}</div>
            {list && status.remoteUrl && !list.remote.ok && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 4 }}>{list.remote.error}</div>}
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4 }}>
              {status.remoteUrl
                ? 'Its public items are merged into Market → Community (cached 10 minutes). Installing one pulls the manifest and runs the scan here, under the same review.'
                : 'Market → Community shows only what this instance has published. Set REGISTRY_URL to browse a hosted registry as well.'}
            </div>
          </div>
        </div>
      </div>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Publish token</span>
          <span style={{ fontSize: 10, color: status.publishToken ? 'var(--green)' : 'var(--text-faint)', border: `1px solid ${status.publishToken ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '1px 6px' }}>{status.publishToken ? 'set' : 'not set'}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.6 }}>
          {status.publishToken
            ? 'Publish pushes each item to the remote registry too, and this instance accepts pushes that present the same token on POST /api/registry/public.'
            : 'Publishing stays local. Set REGISTRY_PUBLISH_TOKEN (with REGISTRY_URL) to push your items to the hosted registry.'}
        </div>
      </div>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Published from here · {mine.length}</div>
        {mine.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Nothing yet. Use Publish on an agent&apos;s home page, a skill row or a mini-app card.</div>}
        {mine.map((i) => (
          <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12.5 }}>
            <span style={{ fontWeight: 600 }}>{i.name}</span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 6px' }}>{KIND_LABEL[i.kind]}</span>
            <span style={{ ...mono, fontSize: 11, color: 'var(--text-faint)' }}>v{i.version}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{i.installs} install{i.installs === 1 ? '' : 's'} · 👍 {i.ratingUp} · 👎 {i.ratingDown}{i.scanReport.flags.length ? ` · ${i.scanReport.flags.length} flag${i.scanReport.flags.length === 1 ? '' : 's'}` : ''}</span>
          </div>
        ))}
      </div>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        What the registry deliberately does not do: payments, unreviewed installs, or trusting a remote scan — every install here re-scans and shows you the real text.
      </div>
    </div>
  );
}

/** Settings → Account (docs/accounts.md §6). Single mode: says so and
 *  stops. Accounts mode: identity, plan, the month against its ceiling,
 *  the BYO keys form (the one place non-admins edit keys), sign-out, and
 *  the admin plan switcher when ADMIN_EMAILS lists this address. */
function AccountPane() {
  const app = useApp();
  const auth = useAuth();
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [admin, setAdmin] = useState<Array<{ id: string; email: string; plan: string; status: string; usage: { usd: number } }> | null>(null);
  const reload = () => api.account().then(setDetail).catch(() => setDetail(null));
  useEffect(() => { void reload(); }, []);
  useEffect(() => { if (detail?.isAdmin && auth.mode === 'accounts') api.adminAccounts().then(setAdmin).catch(() => setAdmin(null)); }, [detail?.isAdmin, auth.mode]);

  if (auth.mode !== 'accounts') {
    return (
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Single-user mode</div>
        <div style={{ color: 'var(--text-dim)', fontSize: 12.5, marginTop: 6, lineHeight: 1.5 }}>
          This install runs with <span style={mono}>AUTH_MODE=single</span>: there are no sign-ins, every agent and chat belongs to the one local account, and provider keys live on your agent types (Settings → Providers). No plan, no ceiling beyond the workspace budget. Set <span style={mono}>AUTH_MODE=accounts</span> to turn on email sign-in and per-account plans.
        </div>
      </div>
    );
  }
  if (!detail) return <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>;

  const pct = ceilingPct(detail);
  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)' };
  const btn: React.CSSProperties = { background: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' };
  const saveKey = async (provider: string) => {
    const next = await api.setAccountKey(provider, keyDraft[provider] ?? '');
    setDetail(next);
    setKeyDraft((d) => ({ ...d, [provider]: '' }));
    await app.refreshAgentTypes().catch(() => {});
    app.showToast(keyDraft[provider] ? `${provider} key saved` : `${provider} key removed`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{detail.email || detail.id}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 3 }}>{PLAN_LABEL[detail.plan]}{detail.isAdmin ? ' · admin' : ''}</div>
          </div>
          <button onClick={() => void auth.signOut()} style={btn}>Sign out</button>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-dim)' }}>
            <span>{usageLine(detail)}</span>
            <span>{detail.usage.turns} turns · {capLine(app.agents.length, detail.limits.maxAgents, 'agents')}</span>
          </div>
          {pct !== null && (
            <div style={{ height: 6, borderRadius: 4, background: 'var(--border)', marginTop: 8, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--red, #e5484d)' : 'var(--accent)' }} />
            </div>
          )}
          {pct !== null && pct >= 100 && <div style={{ fontSize: 12, color: 'var(--red, #e5484d)', marginTop: 6 }}>Ceiling reached: turns on platform keys stop until the month turns. Add your own key below to keep going.</div>}
          {detail.limits.hostedKeys && detail.platformProviders.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6 }}>This deployment has no platform keys configured; add your own below.</div>}
        </div>
        {detail.billing.manageUrl && <a href={detail.billing.manageUrl} style={{ fontSize: 12.5, color: 'var(--accent)', display: 'inline-block', marginTop: 10 }}>Manage plan</a>}
      </div>

      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Your provider keys</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 8 }}>
          Stored sealed on the server, never echoed back. A key here applies to every agent type of that provider you have{detail.limits.hostedKeys ? ', and turns on your own key are not metered against the hosted ceiling' : ''}.
        </div>
        {detail.keys.map((k) => (
          <div key={k.provider} style={row}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 110 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: PROVIDER_COLORS[k.provider] ?? '#94a3b8' }} />
              <span style={mono}>{k.provider}</span>
              {k.hasKey && <span style={{ fontSize: 10, color: 'var(--green)', border: '1px solid var(--green)', borderRadius: 5, padding: '1px 6px' }}>key set</span>}
              {!k.hasKey && detail.platformProviders.includes(k.provider) && detail.limits.hostedKeys && <span style={{ fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--text-faint)', borderRadius: 5, padding: '1px 6px' }}>platform</span>}
            </div>
            <div style={{ display: 'flex', gap: 6, flex: 1, justifyContent: 'flex-end' }}>
              <input type="password" value={keyDraft[k.provider] ?? ''} onChange={(e) => setKeyDraft((d) => ({ ...d, [k.provider]: e.target.value }))} placeholder={k.hasKey ? 'replace key' : 'paste key'}
                style={{ width: 200, background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', color: 'var(--text)', fontSize: 12.5, outline: 'none' }} />
              <button onClick={() => void saveKey(k.provider)} disabled={!keyDraft[k.provider] && !k.hasKey} style={btn}>{keyDraft[k.provider] ? 'Save' : k.hasKey ? 'Remove' : 'Save'}</button>
            </div>
          </div>
        ))}
      </div>

      {detail.isAdmin && admin && (
        <div style={card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Accounts (admin)</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginBottom: 8 }}>Plans are set by hand here until a billing provider is plugged in (docs/accounts.md §5).</div>
          {admin.map((a) => (
            <div key={a.id} style={row}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.email || a.id} <span style={{ color: 'var(--text-faint)' }}>· {a.status} · ${a.usage.usd.toFixed(2)}</span></span>
              <select value={a.plan} onChange={async (e) => {
                await api.adminPatchAccount(a.id, { plan: e.target.value as AccountDetail['plan'] });
                setAdmin(await api.adminAccounts());
                if (a.id === detail.id) void reload();
              }} style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '4px 8px', color: 'var(--text)', fontSize: 12.5 }}>
                <option value="free">free</option>
                <option value="hosted">hosted</option>
                <option value="byo">byo</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Settings → Security (execution-plan item 3): GET /api/security rendered
 *  — contact, the summary bullets, the policy link — so the hosted product
 *  shows the same policy the repo publishes. */
function SecurityPane() {
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.security().then(setPolicy).catch(() => setFailed(true)); }, []);
  if (failed) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read the security policy.</div>;
  if (!policy) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>What this product guarantees</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {policy.summary.map((line, i) => (
            <div key={i} style={{ display: 'flex', gap: 9, fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
              <I d={P.shield} size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--green)' }} /><span>{line}</span>
            </div>
          ))}
        </div>
        <a href={policy.policyUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12.5, fontWeight: 600, color: 'var(--accent-hi)', textDecoration: 'none' }}>
          Read the full threat model<I d={P.external} size={13} />
        </a>
      </div>
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Report a vulnerability</div>
        {policy.contact ? (
          <>
            <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
              Found something? Write to <span style={mono}>{policy.contact}</span> with steps to reproduce. Please do not open a public issue for security reports.
            </div>
            <a href={`mailto:${policy.contact}?subject=${encodeURIComponent('yaam-chat vulnerability report')}`} style={{ display: 'inline-block', marginTop: 10, background: 'var(--accent)', color: '#fff', borderRadius: 9, padding: '8px 15px', fontSize: 12.5, fontWeight: 600, textDecoration: 'none' }}>
              Report a vulnerability
            </a>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.55 }}>
            No disclosure address is configured on this instance. Set <span style={mono}>SECURITY_CONTACT</span> so researchers can reach the operator; the policy document names the project address.
          </div>
        )}
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
          {pane === 'account' && <AccountPane />}
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
          {pane === 'computer' && <ComputerPane />}
          {pane === 'market' && <MarketPane />}
          {pane === 'security' && <SecurityPane />}
        </div>
      </div>
    </div>
  );
}
