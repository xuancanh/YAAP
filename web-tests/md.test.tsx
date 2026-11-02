import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, parseChart, plainText } from '../src/lib/md';

describe('Markdown', () => {
  it('renders headings, bold, and inline code', () => {
    const { container } = render(<Markdown text={'# Status\nAll **green** with `code`'} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('green');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('renders resolved @mentions as chips — plain, bold or in backticks, as agents write them', () => {
    const mentions = (s: string) => (s.includes('@Tutor Lead') ? [{ start: s.indexOf('@Tutor Lead'), end: s.indexOf('@Tutor Lead') + 11, kind: 'agent' as const }] : []);
    const { container } = render(<Markdown text={'Ping @Tutor Lead now. **`@Tutor Lead`** again; @nobody stays text'} mentions={mentions} />);
    const chips = container.querySelectorAll('[data-mention]');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('@Tutor Lead');
    expect(chips[0].getAttribute('data-mention')).toBe('agent');
    expect(container.querySelector('code')).toBeNull();
    expect(container).toHaveTextContent('@nobody stays text');
  });

  it('renders https links as anchors', () => {
    const { container } = render(<Markdown text="see [docs](https://example.com/a)" />);
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('href', 'https://example.com/a');
    expect(a?.getAttribute('rel')).toContain('noreferrer');
    expect(a).toHaveTextContent('docs');
  });

  it('does not render javascript: URLs as hrefs or images (security)', () => {
    const { container } = render(<Markdown text={'click [me](javascript:alert(1)) now ![x](javascript:alert(2))'} />);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('click [me](javascript:alert(1)) now');
  });

  it('renders lists, nested lists, checkboxes and code fences', () => {
    const { container } = render(<Markdown text={'- one\n  - nested\n- [x] done\n- [ ] todo\n\n```ts\nconst x = 1;\n```'} />);
    expect(container.querySelectorAll('li')).toHaveLength(4);
    expect(container.querySelector('ul ul')).not.toBeNull();
    expect(container.querySelector('pre')).toHaveTextContent('const x = 1;');
    expect(container).toHaveTextContent('ts');
  });

  it('renders GFM tables with alignment', () => {
    const { container } = render(<Markdown text={'| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |'} />);
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(4);
    expect(container.querySelectorAll('th')[1]).toHaveStyle({ textAlign: 'right' });
  });

  it('renders block quotes and GitHub callouts', () => {
    const { container } = render(<Markdown text={'> plain quote\n\n> [!WARNING] Careful\n> body text'} />);
    expect(container.querySelector('blockquote')).toHaveTextContent('plain quote');
    expect(container.querySelector('[role="note"]')).toHaveTextContent('Careful');
    expect(container.querySelector('[role="note"]')).toHaveTextContent('body text');
  });

  it('renders rich components: chart, kv, steps, progress, details, callout', () => {
    const text = [
      '```chart', '{"type":"bar","title":"Spend","labels":["a","b"],"series":[{"name":"usd","values":[1,2]}]}', '```',
      '```kv', 'Owner: Scout', 'Due: Friday', '```',
      '```steps', 'Collect', 'Draft', '```',
      '```progress', 'Issue 1: 40', '```',
      '```details', 'More', 'hidden **text**', '```',
      '```callout', 'tip Shortcut', 'use /meeting', '```',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(container.querySelector('dl')).toHaveTextContent('Owner');
    expect(container.querySelector('ol')).toHaveTextContent('Draft');
    expect(container.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '40');
    expect(container.querySelector('details summary')).toHaveTextContent('More');
    expect(container.querySelector('[role="note"]')).toHaveTextContent('Shortcut');
    expect(container.querySelectorAll('pre')).toHaveLength(0);
  });

  it('falls back to a code block for an invalid chart and keeps unknown fences as code', () => {
    const { container } = render(<Markdown text={'```chart\nnot json\n```\n```mermaid\ngraph TD\n```'} />);
    expect(container.querySelectorAll('pre')).toHaveLength(2);
    expect(parseChart('{"series":[{"values":["x"]}]}')).toBeNull();
  });

  it('renders an unterminated fence while streaming as code', () => {
    const blocks = parseBlocks('text\n```js\nconst a =');
    expect(blocks[1]).toMatchObject({ t: 'code', lang: 'js', open: true });
    const { container } = render(<Markdown text={'hello\n```js\nconst a ='} streaming />);
    expect(container.querySelector('pre')).toHaveTextContent('const a =');
    expect(container).toHaveTextContent('▋');
  });

  it('copies code with the copy button', async () => {
    const writes: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: (s: string) => { writes.push(s); return Promise.resolve(); } } });
    const { container } = render(<Markdown text={'```\nabc\n```'} />);
    fireEvent.click(container.querySelector('button')!);
    expect(writes).toEqual(['abc']);
  });

  it('resolves reference chips through the resolver and leaves unknown refs as text', () => {
    const refs = (kind: string, id: string) => (id === 'g1' ? { label: `${kind} one` } : null);
    const { container } = render(<Markdown text="see #goal:g1 and #goal:zz" refs={refs} />);
    expect(container.querySelector('button')).toHaveTextContent('goal one');
    expect(container).toHaveTextContent('#goal:zz');
  });

  it('strips markdown to plain text for TTS', () => {
    expect(plainText('# Hi\n\nSome **bold** and [a link](https://x.y) and `code`\n\n```js\nx\n```')).toBe('Hi\nSome bold and a link and code');
  });
});
