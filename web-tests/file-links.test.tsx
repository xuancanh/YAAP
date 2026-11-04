/** Workspace file paths in Markdown (src/lib/file-links.ts): a path an agent
 *  writes — bare, in backticks or as a link target — renders as a link that
 *  asks the app to show the file in the side panel. */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from '../src/lib/md';
import { FILE_EVENT, filePathOf, type FileEventDetail } from '../src/lib/file-links';

afterEach(cleanup);

const opened: string[] = [];
window.addEventListener(FILE_EVENT, (e) => { opened.push((e as CustomEvent<FileEventDetail>).detail.path); });

describe('filePathOf', () => {
  it('accepts files under the workspace roots, with or without the leading slash', () => {
    expect(filePathOf('/org/marketing/waitlist/GO-LIVE.md')).toBe('org/marketing/waitlist/GO-LIVE.md');
    expect(filePathOf('agents/ada/work/draft.csv')).toBe('agents/ada/work/draft.csv');
    expect(filePathOf('/channels/eng/sub/sync/notes.txt')).toBe('channels/eng/sub/sync/notes.txt');
  });
  it('refuses folders, other roots, traversal and app routes', () => {
    expect(filePathOf('/org/marketing/')).toBeNull();
    expect(filePathOf('/etc/passwd.txt')).toBeNull();
    expect(filePathOf('/org/../secrets.md')).toBeNull();
    expect(filePathOf('/real-jong-cad9a8/home')).toBeNull();
  });
});

describe('Markdown file links', () => {
  it('links a bare path, a backticked path and a link target; trailing punctuation stays text', () => {
    const { container } = render(<Markdown text={'Ready: /org/marketing/waitlist/GO-LIVE.md. See `org/briefs/2026-11-04.md` and [the plan](/org/planning/2026-Q4.md).'} />);
    const links = [...container.querySelectorAll('a[data-file]')].map((a) => a.getAttribute('data-file'));
    expect(links).toEqual(['org/marketing/waitlist/GO-LIVE.md', 'org/briefs/2026-11-04.md', 'org/planning/2026-Q4.md']);
    expect(container.textContent).toContain('GO-LIVE.md. See');
    expect(container.querySelector('a[data-file="org/planning/2026-Q4.md"]')!.textContent).toBe('the plan');
  });
  it('clicking a path asks the app to open it in the side panel', () => {
    const { container } = render(<Markdown text="Wrote /agents/ada/work/draft.md for review" />);
    fireEvent.click(container.querySelector('a[data-file]')!);
    expect(opened.at(-1)).toBe('agents/ada/work/draft.md');
  });
  it('leaves URLs, app routes and plain code alone', () => {
    const { container } = render(<Markdown text={'https://x.io/org/a.md and [home](/real-jong-cad9a8/home) and `npm test`'} />);
    expect(container.querySelectorAll('a[data-file]').length).toBe(0);
  });
});
