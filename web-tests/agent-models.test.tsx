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

const { TypeModels } = await import('../src/components/SettingsView');
const { ModelCard } = await import('../src/components/AgentsView');

const ds: AgentType = {
  id: 'tDS', name: 'DeepSeek', provider: 'custom', model: 'deepseek-flash', models: JSON.stringify(['deepseek-flash', 'deepseek-v4-pro']),
  modelsFetchedAt: null, tierModels: JSON.stringify({ strong: 'deepseek-v4-pro' }), baseUrl: 'https://api.deepseek.com/v1', persona: '', enabled: 1, hasApiKey: true,
};

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    agentTypes: [ds], settings: { defaultAgentTypeId: 'tDS' }, showToast: vi.fn(),
    refreshAgents: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}), refreshAgentTypes: vi.fn(async () => {}),
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

  it('an agent already on an unlisted model opens in custom mode', () => {
    render(<ModelCard a={{ ...agent, model: 'claude-opus-4-5' } as Agent} />);
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('__custom');
    expect((screen.getByLabelText('Custom model id') as HTMLInputElement).value).toBe('claude-opus-4-5');
  });
});
