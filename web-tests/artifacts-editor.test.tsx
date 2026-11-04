/** The Artifacts page and its editors (docs/filesystem.md "Rich display",
 *  "Editing"): the document view, task boxes that write back, read-only
 *  reasons, the CSV grid, autosave, the conflict flow, the Markdown editor's
 *  slash menu and round-trip, and new pages opening in the editor. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { ApiError, type FilePreview } from '../src/lib/api';
import type { FileSource } from '../src/lib/artifacts';

afterEach(cleanup);

const fake: Record<string, unknown> = {};
vi.mock('../src/store', () => ({ useApp: () => fake, grad: () => '', gradPair: () => ['#000', '#fff'] }));

const { DocView } = await import('../src/components/DocView');
const { CsvGrid } = await import('../src/components/CsvGrid');
const { FileEditor } = await import('../src/components/FileEditor');
const { ArtifactPane, readOnlyReason } = await import('../src/components/FilesView');
const { createFile, newPageText, takeFreshFile } = await import('../src/lib/artifacts');
const MarkdownEditor = (await import('../src/components/editor/MarkdownEditor')).default;
const { filterSlash } = await import('../src/components/editor/MarkdownEditor');

beforeEach(() => {
  for (const k of Object.keys(fake)) delete fake[k];
  Object.assign(fake, {
    me: { actorId: 'u1', role: 'owner' }, agents: [], stacked: false, showToast: vi.fn(),
    onWorkspaceEvent: () => () => undefined, openArtifact: vi.fn(),
  });
});

const conflict = () => new ApiError(409, JSON.stringify({ statusCode: 409, currentVersion: 5, updatedBy: { kind: 'agent', id: 'a1', name: 'Ada' } }));
const md = (text: string, version = 3): FilePreview => ({ path: 'org/plan.md', kind: 'markdown', size: text.length, contentType: 'text/markdown', text, version, updatedBy: { kind: 'agent', id: 'a1', name: 'Ada' } } as FilePreview);

function memSource(files: Record<string, FilePreview>, write = vi.fn()): FileSource & { write: ReturnType<typeof vi.fn> } {
  return {
    key: 'ws:test', workspaceId: 'w1',
    list: async () => [],
    preview: async (p) => { const f = files[p]; if (!f) throw new Error('404'); return f; },
    write,
    revisions: async () => [],
    fromWorkspacePath: (p) => p,
  } as FileSource & { write: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------- view

describe('the document view', () => {
  const DOC = [
    '---', 'owner: Ada', 'status: draft', '---', '',
    '# Q4 plan', '', 'Intro with `code` and a [link](https://example.com).', '',
    '<!-- hidden note -->', '',
    '## Goals', '', '- [ ] ship the editor', '- [x] write the brief', '',
    '## Table', '', '| Path | What |', '|---|---|', '| /org/operating-system.md | long-path cell |', '',
    '## Code', '', '```ts', 'const answer = 42; // the answer', '```', '',
    '> [!WARNING]', '> Mind the gap.', '',
    '## Later', '', 'text', '', '### Detail', '', 'more',
  ].join('\n');

  it('takes the title from the first H1, adds anchors, a table wrapper, highlighted code with a copy button, callouts, properties and an outline', () => {
    render(<DocView text={DOC} fallbackTitle="plan" meta={<div data-testid="meta">meta</div>} toc />);
    const view = screen.getByTestId('doc-view');
    const h1 = view.querySelector('h1')!;
    expect(h1).toHaveTextContent('Q4 plan');
    expect(h1.className).toContain('doc-h1-title');
    expect(screen.queryByText('plan')).toBeNull(); // no fallback title when the doc has an H1
    expect(view.querySelector('h2#goals .doc-anchor')).toHaveAttribute('href', '#goals');
    const wrap = view.querySelector('.doc-table-wrap')!;
    expect(within(wrap as HTMLElement).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Path', 'What']);
    expect(view.querySelector('.doc-code .tok-kw')).toHaveTextContent('const');
    expect(view.querySelector('.doc-code .tok-com')).toHaveTextContent('// the answer');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Warning');
    expect(view).not.toHaveTextContent('hidden note');
    expect(screen.getByLabelText('Properties')).toHaveTextContent('ownerAda');
    const toc = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(toc).getAllByRole('link').map((a) => a.textContent)).toEqual(['Goals', 'Table', 'Code', 'Later', 'Detail']);
  });

  it('uses the file name as the title when there is no H1; checkboxes report their source line', () => {
    const onToggle = vi.fn();
    render(<DocView text={DOC.replace('# Q4 plan', 'Plain start')} fallbackTitle="plan" onToggleTask={onToggle} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('plan');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([false, true]);
    fireEvent.click(boxes[0]);
    // line 13 of the file (front matter counted)
    expect(onToggle).toHaveBeenCalledWith(13, true);
    expect(DOC.split('\n')[13]).toBe('- [ ] ship the editor');
  });

  it('marks the Notes line of generated files', () => {
    render(<DocView text={'# Index\n\n<!-- notes: everything below this line is kept when the file is regenerated -->\n\nmine\n'} />);
    expect(screen.getByRole('separator')).toHaveTextContent('Notes');
  });
});

// ---------------------------------------------------------- the page

describe('the file page', () => {
  it('a task box writes back with the version check', async () => {
    const text = '# Plan\n\n- [ ] one\n- [ ] two\n';
    const write = vi.fn().mockResolvedValue({ version: 4 });
    const src = memSource({ 'org/plan.md': md(text) }, write);
    render(<ArtifactPane source={src} entries={[]} path="org/plan.md" onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" empty={null} />);
    const boxes = await screen.findAllByRole('checkbox');
    fireEvent.click(boxes[1]);
    await waitFor(() => expect(write).toHaveBeenCalledWith('org/plan.md', '# Plan\n\n- [ ] one\n- [x] two\n', 3));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[1]).toBeChecked());
    expect(screen.getByTestId('artifact-meta')).toHaveTextContent('v4');
  });

  it('a task box that meets a newer version reloads instead of overwriting', async () => {
    const write = vi.fn().mockRejectedValue(conflict());
    const src = memSource({ 'org/plan.md': md('- [ ] one\n') }, write);
    render(<ArtifactPane source={src} entries={[]} path="org/plan.md" onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" empty={null} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(fake.showToast).toHaveBeenCalledWith(expect.stringMatching(/saved this file meanwhile/)));
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('shows the header: breadcrumbs, meta, Edit and the actions menu', async () => {
    const src = memSource({ 'org/plan.md': md('# Plan\n\nBody\n') });
    render(<ArtifactPane source={src} entries={[]} path="org/plan.md" onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" onAttach={() => {}} empty={null} />);
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Plan');
    expect(screen.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveTextContent('Artifacts/org/plan.md');
    expect(screen.getByTestId('artifact-meta')).toHaveTextContent('Edited by Ada');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu');
    for (const label of ['History', 'Show source', 'Copy link', 'Attach to chat', 'Download']) expect(within(menu).getByRole('menuitem', { name: label })).toBeInTheDocument();
  });

  it('opens read-only with a reason: checkpoints, viewers, truncated files', async () => {
    expect(readOnlyReason('agents/ada/.checkpoints/1/x.md', 'markdown', md('x'), 'owner')).toMatch(/checkpoint/);
    expect(readOnlyReason('org/x.md', 'markdown', md('x'), 'viewer')).toMatch(/view this workspace/);
    expect(readOnlyReason('org/x.md', 'markdown', { ...md('x'), truncated: true }, 'owner')).toMatch(/Too large/);
    expect(readOnlyReason('org/x.md', 'markdown', md('x'), 'owner')).toBeNull();
    const src = memSource({ 'agents/ada/.checkpoints/1/x.md': md('- [ ] a\n') });
    render(<ArtifactPane source={src} entries={[]} path="agents/ada/.checkpoints/1/x.md" onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" empty={null} />);
    expect(await screen.findByRole('note')).toHaveTextContent(/checkpoint/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByTestId('artifact-meta')).toHaveTextContent('Read-only');
  });

  it('a wholly generated file says so and edits only on purpose', async () => {
    const text = '# Calendar\n\n_Generated from the cadences and kept current — edits are overwritten the next time it changes._\n';
    render(<ArtifactPane source={memSource({ 'org/calendar.md': md(text) })} entries={[]} path="org/calendar.md" onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" empty={null} />);
    expect(await screen.findByRole('note')).toHaveTextContent(/edits here are overwritten/);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit anyway' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- CSV

describe('the CSV grid', () => {
  it('edits a cell, adds a row and a column, deletes one, and saves CSV with the file\'s line endings', () => {
    let get: () => string = () => '';
    render(<CsvGrid text={'name,score\r\nada,10\r\n'} onChange={(g) => { get = g; }} />);
    const grid = screen.getByRole('grid');
    fireEvent.doubleClick(within(grid).getByText('10'));
    const input = screen.getByLabelText('Row 2, column 2');
    fireEvent.change(input, { target: { value: '11, sharp' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(get()).toBe('name,score\r\nada,"11, sharp"\r\n');
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    expect(get()).toBe('name,score\r\nada,"11, sharp"\r\n,\r\n');
    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(get().split('\r\n')[0]).toBe('name,score,');
    fireEvent.click(screen.getByRole('button', { name: 'Delete column' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    expect(get()).toBe('name,score\r\nada,"11, sharp"\r\n');
  });

  it('writes untouched rows back exactly as they were (quoting kept)', () => {
    let get: () => string = () => '';
    const text = 'id,text\n"P-01","no commas here"\nP-02, spaced ,\n"P-03","multi\nline"\n';
    render(<CsvGrid text={text} onChange={(g) => { get = g; }} />);
    fireEvent.doubleClick(within(screen.getByRole('grid')).getByText('P-02'));
    const input = screen.getByDisplayValue('P-02');
    fireEvent.change(input, { target: { value: 'P-2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(get()).toBe('id,text\n"P-01","no commas here"\nP-2, spaced ,\n"P-03","multi\nline"\n');
  });

  it('types into the active cell, moves with the keyboard and pastes a block from a spreadsheet', () => {
    let get: () => string = () => '';
    render(<CsvGrid text={'a,b\nv1,v2\n'} onChange={(g) => { get = g; }} />);
    const grid = screen.getByRole('grid');
    fireEvent.mouseDown(within(grid).getByText('v1'));
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Delete' });
    expect(get()).toBe('a,b\nv1,\n');
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    fireEvent.paste(grid, { clipboardData: { getData: () => 'x\ty\tz\np\tq\tr' } });
    expect(get()).toBe('a,b,\nx,y,z\np,q,r\n');
  });
});

// ------------------------------------------------- autosave and conflicts

describe('saving: autosave, the version check, conflicts', () => {
  const editCell = (from: string, to: string) => {
    fireEvent.doubleClick(within(screen.getByRole('grid')).getByText(from));
    const input = screen.getByDisplayValue(from);
    fireEvent.change(input, { target: { value: to } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('autosaves after a pause with the version it started from, once, and never writes an unchanged file', async () => {
    const save = vi.fn().mockResolvedValue({ version: 8 });
    const statuses: string[] = [];
    render(<FileEditor kind="csv" name="t.csv" text={'a\nv1\n'} version={7} save={save} load={vi.fn()} delay={30} onStatus={(s) => statuses.push(s)} />);
    editCell('v1', '2');
    editCell('2', '3');
    expect(statuses).toContain('unsaved');
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith('a\n3\n', 7);
    await waitFor(() => expect(statuses[statuses.length - 1]).toBe('saved'));
    // back to what was saved: nothing to write
    editCell('3', '4');
    editCell('4', '3');
    await new Promise((r) => setTimeout(r, 80));
    expect(save).toHaveBeenCalledTimes(1);
    // the next real change is checked against the new version
    editCell('3', '5');
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('a\n5\n', 8));
  });

  it('a newer version stops autosave and shows both sides; Take theirs loads it', async () => {
    const save = vi.fn().mockRejectedValueOnce(conflict());
    const load = vi.fn().mockResolvedValue({ text: 'a\ntheirs\n', version: 5, updatedBy: { kind: 'agent', id: 'a1', name: 'Ada' } });
    render(<FileEditor kind="csv" name="t.csv" text={'a\nbase\n'} version={4} save={save} load={load} delay={20} />);
    editCell('base', 'mine');
    const banner = await screen.findByTestId('conflict-banner');
    expect(save).toHaveBeenCalledWith('a\nmine\n', 4);
    expect(banner).toHaveTextContent('Ada');
    expect(banner).toHaveTextContent('version 5');
    const diff = within(banner).getByTestId('conflict-diff');
    expect(diff.querySelector('.del')).toHaveTextContent('theirs');
    expect(diff.querySelector('.add')).toHaveTextContent('mine');
    // no silent retry while the conflict is open
    await new Promise((r) => setTimeout(r, 60));
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(within(banner).getByRole('button', { name: 'Take theirs' }));
    await waitFor(() => expect(screen.queryByTestId('conflict-banner')).toBeNull());
    expect(within(screen.getByRole('grid')).getByText('theirs')).toBeInTheDocument();
    // the next save is checked against their version
    save.mockResolvedValueOnce({ version: 6 });
    editCell('theirs', 'merged');
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('a\nmerged\n', 5));
  });

  it('Keep mine writes my text over their version — explicitly', async () => {
    const save = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ version: 6 });
    const load = vi.fn().mockResolvedValue({ text: 'a\ntheirs\n', version: 5 });
    render(<FileEditor kind="csv" name="t.csv" text={'a\nbase\n'} version={4} save={save} load={load} delay={20} />);
    editCell('base', 'mine');
    const banner = await screen.findByTestId('conflict-banner');
    fireEvent.click(within(banner).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('a\nmine\n', 5));
    await waitFor(() => expect(screen.queryByTestId('conflict-banner')).toBeNull());
  });

  it('other errors say what happened and offer a retry', async () => {
    const save = vi.fn().mockRejectedValueOnce(new ApiError(500, 'boom')).mockResolvedValueOnce({ version: 2 });
    render(<FileEditor kind="csv" name="t.csv" text={'a\nb\n'} version={1} save={save} load={vi.fn()} delay={10} />);
    editCell('b', 'c');
    expect(await screen.findByRole('status')).toHaveTextContent('500 boom');
    expect(screen.queryByTestId('conflict-banner')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });
});

// -------------------------------------------------------- the Markdown editor

describe('the Markdown editor', () => {
  const mount = async (text: string) => {
    let ed: Editor | null = null;
    let toMd: () => string = () => '';
    let get: (() => string) | null = null;
    render(<MarkdownEditor text={text} onChange={(g) => { get = g; }} onReady={(e, f) => { ed = e; toMd = f; }} />);
    await waitFor(() => expect(ed).not.toBeNull());
    return { ed: ed! as Editor, toMd: () => toMd(), latest: () => get?.() };
  };

  it('opens a document and writes it back unchanged', async () => {
    const text = '# Plan\n\n- [ ] one\n- [x] two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<!-- keep me -->\n';
    const { toMd } = await mount(text);
    expect(screen.getByRole('textbox', { name: 'Document' })).toHaveTextContent('Plan');
    expect(toMd()).toBe(text);
  });

  it('`/` opens the block menu; typing filters it; Enter inserts the block', async () => {
    const { ed, latest } = await mount('Intro\n');
    act(() => { ed.commands.focus('end'); ed.commands.splitBlock(); ed.commands.insertContent('/'); });
    const menu = await screen.findByTestId('slash-menu');
    expect(within(menu).getAllByRole('option').length).toBeGreaterThan(8);
    act(() => { ed.commands.insertContent('tab'); });
    await waitFor(() => expect(within(screen.getByTestId('slash-menu')).getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Table')]));
    act(() => { ed.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await waitFor(() => expect(screen.queryByTestId('slash-menu')).toBeNull());
    expect(ed.isActive('table')).toBe(true);
    expect(latest()).toMatch(/^Intro\n\n\| {2}\| {2}\| {2}\|\n\|---\|---\|---\|\n/);
    // the table bar appears while the cursor is in a table
    expect(screen.getByRole('toolbar', { name: 'Table' })).toBeInTheDocument();
  });

  it('filters the slash items by name and keyword', () => {
    expect(filterSlash('todo').map((i) => i.id)).toEqual(['todo']);
    expect(filterSlash('check').map((i) => i.id)).toEqual(['todo']);
    expect(filterSlash('').length).toBeGreaterThan(10);
  });

  it('an edit re-serialises only the block it touched', async () => {
    const text = '* star bullet\n* kept as is\n\nPara _one_.\n\nPara two.\n';
    const { ed, latest } = await mount(text);
    // edit the last paragraph
    act(() => { ed.commands.focus('end'); ed.commands.insertContent(' More.'); });
    expect(latest()).toBe('* star bullet\n* kept as is\n\nPara _one_.\n\nPara two. More.\n');
  });

  it('a task checkbox toggles in the editor and in the Markdown', async () => {
    const { ed, latest } = await mount('- [ ] one\n');
    const box = screen.getByRole('textbox', { name: 'Document' }).querySelector('input[type="checkbox"]')!;
    fireEvent.click(box);
    await waitFor(() => expect(latest()).toBe('- [x] one\n'));
    expect(ed.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true);
  });
});

// ---------------------------------------------------------------- new pages

describe('new pages', () => {
  it('a new Markdown page gets its title, never overwrites an existing file, and opens in the editor', async () => {
    const write = vi.fn().mockResolvedValue({ version: 1 });
    const src = memSource({}, write);
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('launch-plan');
    const p = await createFile(src, 'org', vi.fn());
    expect(p).toBe('org/launch-plan.md');
    expect(write).toHaveBeenCalledWith('org/launch-plan.md', '# Launch plan\n\n', 0);
    expect(takeFreshFile(src.key, 'org/launch-plan.md')).toBe(true);
    expect(takeFreshFile(src.key, 'org/launch-plan.md')).toBe(false);
    expect(newPageText('x/data.csv')).toBe('');
    prompt.mockRestore();
  });

  it('the page opens a fresh file straight into the editor', async () => {
    const write = vi.fn().mockResolvedValue({ version: 1 });
    const files: Record<string, FilePreview> = {};
    const src = memSource(files, write);
    vi.spyOn(window, 'prompt').mockReturnValue('notes.md');
    const p = await createFile(src, '', vi.fn());
    files[p!] = md('# Notes\n\n', 1);
    render(<ArtifactPane source={src} entries={[]} path={p} onOpen={() => {}} onChanged={() => {}} rootLabel="Artifacts" empty={null} />);
    expect(await screen.findByTestId('markdown-editor', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByTestId('save-status')).toHaveTextContent('Saved');
  });
});
