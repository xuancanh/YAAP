import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/lib/md';

describe('Markdown', () => {
  it('renders headings, bold, and inline code', () => {
    const { container } = render(<Markdown text={'# Status\nAll **green** with `code`'} />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('green');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('renders https links as anchors', () => {
    const { container } = render(<Markdown text="see [docs](https://example.com/a)" />);
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('href', 'https://example.com/a');
    expect(a).toHaveAttribute('rel', 'noreferrer');
    expect(a).toHaveTextContent('docs');
  });

  it('does not render javascript: URLs as hrefs (security)', () => {
    const { container } = render(<Markdown text="click [me](javascript:alert(1)) now" />);
    // The inline tokenizer only accepts https?:// links, so the payload must
    // stay literal text and no anchor may be created.
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('click [me](javascript:alert(1)) now');
  });

  it('renders lists and code fences', () => {
    const { container } = render(<Markdown text={'- one\n- two\n\n```\nconst x = 1;\n```'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('pre')).toHaveTextContent('const x = 1;');
  });
});
