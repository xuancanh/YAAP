/** Declarative plugin UI (docs/plugins.md §3.8): cards and pages on a
 *  section dashboard and panels on a task render the server's view with the
 *  app's own components; an action asks the server, shows the policy
 *  stage's confirmation (class, requirement) and runs only on Confirm; a
 *  refusal (two keys) is shown, never retried; a contribution waiting on a
 *  provider says so. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type PluginUiItem } from '../src/lib/api';

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake }));
const { PluginCards, PluginPanels, PluginView } = await import('../src/components/PluginUi');

const item = (over: Partial<PluginUiItem> & Pick<PluginUiItem, 'id' | 'kind' | 'key'>): PluginUiItem => ({ pluginId: 'crm@yaam', version: '1.0.0', ready: true, waitingOn: [], spec: {}, ...over });
const CARD = item({ id: 'c1', kind: 'card', key: 'pipeline', spec: { title: 'Pipeline', placement: 'money', actions: ['log-call', 'send'] } });
const PAGE = item({ id: 'p1', kind: 'page', key: 'deals', spec: { title: 'Deals', placement: 'money', summary: 'Every open deal.', sections: [{ title: 'Open deals' }] } });
const WAITING = item({ id: 'c2', kind: 'card', key: 'cash', pluginId: 'accounting@yaam', ready: false, waitingOn: ['accounting'], spec: { title: 'Cash', placement: 'money' } });
const LOG = item({ id: 'a1', kind: 'action', key: 'log-call', spec: { title: 'Log a call', operation: 'crm.log_activity', fields: [{ key: 'dealId', label: 'Deal id', type: 'text', required: true }, { key: 'note', label: 'What was said', type: 'textarea', required: true }] } });
const SEND = item({ id: 'a2', kind: 'action', key: 'send', spec: { title: 'Send', operation: 'campaigns.send_campaign', fields: [] } });

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, { workspaceId: 'ws1', showToast: vi.fn() });
  vi.spyOn(api, 'pluginUi').mockImplementation(async (_ws, placement) => (placement === 'task'
    ? { items: [item({ id: 't1', kind: 'panel', key: 'related-articles', pluginId: 'kb@yaam', spec: { title: 'Related articles', placement: 'task' } })], actions: [] }
    : { items: [CARD, PAGE, WAITING], actions: [LOG, SEND] }));
  vi.spyOn(api, 'pluginUiData').mockImplementation(async (_ws, id) => {
    if (id === 'c1') return { view: { kind: 'stats', items: [{ label: 'Open deals', value: '9', tone: 'neutral' }, { label: 'Pipeline', value: '184000', unit: 'USD', tone: 'neutral' }] } };
    if (id === 'p1') return { view: { kind: 'table', columns: ['Deal', 'Stage'], rows: [['Annual plan', 'negotiation']], more: 0 } };
    return { view: { kind: 'list', items: [{ title: 'Exporting invoices', subtitle: 'Reports, then Export', link: 'https://help.example/kb-12' }], more: 0 } };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('plugin UI', () => {
  it('a section dashboard renders plugin cards from the server view, names the plugin, lists pages, and says what a card waits on', async () => {
    render(<PluginCards placement="money" />);
    const card = await screen.findByTestId('plugin-card-pipeline');
    expect(card).toHaveTextContent('crm@yaam');
    await waitFor(() => expect(within(card).getAllByTestId('plugin-stat').map((s) => s.textContent)).toEqual(['9Open deals', '184000USDPipeline']));
    expect(screen.getByTestId('plugin-card-cash')).toHaveTextContent('Waiting on a accounting provider.');
    expect(api.pluginUiData).not.toHaveBeenCalledWith('ws1', 'c2', expect.anything());
    // A page opens in place with its sections.
    fireEvent.click(screen.getByTestId('plugin-page-link-deals'));
    const page = await screen.findByTestId('plugin-page-deals');
    expect(page).toHaveTextContent('Every open deal.');
    expect(await within(page).findByRole('cell', { name: 'negotiation' })).toBeInTheDocument();
  });

  it('an action collects its fields, shows the confirmation the policy stage asks for, and runs only on Confirm', async () => {
    const invoke = vi.spyOn(api, 'pluginUiInvoke')
      .mockResolvedValueOnce({ status: 'confirm', class: 'external_reversible', requirement: 'trust', reasons: [], prompt: 'Log this call in the CRM?' })
      .mockResolvedValueOnce({ status: 'done', class: 'external_reversible', output: { id: 'act-1' } });
    render(<PluginCards placement="money" />);
    const action = await screen.findByTestId('plugin-action-log-call');
    fireEvent.click(within(action).getByRole('button', { name: 'Log a call' }));
    fireEvent.change(within(action).getByRole('textbox', { name: 'Deal id' }), { target: { value: 'D-7' } });
    fireEvent.change(within(action).getByRole('textbox', { name: 'What was said' }), { target: { value: 'Renewal' } });
    fireEvent.click(within(action).getByRole('button', { name: 'Log a call' }));
    const confirm = await within(action).findByTestId('plugin-action-confirm');
    expect(confirm).toHaveTextContent('Log this call in the CRM?');
    expect(confirm).toHaveTextContent('Classed external, reversible');
    expect(invoke).toHaveBeenLastCalledWith('ws1', 'a1', { fields: { dealId: 'D-7', note: 'Renewal' }, confirm: false });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('ws1', 'a1', { fields: { dealId: 'D-7', note: 'Renewal' }, confirm: true }));
    expect(await within(action).findByRole('status')).toHaveTextContent('Done.');
    expect(fake.showToast).toHaveBeenCalledWith('Log a call: done');
  });

  it('a refusal from the policy stage is shown, not retried', async () => {
    const invoke = vi.spyOn(api, 'pluginUiInvoke').mockRejectedValue(new Error('{"message":"campaigns.send_campaign needs two keys; ask an agent to propose it"}'));
    render(<PluginCards placement="money" />);
    const action = await screen.findByTestId('plugin-action-send');
    fireEvent.click(within(action).getByRole('button', { name: 'Send' }));
    expect(await within(action).findByRole('status')).toHaveTextContent('needs two keys; ask an agent to propose it');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('a task panel passes the task context to its query and renders safe links', async () => {
    render(<PluginPanels placement="task" context={{ taskKey: 'ENG-1', taskTitle: 'Export invoices' }} />);
    const panel = await screen.findByTestId('plugin-panel-related-articles');
    const link = await within(panel).findByRole('link', { name: 'Exporting invoices' });
    expect(link).toHaveAttribute('href', 'https://help.example/kb-12');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
    expect(api.pluginUiData).toHaveBeenCalledWith('ws1', 't1', { section: 0, context: { taskKey: 'ENG-1', taskTitle: 'Export invoices' } });
  });

  it('renders nothing when no plugin adds to the placement; checklists render as lists', async () => {
    vi.spyOn(api, 'pluginUi').mockResolvedValue({ items: [], actions: [] });
    const { container } = render(<PluginCards placement="people" />);
    await waitFor(() => expect(api.pluginUi).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    render(<PluginView view={{ kind: 'checklist', items: ['Liability is capped', 'No exclusivity'] }} />);
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Liability is capped', 'No exclusivity']);
  });
});
