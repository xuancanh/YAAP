import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// No `globals: true` in vitest.config.ts, so RTL does not auto-clean between tests.
afterEach(cleanup);
import { ApiError, type Agent, type FileEntry } from '../src/lib/api';
import { buildTree, groupTree, isConflict, parseConflict, parseDelimited, viewKind, compareCells, ownerOf, ORG_ORDER } from '../src/lib/artifacts';
import { ORG_ORDER as SERVER_ORG_ORDER } from '../server/src/files/layout';
import { CsvTable, FileEditor, JsonTree } from '../src/components/ArtifactViewer';
import { ArtifactTree } from '../src/components/ArtifactTree';

const agent = (id: string, name: string, homeDir: string | null, emoji = '🤖'): Agent =>
  ({ id, name, homeDir, emoji, colors: '["#111","#222"]' }) as unknown as Agent;
const entry = (path: string): FileEntry => ({ path, size: 10 });

describe('parseDelimited', () => {
  it('handles quotes, doubled quotes, embedded separators and newlines, CRLF', () => {
    expect(parseDelimited('a,b\r\n"x, y","say ""hi"""\n"multi\nline",3\n')).toEqual([
      ['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '3'],
    ]);
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('compares numbers numerically and puts blanks last', () => {
    expect(['10', '9', '', '100'].sort(compareCells)).toEqual(['9', '10', '100', '']);
  });
});

describe('CsvTable', () => {
  const csv = 'name,score\nada,10\nbob,9\ncy,100\n';
  const column = (i: number) => within(screen.getByTestId('csv-table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[i].textContent);

  it('renders the header and rows, and sorts a column asc → desc → original', () => {
    render(<CsvTable text={csv} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.replace(/[▲▼↕]/g, ''))).toEqual(['name', 'score']);
    expect(column(1)).toEqual(['10', '9', '100']);
    const score = screen.getByRole('button', { name: /score/ });
    fireEvent.click(score);
    expect(column(1)).toEqual(['9', '10', '100']);
    expect(screen.getAllByRole('columnheader')[1]).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(score);
    expect(column(1)).toEqual(['100', '10', '9']);
    fireEvent.click(score);
    expect(column(1)).toEqual(['10', '9', '100']);
  });

  it('caps rows and says so', () => {
    const big = ['n', ...Array.from({ length: 30 }, (_, i) => String(i))].join('\n');
    render(<CsvTable text={big} maxRows={5} />);
    expect(within(screen.getByTestId('csv-table')).getAllByRole('row')).toHaveLength(6);
    expect(screen.getByText(/Showing the first 5 of 30 rows/)).toBeInTheDocument();
  });

  it('reads TSV with a tab separator', () => {
    render(<CsvTable text={'a\tb\n1\t2'} sep={'\t'} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });
});

describe('JsonTree', () => {
  it('renders nested values and collapses / expands nodes', () => {
    render(<JsonTree text={JSON.stringify({ team: { lead: 'Ada', size: 3 }, tags: ['a', 'b'] })} openDepth={1} />);
    const tree = screen.getByTestId('json-tree');
    // depth 0 open, depth 1 collapsed
    expect(tree).toHaveTextContent('"team"');
    expect(tree).not.toHaveTextContent('"Ada"');
    expect(tree).toHaveTextContent('2 keys');
    const team = screen.getAllByRole('button').find((b) => b.textContent?.includes('"team"'))!;
    expect(team).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(team);
    expect(team).toHaveAttribute('aria-expanded', 'true');
    expect(tree).toHaveTextContent('"Ada"');
    expect(tree).toHaveTextContent('3');
    fireEvent.click(team);
    expect(tree).not.toHaveTextContent('"Ada"');
  });

  it('falls back to the source when the JSON does not parse', () => {
    render(<JsonTree text="{ nope" />);
    expect(screen.queryByTestId('json-tree')).toBeNull();
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
  });
});

describe('viewKind', () => {
  it('picks the viewer from the preview kind, then the extension', () => {
    expect(viewKind('a.md', { kind: 'text', contentType: 'text/plain' })).toBe('markdown');
    expect(viewKind('a.csv', { kind: 'text', contentType: 'text/plain' })).toBe('csv');
    expect(viewKind('a.tsv', { kind: 'text', contentType: 'text/plain' })).toBe('tsv');
    expect(viewKind('a.json', { kind: 'text', contentType: 'application/json' })).toBe('json');
    expect(viewKind('a.ts', { kind: 'text', contentType: 'text/plain' })).toBe('code');
    expect(viewKind('notes.txt', { kind: 'text', contentType: 'text/plain' })).toBe('text');
    expect(viewKind('x.png', { kind: 'image', contentType: 'image/png' })).toBe('image');
    expect(viewKind('x.html', { kind: 'html', contentType: 'text/html' })).toBe('html');
  });
});

describe('tree grouping', () => {
  const agents = [agent('a1', 'Ada', 'agents/ada', '🦊'), agent('a2', 'Bob', 'agents/bob')];
  const entries = [
    entry('README.md'),
    entry('org/plan.md'),
    entry('org/notes/q3.md'),
    entry('channels/general/log.md'),
    entry('agents/ada/LESSONS.md'),
    entry('agents/ada/knowledge/x.md'),
    entry('agents/ghost/JOURNAL.md'),
    entry('reports/.keep'),
  ];

  it('builds folders first and hides .keep markers but keeps their folder', () => {
    const t = buildTree(entries);
    expect(t.map((n) => n.name)).toEqual(['agents', 'channels', 'org', 'reports', 'README.md']);
    expect(t.find((n) => n.name === 'reports')!.children).toEqual([]);
    expect(buildTree(entries, 'agents/ada').map((n) => n.path)).toEqual(['agents/ada/knowledge', 'agents/ada/LESSONS.md']);
  });

  it('splits Shared (everything outside agents/, plus root files) from Agents (homes by homeDir)', () => {
    const g = groupTree(buildTree(entries), agents);
    expect(g.shared.map((n) => n.path)).toEqual(['org', 'channels', 'reports', 'README.md']); // /org/ leads
    expect(g.agents.map((h) => [h.node.path, h.agent?.id ?? null, h.label])).toEqual([
      ['agents/ada', 'a1', 'Ada'],
      ['agents/ghost', null, 'ghost'],
    ]);
    expect(ownerOf('agents/ada/LESSONS.md', agents)?.name).toBe('Ada');
    expect(ownerOf('org/plan.md', agents)).toBeNull();
  });

  it('renders the two groups, agent homes with their names, and opens files', () => {
    const onOpen = vi.fn();
    render(<ArtifactTree entries={entries} agents={agents} grouped selected={null} onOpen={onOpen} />);
    const shared = screen.getByTestId('artifact-shared');
    const homes = screen.getByTestId('artifact-agents');
    expect(shared).toHaveTextContent('org/');
    expect(shared).toHaveTextContent('README.md');
    expect(shared).not.toHaveTextContent('agents');
    expect(homes).toHaveTextContent('Ada');
    expect(homes).toHaveTextContent('🦊');
    expect(homes).toHaveTextContent('ghost');
    expect(homes).not.toHaveTextContent('Bob'); // no home folder listed
    fireEvent.click(within(shared).getByText('README.md'));
    expect(onOpen).toHaveBeenCalledWith('README.md');
    // folders are collapsible
    expect(within(shared).queryByText('plan.md')).toBeNull();
    fireEvent.click(within(shared).getByText('org/'));
    expect(within(shared).getByText('plan.md')).toBeInTheDocument();
    // the group itself collapses
    fireEvent.click(screen.getByTestId('artifact-group-agents'));
    expect(screen.queryByTestId('artifact-agents')).toBeNull();
  });

  it('expands the ancestors of the selected file', () => {
    render(<ArtifactTree entries={entries} agents={agents} grouped selected="org/notes/q3.md" onOpen={() => {}} />);
    expect(screen.getByText('q3.md')).toBeInTheDocument();
  });
});

describe('the /org/ folder (docs/filesystem.md "Layout")', () => {
  const agents = [agent('a1', 'Ada', 'agents/ada')];
  const entries = [
    'org/sales/cadence.md', 'org/zz-notes.md', 'org/metrics.md', 'org/playbooks/x.md', 'org/customer/README.md', 'org/goals/README.md',
    'org/decisions.md', 'org/calendar.md', 'org/meetings/company/2026/2026-11-02-standup.md', 'org/README.md', 'org/operating-system.md',
    'org/reports/2026-W45.md', 'org/loose/a.md', 'channels/general/x.md',
  ].map(entry);

  it('shows /org/ children in the layout order: the index, how the company runs, goals and rhythm, the ledger, functions, mirrors, then anything else', () => {
    const org = buildTree(entries).find((n) => n.path === 'org')!;
    expect(org.children.map((n) => n.name)).toEqual([
      'README.md', 'operating-system.md', 'calendar.md', 'goals', 'meetings', 'reports', 'decisions.md', 'sales', 'customer', 'playbooks', 'metrics.md', 'loose', 'zz-notes.md',
    ]);
    // the same order when the tree is rooted at /org/; other folders keep folders-first, alphabetical
    expect(buildTree(entries, 'org').map((n) => n.name).slice(0, 3)).toEqual(['README.md', 'operating-system.md', 'calendar.md']);
  });

  it('mirrors the server layout\'s order', () => {
    expect([...ORG_ORDER]).toEqual([...SERVER_ORG_ORDER]);
  });

  it('pins /org/README.md at the top of Shared and opens it', () => {
    expect(groupTree(buildTree(entries), agents).pinned.map((n) => n.path)).toEqual(['org/README.md']);
    expect(groupTree(buildTree([entry('org/plan.md')]), agents).pinned).toEqual([]);
    const onOpen = vi.fn();
    render(<ArtifactTree entries={entries} agents={agents} grouped selected={null} onOpen={onOpen} />);
    const pin = screen.getByTestId('artifact-pinned');
    expect(pin).toHaveTextContent('org/README.md');
    fireEvent.click(within(pin).getByText('org/README.md'));
    expect(onOpen).toHaveBeenCalledWith('org/README.md');
  });
});

describe('FileEditor version conflict', () => {
  const conflict = () => new ApiError(409, JSON.stringify({ statusCode: 409, message: 'version conflict', currentVersion: 5, updatedBy: { kind: 'agent', id: 'a1', name: 'Ada' } }));

  it('parses the 409 body', () => {
    expect(isConflict(conflict())).toBe(true);
    expect(isConflict(new ApiError(500, 'x'))).toBe(false);
    expect(parseConflict(conflict())).toEqual({ version: 5, by: 'Ada' });
    expect(parseConflict(new ApiError(409, 'not json'))).toEqual({});
  });

  it('sends expectedVersion, shows the banner on 409, Reload takes theirs', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(conflict());
    const onReload = vi.fn().mockResolvedValue({ text: 'their text', version: 5 });
    render(<FileEditor text="v4 text" version={4} onSave={onSave} onReload={onReload} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'my text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByTestId('conflict-banner');
    expect(onSave).toHaveBeenCalledWith('my text', 4);
    expect(banner).toHaveTextContent('Ada');
    expect(banner).toHaveTextContent('version 5');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.queryByTestId('conflict-banner')).toBeNull());
    expect(screen.getByLabelText('File contents')).toHaveValue('their text');
    // the next save is checked against the reloaded version
    onSave.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('their text', 5));
  });

  it('Overwrite writes my text without the version check', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(undefined);
    render(<FileEditor text="base" version={2} onSave={onSave} onReload={vi.fn()} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const banner = await screen.findByTestId('conflict-banner');
    fireEvent.click(within(banner).getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith('mine', undefined));
    await waitFor(() => expect(screen.queryByTestId('conflict-banner')).toBeNull());
  });

  it('shows other errors without the conflict banner', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom'));
    render(<FileEditor text="x" onSave={onSave} onReload={vi.fn()} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status')).toHaveTextContent('500 boom');
    expect(screen.queryByTestId('conflict-banner')).toBeNull();
  });
});
