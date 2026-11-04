/** The agent's Settings › Personality picker (docs/agent-writing.md
 *  "Personalities"): the catalog with the current pick and its description,
 *  a change saves through PATCH /agents/:id, "None" is a neutral voice, and
 *  the card says so when the workspace has personalities off. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Agent, type AgentPersonality } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));

const { PersonalityCard } = await import('../src/components/PersonalityCard');

const catalog: AgentPersonality[] = [
  { id: 'warm', name: 'Warm & encouraging', description: 'Notices good work, says thanks.', prompt: 'warm', example: 'Nice work on the draft.' },
  { id: 'dry', name: 'Dry & matter-of-fact', description: 'Few words, understated, a little deadpan.', prompt: 'dry', example: 'It is always a typo.' },
];
const agent = { id: 'a1', name: 'Ada', personality: 'dry' } as unknown as Agent;

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { settings: {}, showToast: vi.fn(), refreshAgents: vi.fn(async () => {}) });
  vi.spyOn(api, 'agentPersonalities').mockResolvedValue(catalog);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('agent Settings › Personality', () => {
  it('shows the current personality with its description and example, plus None', async () => {
    render(<PersonalityCard a={agent} />);
    const sel = screen.getByLabelText('Personality') as HTMLSelectElement;
    await waitFor(() => expect([...sel.options].map((o) => o.value)).toEqual(['warm', 'dry', 'none']));
    expect(sel.value).toBe('dry');
    expect(screen.getByTestId('personality-description').textContent).toMatch(/Few words, understated.*It is always a typo/);
  });

  it('saves a new pick and None', async () => {
    const upd = vi.spyOn(api, 'updateAgent').mockResolvedValue(agent);
    render(<PersonalityCard a={agent} />);
    const sel = screen.getByLabelText('Personality') as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: 'warm' } });
    await waitFor(() => expect(upd).toHaveBeenCalledWith('a1', { personality: 'warm' }));
    expect(screen.getByTestId('personality-description').textContent).toMatch(/Notices good work/);
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith('Ada is now warm & encouraging'));
    fireEvent.change(sel, { target: { value: 'none' } });
    await waitFor(() => expect(upd).toHaveBeenCalledWith('a1', { personality: 'none' }));
    expect(screen.getByTestId('personality-description').textContent).toMatch(/neutral voice/);
  });

  it('reverts and says why when the save fails', async () => {
    vi.spyOn(api, 'updateAgent').mockRejectedValue(new Error('personality must be one of: warm, dry, none'));
    render(<PersonalityCard a={agent} />);
    const sel = screen.getByLabelText('Personality') as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: 'warm' } });
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith('personality must be one of: warm, dry, none'));
    expect(sel.value).toBe('dry');
  });

  it('notes when the workspace has personalities off', async () => {
    fake.settings = { agentPersonalities: 'off' };
    render(<PersonalityCard a={agent} />);
    expect(screen.getByText(/Personalities are off for this workspace/)).toBeTruthy();
  });
});
