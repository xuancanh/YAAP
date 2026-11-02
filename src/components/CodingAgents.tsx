/** Coding agents (docs/coding-harnesses.md): the Settings pane that
 *  configures Claude Code, Codex, Pi and DeepSeek as the `code_agent` tool,
 *  and the read-only section on an agent's Skills & tools tab showing which
 *  of them that agent can use. The API key is write-only: the server only
 *  says whether one is stored. */
import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { api, type HarnessConfig, type HarnessId, type HarnessMode, type HarnessPatch, type HarnessRow, type HarnessView } from '../lib/api';

const card: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 13, background: 'var(--panel)', padding: '15px 17px' };
const mono: React.CSSProperties = { fontFamily: 'var(--mono)' };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5, padding: '6px 9px' };
const lbl: React.CSSProperties = { fontSize: 11, color: 'var(--text-dim)', fontWeight: 600, marginBottom: 4, display: 'block' };

/** What each mode means for each CLI — the exact flags it maps to. */
export const MODE_HELP: Record<HarnessId, Record<HarnessMode, string>> = {
  claude_code: {
    read_only: 'Read, Grep, Glob only (--permission-mode dontAsk)',
    edit: 'Read and edit files, no shell (--permission-mode acceptEdits)',
    full: 'Every tool including Bash (--permission-mode bypassPermissions) — inside the run directory',
  },
  deepseek: {
    read_only: 'Read, Grep, Glob only (--permission-mode dontAsk)',
    edit: 'Read and edit files, no shell (--permission-mode acceptEdits)',
    full: 'Every tool including Bash (--permission-mode bypassPermissions) — inside the run directory',
  },
  codex: {
    read_only: 'Codex sandbox read-only (--sandbox read-only)',
    edit: 'Edits and commands in the run directory, no network (--sandbox workspace-write)',
    full: 'workspace-write plus network for commands — never danger-full-access',
  },
  pi: {
    read_only: 'The read tool only (--tools read)',
    edit: 'read, edit, write — no bash (--tools read,edit,write)',
    full: 'All default tools including bash — Pi has no sandbox of its own; keep the OS sandbox on',
  },
};

const PI_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'openrouter'];

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
      style={{ width: 38, height: 22, borderRadius: 20, cursor: 'pointer', flex: 'none', padding: 2, display: 'flex', border: 'none', background: on ? 'var(--accent)' : 'var(--border)', justifyContent: on ? 'flex-end' : 'flex-start' }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: '#fff' }} />
    </button>
  );
}

/** The fields a save sends: what the form changed, the key only when typed. */
export function diffPatch(before: HarnessConfig, form: HarnessConfig, apiKey: string | null): HarnessPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(form) as Array<keyof HarnessConfig>) {
    if (k === 'hasApiKey') continue;
    if (JSON.stringify(form[k]) !== JSON.stringify(before[k])) out[k] = form[k];
  }
  if (apiKey !== null) out.apiKey = apiKey;
  return out as HarnessPatch;
}

function HarnessCard({ row, osSandbox, onSaved }: { row: HarnessRow; osSandbox: HarnessView['osSandbox']; onSaved: (v: HarnessView) => void }) {
  const app = useApp();
  const [form, setForm] = useState<HarnessConfig>(row.config);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [status, setStatus] = useState(row.status);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(row.config); setStatus(row.status); setApiKey(null); }, [row]);
  const set = <K extends keyof HarnessConfig>(k: K, v: HarnessConfig[K]) => setForm((f) => ({ ...f, [k]: v }));
  const agents = app.agents ?? [];
  const selected = form.agents === 'all' ? null : new Set(form.agents);
  const patch = diffPatch(row.config, form, apiKey);
  const dirty = Object.keys(patch).length > 0;

  const save = async () => {
    setBusy(true); setError('');
    try {
      const v = await api.updateHarness(row.id, patch);
      onSaved(v);
      app.showToast?.(`${row.label} saved`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = /"message":"([^"]+)"/.exec(msg);
      setError(m ? m[1] : msg.slice(0, 200));
    } finally { setBusy(false); }
  };
  const recheck = async () => {
    setBusy(true);
    try { setStatus(await api.detectHarness(row.id)); } catch { /* keep the last status */ } finally { setBusy(false); }
  };
  const toggleAgent = (id: string, field: 'agents' | 'freeAgents') => {
    if (field === 'agents') {
      const cur = new Set(form.agents === 'all' ? [] : form.agents);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      set('agents', [...cur]);
      if (!cur.has(id)) set('freeAgents', form.freeAgents.filter((x) => x !== id));
    } else {
      set('freeAgents', form.freeAgents.includes(id) ? form.freeAgents.filter((x) => x !== id) : [...form.freeAgents, id]);
    }
  };
  const allowedAgents = agents.filter((a) => form.agents === 'all' || form.agents.includes(a.id));

  return (
    <div style={card} data-testid={`harness-${row.id}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{row.label}</span>
        <span data-testid={`harness-status-${row.id}`} style={{ fontSize: 10, color: status.found ? 'var(--green)' : 'var(--text-faint)', border: `1px solid ${status.found ? 'var(--green)' : 'var(--border)'}`, borderRadius: 5, padding: '1px 6px' }}>
          {status.found ? `detected · ${status.version}` : 'not detected'}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => void recheck()} disabled={busy} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-dim)', fontSize: 11.5, padding: '3px 10px', cursor: 'pointer' }}>Re-check</button>
        <Toggle on={form.enabled} label={`Enable ${row.label}`} onClick={() => set('enabled', !form.enabled)} />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 4, ...mono }}>{status.found ? status.path : status.detail}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 14 }}>
        <label><span style={lbl}>Binary path</span>
          <input style={input} value={form.binaryPath} placeholder={`on PATH: ${row.binary}`} onChange={(e) => set('binaryPath', e.target.value)} /></label>
        <label><span style={lbl}>Authentication</span>
          <select style={input} value={form.auth} onChange={(e) => set('auth', e.target.value as HarnessConfig['auth'])}>
            <option value="api_key">API key (stored encrypted)</option>
            {row.id !== 'deepseek' && <option value="cli_login">Use the CLI&apos;s own login on this machine</option>}
          </select></label>
        {form.auth === 'api_key' && (
          <label><span style={lbl}>API key {form.hasApiKey && apiKey === null ? '· stored' : ''}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={input} type="password" autoComplete="off" value={apiKey ?? ''} aria-label={`${row.label} API key`}
                placeholder={form.hasApiKey ? '•••••• stored — type to replace' : 'paste a key'} onChange={(e) => setApiKey(e.target.value)} />
              {form.hasApiKey && <button type="button" onClick={() => setApiKey('')} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--red)', fontSize: 11, padding: '0 8px', cursor: 'pointer' }}>Clear</button>}
            </div></label>
        )}
        {(row.id !== 'pi' || form.auth === 'api_key') && (
          <label><span style={lbl}>Base URL {row.id === 'deepseek' ? '(Anthropic-compatible)' : '(optional, OpenAI-compatible)'}</span>
            <input style={input} value={form.baseUrl} placeholder={row.id === 'claude_code' ? 'https://api.anthropic.com' : 'the CLI default'} onChange={(e) => set('baseUrl', e.target.value)} /></label>
        )}
        {row.id === 'pi' && (
          <label><span style={lbl}>Provider</span>
            <select style={input} value={form.provider} onChange={(e) => set('provider', e.target.value)}>
              {PI_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select></label>
        )}
        <label><span style={lbl}>Default model</span>
          <input style={input} value={form.model} placeholder="the CLI default" onChange={(e) => set('model', e.target.value)} /></label>
        <label><span style={lbl}>Max turns</span>
          <input style={input} type="number" min={1} max={200} value={form.maxTurns} onChange={(e) => set('maxTurns', Number(e.target.value))} /></label>
        <label><span style={lbl}>Timeout (seconds)</span>
          <input style={input} type="number" min={30} max={3600} value={form.timeoutS} onChange={(e) => set('timeoutS', Number(e.target.value))} /></label>
        <label><span style={lbl}>Cost cap per run (USD, 0 = none)</span>
          <input style={input} type="number" min={0} max={100} step={0.5} value={form.costCapUsd} onChange={(e) => set('costCapUsd', Number(e.target.value))} /></label>
        <label><span style={lbl}>Permissions</span>
          <select style={input} value={form.mode} onChange={(e) => set('mode', e.target.value as HarnessMode)}>
            <option value="read_only">Read only</option>
            <option value="edit">Edit files</option>
            <option value="full">Files and shell</option>
          </select>
          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', display: 'block', marginTop: 3 }}>{MODE_HELP[row.id][form.mode]}</span></label>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <Toggle on={form.osSandbox} label="OS sandbox" onClick={() => set('osSandbox', !form.osSandbox)} />
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          OS sandbox — writes jailed to the run directory ({osSandbox === 'seatbelt' ? 'Seatbelt' : osSandbox === 'bwrap' ? 'bubblewrap' : <span style={{ color: 'var(--amber)' }}>not available on this machine: runs are refused while this is on</span>})
        </span>
      </div>

      <div style={{ marginTop: 14 }}>
        <span style={lbl}>Which agents may use it</span>
        <div style={{ display: 'flex', gap: 14, fontSize: 12.5 }}>
          <label><input type="radio" checked={form.agents === 'all'} onChange={() => set('agents', 'all')} /> All agents</label>
          <label><input type="radio" checked={form.agents !== 'all'} onChange={() => set('agents', [])} /> Selected agents</label>
        </div>
        {selected && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, fontSize: 12.5 }}>
            {agents.map((a) => <label key={a.id}><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleAgent(a.id, 'agents')} /> {a.name}</label>)}
            {agents.length === 0 && <span style={{ color: 'var(--text-faint)' }}>No agents in this workspace.</span>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 14 }}>
        <span style={lbl}>Runs without approval (opt-in)</span>
        <div style={{ fontSize: 11.5, color: 'var(--amber)', marginBottom: 6 }}>
          By default every run asks first, like run_js. Agents ticked here run it without asking — in chats and loops, never from a channel. The run is still logged, attributed and reversible.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12.5 }}>
          {allowedAgents.map((a) => <label key={a.id}><input type="checkbox" aria-label={`${a.name} runs ${row.label} without approval`} checked={form.freeAgents.includes(a.id)} onChange={() => toggleAgent(a.id, 'freeAgents')} /> {a.name}</label>)}
        </div>
      </div>

      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" disabled={!dirty || busy} onClick={() => void save()}
          style={{ background: dirty ? 'var(--accent)' : 'var(--panel-2)', color: dirty ? '#fff' : 'var(--text-faint)', border: 'none', borderRadius: 8, padding: '6px 15px', fontSize: 12.5, fontWeight: 600, cursor: dirty ? 'pointer' : 'default' }}>
          Save {row.label}
        </button>
      </div>
    </div>
  );
}

export function CodingAgentsPane() {
  const [view, setView] = useState<HarnessView | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { void api.harnesses().then(setView).catch(() => setFailed(true)); }, []);
  if (failed) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-dim)' }}>Could not read the coding-agent settings.</div>;
  if (!view) return <div style={{ ...card, fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ ...card, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
        Agents get one tool, <span style={mono}>code_agent</span>, for multi-step coding in a workspace folder. Each run copies the folder
        (the agent&apos;s home by default) into a private temp directory, runs the CLI there with only the variables it needs, then syncs the
        files it changed back <strong>as the agent</strong> — versioned, revertible, and refused wherever the agent may not write. The Stop
        button kills the run and discards its changes. Install the CLIs on the server machine yourself; nothing here installs them.
      </div>
      {view.harnesses.map((row) => <HarnessCard key={row.id} row={row} osSandbox={view.osSandbox} onSaved={setView} />)}
    </div>
  );
}

/** The agent's Skills & tools tab: which coding agents it can use. */
export function AgentCodingAgents({ agentId }: { agentId: string }) {
  const [view, setView] = useState<HarnessView | null>(null);
  useEffect(() => { void Promise.resolve().then(() => api.harnesses()).then(setView).catch(() => setView(null)); }, [agentId]);
  if (!view) return null;
  const usable = view.harnesses.filter((h) => h.config.enabled && (h.config.agents === 'all' || h.config.agents.includes(agentId)));
  return (
    <div data-testid="agent-coding-agents">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--text-faint)' }}>Coding agents · {usable.length}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>the code_agent tool — configured in Settings › Coding agents</span>
      </div>
      <div style={{ ...card, padding: '6px 8px' }}>
        {usable.map((h) => {
          const free = h.config.freeAgents.includes(agentId);
          const ready = h.status.found && (h.config.auth === 'cli_login' || h.config.hasApiKey);
          return (
            <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{h.label}</span>
              <span style={{ fontSize: 10, color: ready ? 'var(--green)' : 'var(--amber)', border: `1px solid ${ready ? 'var(--green)' : 'var(--amber)'}`, borderRadius: 6, padding: '1px 7px' }}>
                {ready ? `ready · ${h.status.version}` : h.status.found ? 'needs a key' : 'not detected'}
              </span>
              <span style={{ fontSize: 10, color: free ? 'var(--amber)' : 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 6, padding: '1px 7px' }}>
                {free ? 'runs without approval' : 'asks before each run'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{h.config.mode.replace('_', ' ')}{h.config.model ? ` · ${h.config.model}` : ''}</span>
            </div>
          );
        })}
        {usable.length === 0 && <div style={{ padding: '10px 10px 12px', fontSize: 12.5, color: 'var(--text-dim)' }}>None — enable Claude Code, Codex, Pi or DeepSeek for this agent in Settings › Coding agents.</div>}
      </div>
    </div>
  );
}
