/** Settings › Coding agents (docs/coding-harnesses.md §4): every harness
 *  with its detected status and Re-check, the write-only API key, a save
 *  sends only what changed, validation errors from the server are shown,
 *  the per-agent "runs without approval" opt-in, and the agent's Skills &
 *  tools section listing what it can use. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type HarnessConfig, type HarnessId, type HarnessView } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));

const { CodingAgentsPane, AgentCodingAgents, diffPatch, MODE_HELP } = await import('../src/components/CodingAgents');

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  enabled: false, binaryPath: '', auth: 'api_key', hasApiKey: false, baseUrl: '', provider: '', model: '', maxTurns: 30, timeoutS: 900,
  costCapUsd: 2, mode: 'edit', osSandbox: true, agents: 'all', freeAgents: [], ...over,
});
const LABEL: Record<HarnessId, string> = { claude_code: 'Claude Code', codex: 'Codex', pi: 'Pi', deepseek: 'DeepSeek (via Claude Code)' };
const view = (over: Partial<Record<HarnessId, Partial<HarnessConfig>>> = {}): HarnessView => ({
  osSandbox: 'seatbelt',
  harnesses: (['claude_code', 'codex', 'pi', 'deepseek'] as HarnessId[]).map((id) => ({
    id, label: LABEL[id], binary: id === 'codex' ? 'codex' : id === 'pi' ? 'pi' : 'claude',
    config: cfg(over[id]),
    status: id === 'codex' ? { found: false, path: null, version: null, detail: 'codex not found on PATH', checkedAt: '' } : { found: true, path: '/usr/local/bin/claude', version: '2.1.310', detail: '', checkedAt: '' },
  })),
});

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { agents: [{ id: 'a1', name: 'Ada' }, { id: 'a2', name: 'Bob' }], showToast: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Settings › Coding agents', () => {
  it('lists every harness with its detection status, and Re-check asks the server again', async () => {
    vi.spyOn(api, 'harnesses').mockResolvedValue(view());
    const detect = vi.spyOn(api, 'detectHarness').mockResolvedValue({ found: true, path: '/opt/codex', version: '0.80.0', detail: '', checkedAt: '' });
    render(<CodingAgentsPane />);
    await screen.findByTestId('harness-claude_code');
    expect(screen.getByTestId('harness-status-claude_code').textContent).toContain('2.1.310');
    expect(screen.getByTestId('harness-status-codex').textContent).toContain('not detected');
    expect(screen.getByText('codex not found on PATH')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('harness-codex')).getByText('Re-check'));
    await waitFor(() => expect(screen.getByTestId('harness-status-codex').textContent).toContain('0.80.0'));
    expect(detect).toHaveBeenCalledWith('codex');
    // DeepSeek has no CLI-login option (the Claude Code login is Anthropic's)
    expect(within(screen.getByTestId('harness-deepseek')).queryByText(/CLI's own login/)).toBeNull();
  });

  it('saves only the changed fields; the key is sent once typed and never shown', async () => {
    vi.spyOn(api, 'harnesses').mockResolvedValue(view({ claude_code: { hasApiKey: true } }));
    const update = vi.spyOn(api, 'updateHarness').mockResolvedValue(view({ claude_code: { enabled: true, hasApiKey: true } }));
    render(<CodingAgentsPane />);
    const card = await screen.findByTestId('harness-claude_code');
    const save = within(card).getByText('Save Claude Code') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(card).getByRole('switch', { name: 'Enable Claude Code' }));
    const key = within(card).getByLabelText('Claude Code API key') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toContain('stored');
    fireEvent.change(key, { target: { value: 'sk-new' } });
    fireEvent.change(within(card).getByDisplayValue('30'), { target: { value: '12' } });
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith('claude_code', { enabled: true, maxTurns: 12, apiKey: 'sk-new' }));
  });

  it('shows the server\'s validation error', async () => {
    vi.spyOn(api, 'harnesses').mockResolvedValue(view());
    vi.spyOn(api, 'updateHarness').mockRejectedValue(new ApiError(400, '{"message":"baseUrl must be https (http only for localhost)","statusCode":400}'));
    render(<CodingAgentsPane />);
    const card = await screen.findByTestId('harness-codex');
    fireEvent.change(within(card).getAllByPlaceholderText('the CLI default')[0], { target: { value: 'http://x.example.com' } });
    fireEvent.click(within(card).getByText('Save Codex'));
    expect((await within(card).findByRole('alert')).textContent).toBe('baseUrl must be https (http only for localhost)');
  });

  it('the opt-in: selected agents, then "runs without approval" for one of them', async () => {
    vi.spyOn(api, 'harnesses').mockResolvedValue(view({ pi: { enabled: true, provider: 'anthropic' } }));
    const update = vi.spyOn(api, 'updateHarness').mockResolvedValue(view());
    render(<CodingAgentsPane />);
    const card = await screen.findByTestId('harness-pi');
    expect(within(card).getByText(MODE_HELP.pi.edit)).toBeTruthy();
    fireEvent.click(within(card).getByLabelText(/Selected agents/));
    fireEvent.click(within(card).getAllByLabelText(/Ada/)[0]);
    fireEvent.click(within(card).getByLabelText('Ada runs Pi without approval'));
    expect(within(card).queryByLabelText('Bob runs Pi without approval')).toBeNull();
    fireEvent.click(within(card).getByText('Save Pi'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('pi', { agents: ['a1'], freeAgents: ['a1'] }));
  });

  it('diffPatch never sends hasApiKey and sends "" to clear a key', () => {
    expect(diffPatch(cfg(), cfg({ hasApiKey: true }), null)).toEqual({});
    expect(diffPatch(cfg(), cfg(), '')).toEqual({ apiKey: '' });
  });
});

describe('the agent\'s Skills & tools tab', () => {
  it('lists the coding agents this agent may use, ready or not, and whether they ask', async () => {
    vi.spyOn(api, 'harnesses').mockResolvedValue(view({
      claude_code: { enabled: true, hasApiKey: true, freeAgents: ['a1'] },
      codex: { enabled: true, agents: ['a2'] },
      pi: { enabled: true },
    }));
    render(<AgentCodingAgents agentId="a1" />);
    const box = await screen.findByTestId('agent-coding-agents');
    expect(box.textContent).toContain('Coding agents · 2');
    expect(box.textContent).toContain('Claude Code');
    expect(box.textContent).toContain('ready · 2.1.310');
    expect(box.textContent).toContain('runs without approval');
    expect(box.textContent).toContain('needs a key');
    expect(box.textContent).not.toContain('Codex');
  });
});
