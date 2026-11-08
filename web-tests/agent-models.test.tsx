/** Agent types' models in the UI (docs/agent-types.md): Settings › Providers
 *  shows a type's models with Refresh, the default and per-tier pickers; the
 *  agent's Settings › Model card offers the type's models as a dropdown with
 *  the default preselected and a marked "custom model id" escape hatch. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type AgentType } from '../src/lib/api';
import { effectiveType, fetchedLabel, typeModelList, typeTierModels } from '../src/lib/agent-models';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => '', gradPair: () => ['#000', '#fff'] }));

const { TypeModels, TypeCard, ModelSelectionCard } = await import('../src/components/SettingsView');
const { ModelCard } = await import('../src/components/AgentsView');

const ds: AgentType = {
  id: 'tDS', name: 'DeepSeek', provider: 'custom', model: 'deepseek-flash', models: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']),
  modelsFetchedAt: null, tierModels: JSON.stringify({ strong: 'deepseek-v4-pro' }), baseUrl: 'https://api.deepseek.com/v1', persona: '', enabled: 1, hasApiKey: true,
};

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    agentTypes: [ds], settings: { defaultAgentTypeId: 'tDS' }, showToast: vi.fn(),
    refreshAgents: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}), refreshAgentTypes: vi.fn(async () => {}), saveSettings: vi.fn(async () => {}), openSettings: vi.fn(),
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('agent-models helpers', () => {
  it('lists the default first, parses tier picks, and picks the effective type like the server', () => {
    expect(typeModelList(ds)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(typeTierModels(ds)).toEqual({ strong: 'deepseek-v4-pro' });
    const claude: AgentType = { ...ds, id: 'tC', name: 'Claude', provider: 'anthropic', model: 'claude-sonnet-5-5', models: '[]' };
    expect(effectiveType([ds, claude], { provider: 'anthropic' }, 'tDS')?.id).toBe('tC');
    expect(effectiveType([ds, claude], { provider: 'openai' }, 'tDS')?.id).toBe('tDS');
    expect(fetchedLabel(null)).toMatch(/not fetched/);
  });
});

describe('Settings › Providers & agent types: a type\'s models', () => {
  it('shows the models, Refresh asks the provider, and the default and tier pickers save', async () => {
    const refresh = vi.spyOn(api, 'refreshAgentTypeModels').mockResolvedValue({ id: 'tDS', name: 'DeepSeek', provider: 'custom', default: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], tierModels: {}, fetchedAt: new Date().toISOString(), discoverable: true, ok: true });
    const update = vi.spyOn(api, 'updateAgentType').mockResolvedValue(ds);
    const onChanged = vi.fn(async () => {});
    const toast = vi.fn();
    render(<TypeModels t={ds} onChanged={onChanged} toast={toast} />);
    const box = screen.getByTestId('type-models-tDS');
    expect(within(box).getAllByText('deepseek-v4-pro').some((el) => el.tagName === 'SPAN')).toBe(true);
    fireEvent.click(within(box).getByRole('button', { name: 'Refresh DeepSeek models' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith('tDS'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/DeepSeek: 2 models/)));
    const def = within(box).getByLabelText('DeepSeek default model') as HTMLSelectElement;
    expect(def.value).toBe('deepseek-flash');
    fireEvent.change(def, { target: { value: 'deepseek-v4-pro' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('tDS', { model: 'deepseek-v4-pro' }));
    const strong = within(box).getByLabelText('DeepSeek strong tier model') as HTMLSelectElement;
    expect(strong.value).toBe('deepseek-v4-pro');
    fireEvent.change(within(box).getByLabelText('DeepSeek cheap tier model'), { target: { value: 'deepseek-flash' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith('tDS', { tierModels: { cheap: 'deepseek-flash' } }));
  });

  it('the type\'s model mode is a Workspace / Auto / Fixed switch', async () => {
    const update = vi.spyOn(api, 'updateAgentType').mockResolvedValue(ds);
    render(<TypeModels t={ds} onChanged={async () => {}} toast={vi.fn()} />);
    const mode = screen.getByRole('radiogroup', { name: 'DeepSeek model mode' });
    expect(within(mode).getByRole('radio', { name: 'Workspace' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Fixed' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('tDS', { modelMode: 'fixed' }));
  });

  it('a type without a key asks for one in a password field; the key is sent once and never shown', async () => {
    const update = vi.spyOn(api, 'updateAgentType').mockResolvedValue(ds);
    const noKey = { ...ds, hasApiKey: false };
    const { container } = render(<TypeCard t={noKey} isDefault={false} keysInAccount={false} />);
    expect(screen.getByText('No API key')).toBeTruthy();
    const input = screen.getByLabelText('DeepSeek API key') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('tDS', { apiKey: 'sk-test-123' }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(container.textContent).not.toContain('sk-test-123');
  });

  it('a type with a key offers Replace key behind a button, and Make default', () => {
    render(<TypeCard t={ds} isDefault={false} keysInAccount={false} />);
    expect(screen.queryByLabelText('DeepSeek API key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    expect(screen.getByLabelText('DeepSeek API key')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make default' }));
    expect(fake.saveSettings).toHaveBeenCalledWith({ defaultAgentTypeId: 'tDS' });
  });

  it('a failed refresh says so and keeps the list', async () => {
    vi.spyOn(api, 'refreshAgentTypeModels').mockResolvedValue({ id: 'tDS', name: 'DeepSeek', provider: 'custom', default: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], tierModels: {}, fetchedAt: null, discoverable: true, ok: false, error: 'custom 401: bad key' });
    const toast = vi.fn();
    render(<TypeModels t={ds} onChanged={async () => {}} toast={toast} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DeepSeek models' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Could not fetch DeepSeek's models \(custom 401: bad key\); kept the configured list/)));
  });
});

describe('agent Settings › Model', () => {
  const agent = { id: 'a1', name: 'Ada', provider: 'custom', model: 'deepseek-flash', agentTypeId: 'tDS' } as unknown as Agent;

  it('offers the type\'s models with the default preselected, and saves a pick', async () => {
    const upd = vi.spyOn(api, 'updateAgent').mockResolvedValue(agent);
    render(<ModelCard a={agent} />);
    const sel = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(sel.value).toBe('deepseek-flash');
    expect([...sel.options].map((o) => o.value)).toEqual(['deepseek-flash', 'deepseek-v4-pro', '__custom']);
    expect(sel.options[0].textContent).toMatch(/\(default\)/);
    fireEvent.change(sel, { target: { value: 'deepseek-v4-pro' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(upd).toHaveBeenCalledWith('a1', { agentTypeId: 'tDS', model: 'deepseek-v4-pro', applyToChats: true }));
  });

  it('the custom model id escape hatch is marked and sends customModel', async () => {
    const upd = vi.spyOn(api, 'updateAgent').mockResolvedValue(agent);
    render(<ModelCard a={agent} />);
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '__custom' } });
    const input = screen.getByLabelText('Custom model id') as HTMLInputElement;
    expect(screen.getByText(/Custom: not in DeepSeek's list/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'ds-preview-0601' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(upd).toHaveBeenCalledWith('a1', { agentTypeId: 'tDS', model: 'ds-preview-0601', applyToChats: true, customModel: true }));
  });

  it('the model mode: Auto (by task complexity) saves modelMode, and says what it does', async () => {
    const upd = vi.spyOn(api, 'updateAgent').mockResolvedValue(agent);
    render(<ModelCard a={agent} />);
    const mode = screen.getByRole('radiogroup', { name: 'Model mode' });
    expect(within(mode).getByRole('radio', { name: 'Inherit' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(mode).getByRole('radio', { name: 'Auto' }));
    expect(screen.getByTestId('agent-model-mode-hint').textContent).toMatch(/cheap, standard or strong model/);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(upd).toHaveBeenCalledWith('a1', { agentTypeId: 'tDS', model: 'deepseek-flash', applyToChats: true, modelMode: 'auto' }));
  });

  it('an agent already on an unlisted model opens in custom mode', () => {
    render(<ModelCard a={{ ...agent, model: 'claude-opus-4-5' } as Agent} />);
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('__custom');
    expect((screen.getByLabelText('Custom model id') as HTMLInputElement).value).toBe('claude-opus-4-5');
  });
});

describe('Settings › Model selection', () => {
  const view = {
    selection: { order: [], crossProvider: true },
    policy: { cheapMaxScore: 1, strongMinScore: 6, floorTier: 0, ceilingTier: 2, riskFloorTier: 1, retryEscalateAfter: 1, budgetTightPct: 20, historyDowngradeRate: 0.9, historyEscalateRate: 0.5, historyMinRuns: 5, requestCap: 1 },
    types: [
      { id: 'tC', name: 'Claude', provider: 'anthropic', family: 'anthropic', hasApiKey: true, modelMode: '', tiers: { cheap: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', strong: 'claude-opus-5-5' } },
      { id: 'tO', name: 'OpenAI', provider: 'openai', family: 'openai', hasApiKey: true, modelMode: '', tiers: { cheap: 'gpt-6-luna', standard: 'gpt-6.1-sol', strong: 'gpt-6-astra' } },
    ],
  };

  it('shows the tier map per provider, saves the workspace mode and the preference order, and the outcomes per tier', async () => {
    vi.spyOn(api, 'modelSelection').mockResolvedValue(view);
    vi.spyOn(api, 'modelOutcomes').mockResolvedValue({ days: 30, tiers: [{ tier: 'cheap', runs: 4, succeeded: 3, failed: 1, reworked: 0, usd: 0.04, avgUsd: 0.01, turns: 2, successRate: 0.75 }, { tier: 'standard', runs: 0, succeeded: 0, failed: 0, reworked: 0, usd: 0, avgUsd: 0, turns: 0, successRate: null }, { tier: 'strong', runs: 0, succeeded: 0, failed: 0, reworked: 0, usd: 0, avgUsd: 0, turns: 0, successRate: null }] });
    const put = vi.spyOn(api, 'setModelSelection').mockResolvedValue(view);
    render(<ModelSelectionCard workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('model-selection-card')).toBeTruthy());
    expect(screen.getByTestId('model-order-tO').textContent).toMatch(/gpt-6-astra/);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Workspace model mode' })).getByRole('radio', { name: 'Auto' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('w1', { mode: 'auto' }));
    fireEvent.click(screen.getByLabelText('Prefer OpenAI'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('w1', { order: ['tO', 'tC'] }));
    await waitFor(() => expect(screen.getByTestId('model-outcomes').textContent).toMatch(/75%/));
    expect(screen.getByTestId('model-outcome-cheap').textContent).toMatch(/4 task runs/);
    expect(screen.getByTestId('model-outcome-cheap').textContent).toMatch(/\$0\.01 per run/);
    // the thresholds read as plain words behind Advanced, not as tunable strings
    const adv = screen.getByTestId('model-thresholds');
    expect((adv as HTMLDetailsElement).open).toBe(false);
    expect(adv.textContent).toMatch(/Use the cheap model.*when the work scores 1 or less/);
    expect(adv.textContent).toMatch(/Risky work.*never below standard/);
    expect(adv.textContent).not.toMatch(/cheapMaxScore/);
  });

  it('says so when nothing ran on Auto yet, and the cross-provider switch saves', async () => {
    vi.spyOn(api, 'modelSelection').mockResolvedValue(view);
    vi.spyOn(api, 'modelOutcomes').mockResolvedValue({ days: 30, tiers: [] });
    const put = vi.spyOn(api, 'setModelSelection').mockResolvedValue({ ...view, selection: { ...view.selection, crossProvider: false } });
    render(<ModelSelectionCard workspaceId="w1" />);
    await waitFor(() => expect(screen.getByText(/No auto runs yet/)).toBeTruthy());
    expect(screen.queryByTestId('model-outcomes')).toBeNull();
    const sw = screen.getByRole('switch', { name: 'Allow other providers' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(put).toHaveBeenCalledWith('w1', { crossProvider: false }));
  });

  it('a load failure says so and offers a retry', async () => {
    const get = vi.spyOn(api, 'modelSelection').mockRejectedValueOnce(new Error('500')).mockResolvedValue(view);
    vi.spyOn(api, 'modelOutcomes').mockResolvedValue({ days: 30, tiers: [] });
    render(<ModelSelectionCard workspaceId="w1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('model-selection-card')).toBeTruthy());
    expect(get).toHaveBeenCalledTimes(2);
  });
});
