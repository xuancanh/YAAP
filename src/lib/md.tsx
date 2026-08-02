/**
 * Minimal markdown renderer for agent dashboards and charters. Builds React
 * elements directly (no innerHTML), so untrusted agent output cannot inject
 * markup. Supports headings, lists, checkboxes, code fences, inline code,
 * bold/italic, links, and paragraphs — enough for a status board.
 */
import { memo, type ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // tokens: `code`, **bold**, *italic*, [text](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={key} style={{ fontFamily: 'var(--mono)', fontSize: '.92em', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 4, padding: '0 4px' }}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const link = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-hi)' }}>{link[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  const h = { 1: 19, 2: 16, 3: 14 } as Record<number, number>;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={key++} style={{ margin: '10px 0', padding: '12px 14px', background: 'var(--code)', border: '1px solid var(--border-soft)', borderRadius: 10, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6, overflowX: 'auto' }}>{buf.join('\n')}</pre>);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(<div key={key++} style={{ fontSize: h[level], fontWeight: 700, margin: `${level === 1 ? 4 : 14}px 0 4px`, letterSpacing: '-.2px' }}>{inline(heading[2], `h${key}`)}</div>);
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
        const check = /^\[([ xX])\]\s+(.*)$/.exec(item);
        items.push(
          <li key={items.length} style={{ margin: '3px 0' }}>
            {check ? (<><span style={{ marginRight: 6 }}>{check[1] === ' ' ? '☐' : '☑'}</span>{inline(check[2], `li${key}-${items.length}`)}</>) : inline(item, `li${key}-${items.length}`)}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={key++} style={{ margin: '6px 0', paddingLeft: 22 }}>{items}</ul>);
      continue;
    }

    blocks.push(<p key={key++} style={{ margin: '7px 0', lineHeight: 1.6 }}>{inline(line, `p${key}`)}</p>);
    i++;
  }

  return <div>{blocks}</div>;
});
