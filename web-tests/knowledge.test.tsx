/** The knowledge base in the SPA (docs/knowledge-base.md): Foundry's hire
 *  review shows "Knowledge base · N docs" with the titles and shared topics;
 *  the agent page's card lists the role's docs and opens each one's
 *  read-only /library/ file in the side panel, installing first. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type AgentKnowledge } from '../src/lib/api';
import { FILE_EVENT, filePathOf, type FileEventDetail } from '../src/lib/file-links';
import { AgentKnowledgeCard, KnowledgeHireSection } from '../src/components/KnowledgeBits';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const opened: string[] = [];
window.addEventListener(FILE_EVENT, (e) => { opened.push((e as CustomEvent<FileEventDetail>).detail.path); });

describe('Foundry hire review', () => {
  it('shows the knowledge base with its doc count, titles and shared topics', () => {
    render(<KnowledgeHireSection item={{ name: 'Head of Finance', knowledge: { folder: 'biz-finance-manager', docs: 2, titles: ['Budget memo', 'Cash forecast'], shared: ['okrs', 'planning-and-estimation'], version: 'abc' } }} />);
    expect(screen.getByText('Knowledge base · 2 docs')).toBeTruthy();
    expect(screen.getByText('Budget memo')).toBeTruthy();
    expect(screen.getByText('Cash forecast')).toBeTruthy();
    expect(screen.getByText('planning and estimation')).toBeTruthy();
    expect(screen.getByTestId('hire-knowledge').textContent).toContain('/library/biz-finance-manager/');
  });
  it('renders nothing for a pack without one', () => {
    const { container } = render(<KnowledgeHireSection item={{ name: 'Trip Planner' }} />);
    expect(container.innerHTML).toBe('');
  });
});

const KB: AgentKnowledge = {
  packId: 'pack-biz-finance-manager', packName: 'Head of Finance', folder: 'biz-finance-manager', summary: 'Finance reference: budgets, runway, the close.', version: 'x',
  docs: [
    { path: 'biz-finance-manager/README.md', file: '/library/biz-finance-manager/README.md', title: 'Finance KB', summary: 'Overview.' },
    { path: 'biz-finance-manager/budget-memo.md', file: '/library/biz-finance-manager/budget-memo.md', title: 'Budget memo', summary: 'Ask for budget.' },
  ],
  shared: [{ topic: 'okrs', docs: [{ path: '_shared/okrs/writing-key-results.md', file: '/library/_shared/okrs/writing-key-results.md', title: 'Writing key results', summary: 'KRs.' }] }],
};

describe('the agent page: Knowledge base card', () => {
  it('lists the role\'s docs and opens one in Artifacts after making sure it is installed', async () => {
    vi.spyOn(api, 'agentKnowledge').mockResolvedValue(KB);
    const install = vi.spyOn(api, 'installAgentKnowledge').mockResolvedValue({ written: [], removed: [] });
    render(<AgentKnowledgeCard agentId="a1" />);
    await screen.findByText('Budget memo');
    expect(screen.getByText(/1 doc · Head of Finance/)).toBeTruthy();
    expect(screen.queryByText('Finance KB')).toBeNull();
    expect(screen.getByText(/Shared topics: okrs/)).toBeTruthy();
    fireEvent.click(screen.getByText('Budget memo'));
    await waitFor(() => expect(opened.at(-1)).toBe('library/biz-finance-manager/budget-memo.md'));
    expect(install).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Open in Artifacts'));
    await waitFor(() => expect(opened.at(-1)).toBe('library/biz-finance-manager/README.md'));
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('renders nothing when the agent has no knowledge base', async () => {
    const get = vi.spyOn(api, 'agentKnowledge').mockResolvedValue({ ...KB, packId: null, packName: null, folder: null, summary: '', docs: [], shared: [] });
    const { container } = render(<AgentKnowledgeCard agentId="a2" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
  it('a /library/ path in chat is a file link', () => {
    expect(filePathOf('/library/_shared/okrs/writing-key-results.md')).toBe('library/_shared/okrs/writing-key-results.md');
  });
});
