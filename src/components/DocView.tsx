/** A Markdown file as a document (docs/filesystem.md "Rich display"): the
 *  chat renderer's parser and inline rules (src/lib/md.tsx), drawn with the
 *  reading styles in src/styles/doc.css — the first H1 as the page title,
 *  heading anchors, quotes as callouts, tables that scroll instead of
 *  breaking words, highlighted code with a copy button, task checkboxes that
 *  write back, front matter as properties, and an outline for long docs. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { inline, parseBlocks, richBlock, type Block, type Ctx } from '../lib/md';
import { Highlighted } from '../lib/highlight';
import { NOTES_MARKER, splitFrontMatter } from '../lib/markdownText';

const RICH = new Set(['chart', 'kv', 'steps', 'progress', 'details', 'callout']);
const CALLOUT: Record<string, string> = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution', danger: 'Danger' };

export const slugify = (s: string): string => s.toLowerCase().replace(/[`*_~[\]()<>#!]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'section';

/** Heading ids, unique in document order (`plan`, `plan-1`, …). */
function headingIds(blocks: Block[]): Map<Block, string> {
  const seen = new Map<string, number>();
  const ids = new Map<Block, string>();
  for (const b of blocks) {
    if (b.t !== 'h') continue;
    const base = slugify(b.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    ids.set(b, n ? `${base}-${n}` : base);
  }
  return ids;
}

function CodeBox({ lang, body }: { lang: string; body: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); };
  return (
    <div className="doc-code">
      <div className="doc-code-head"><span>{lang || 'text'}</span><button type="button" onClick={copy} aria-label="Copy code">{copied ? 'Copied' : 'Copy'}</button></div>
      <pre><code><Highlighted code={body} lang={lang} /></code></pre>
    </div>
  );
}

function FrontMatter({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(1, -1);
  const rows = lines.map((l) => /^([\w.-]+):\s*(.*)$/.exec(l));
  if (rows.some((r) => !r)) return <CodeBox lang="yaml" body={lines.join('\n')} />;
  return (
    <dl className="doc-props" aria-label="Properties">
      {rows.map((r, i) => <div key={i} style={{ display: 'contents' }}><dt>{r![1]}</dt><dd>{r![2] || '—'}</dd></div>)}
    </dl>
  );
}

export interface DocViewProps {
  text: string;
  /** Shown as the title when the document has no leading H1. */
  fallbackTitle?: string;
  /** Between the title and the body (the page's meta line). */
  meta?: ReactNode;
  /** Toggle the task on source line `line` (absolute, 0-based). */
  onToggleTask?: (line: number, checked: boolean) => void;
  /** Show "On this page" for documents with enough headings. */
  toc?: boolean;
  /** Narrow surfaces (the side panel). */
  compact?: boolean;
  /** Above everything in the column (notices, conflict banners). */
  top?: ReactNode;
}

export function DocView({ text, fallbackTitle, meta, onToggleTask, toc, compact, top }: DocViewProps) {
  const { front, body } = useMemo(() => splitFrontMatter(text), [text]);
  const offset = useMemo(() => (front ? front.replace(/\r\n/g, '\n').split('\n').length - 1 : 0), [front]);
  const blocks = useMemo(() => parseBlocks(body), [body]);
  const ids = useMemo(() => headingIds(blocks), [blocks]);
  const titled = blocks[0]?.t === 'h' && blocks[0].level === 1;
  const ctx: Ctx = {};
  const outline = blocks.filter((b): b is Extract<Block, { t: 'h' }> => b.t === 'h' && (b.level === 2 || b.level === 3));
  const showToc = !!toc && !compact && outline.length >= 4;
  const [active, setActive] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // scrollspy: the last heading above the fold
  useEffect(() => {
    if (!showToc || typeof IntersectionObserver === 'undefined' || !mainRef.current) return;
    const els = [...mainRef.current.querySelectorAll<HTMLElement>('h2[id],h3[id]')];
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '0px 0px -70% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [showToc, blocks]);

  const jump = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    const el = mainRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    try { history.replaceState(history.state, '', `#${id}`); } catch { /* sandboxed */ }
    setActive(id);
  };

  const renderList = (b: Extract<Block, { t: 'list' }>, key: string, live: boolean): ReactNode => {
    const Tag = b.ordered ? 'ol' : 'ul';
    const tasks = b.items.some((it) => it.check !== null);
    return (
      <Tag key={key} start={b.ordered && b.start !== 1 ? b.start : undefined} className={tasks && !b.ordered ? 'task' : undefined}>
        {b.items.map((it, i) => {
          const kids = it.children.map((c, ci) => render(c, `${key}-${i}-${ci}`, live));
          if (it.check === null) return <li key={i}>{inline(it.text, `${key}-${i}`, ctx)}{kids}</li>;
          const can = live && !!onToggleTask;
          return (
            <li key={i} className={it.check ? 'done' : undefined}>
              <input type="checkbox" className="doc-check" checked={it.check} disabled={!can} aria-label={it.text}
                onChange={(e) => onToggleTask?.(it.line + offset, e.target.checked)} />
              <div className="task-body">{inline(it.text, `${key}-${i}`, ctx)}{kids}</div>
            </li>
          );
        })}
      </Tag>
    );
  };

  /** `live`: source lines are this document's (not a re-parsed quote). */
  function render(b: Block, key: string, live: boolean, first = false): ReactNode {
    switch (b.t) {
      case 'h': {
        const id = live ? ids.get(b) : undefined;
        const H = `h${Math.min(6, b.level)}` as 'h1';
        return (
          <H key={key} id={id} className={first && b.level === 1 ? 'doc-h1-title' : undefined}>
            {id && !first && <a className="doc-anchor" href={`#${id}`} aria-label="Link to this section" onClick={jump(id)}>#</a>}
            {inline(b.text, `${key}h`, ctx)}
          </H>
        );
      }
      case 'p': return <p key={key}>{b.lines.flatMap((l, i) => [i ? <br key={`${key}br${i}`} /> : null, ...inline(l, `${key}l${i}`, ctx)])}</p>;
      case 'list': return renderList(b, key, live);
      case 'hr': return <hr key={key} />;
      case 'comment':
        return b.text.trim() === NOTES_MARKER ? <div key={key} className="doc-notes-rule" role="separator">Notes — kept when the server regenerates this file</div> : null;
      case 'quote': {
        const m = /^\[!(\w+)\]\s*(.*)$/.exec(b.lines[0] ?? '');
        const inner = parseBlocks((m ? b.lines.slice(1) : b.lines).join('\n'));
        if (m) {
          const kind = m[1].toLowerCase();
          return (
            <div key={key} role="note" className={`doc-callout ${kind}`}>
              <div className="doc-callout-title">{m[2] || CALLOUT[kind] || m[1]}</div>
              {inner.map((c, i) => render(c, `${key}q${i}`, false))}
            </div>
          );
        }
        return <blockquote key={key}>{inner.map((c, i) => render(c, `${key}q${i}`, false))}</blockquote>;
      }
      case 'table': return (
        <div key={key} className="doc-table-wrap" tabIndex={0} role="region" aria-label="Table">
          <table>
            <thead><tr>{b.head.map((c, i) => <th key={i} style={b.align[i] ? { textAlign: b.align[i]! } : undefined}>{inline(c, `${key}th${i}`, ctx)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{b.head.map((_, ci) => <td key={ci} style={b.align[ci] ? { textAlign: b.align[ci]! } : undefined}>{inline(r[ci] ?? '', `${key}td${ri}-${ci}`, ctx)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      case 'code': return RICH.has(b.lang) ? <div key={key}>{richBlock(b, key, ctx)}</div> : <CodeBox key={key} lang={b.lang} body={b.body} />;
    }
  }

  return (
    <div className={`doc-page${compact ? ' doc-compact' : ''}`} data-testid="doc-view">
      <div className={`doc-cols${showToc ? ' has-toc' : ''}`}>
        <div className="doc-main" ref={mainRef}>
          {top}
          {meta}
          {!titled && fallbackTitle && <h1 className="doc-title">{fallbackTitle}</h1>}
          <div className="doc-prose md">
            {titled && render(blocks[0], 'b0', true, true)}
            {front && <FrontMatter text={front} />}
            {blocks.slice(titled ? 1 : 0).map((b, i) => render(b, `b${i + (titled ? 1 : 0)}`, true))}
          </div>
        </div>
        {showToc && (
          <nav className="doc-toc" aria-label="On this page">
            <div className="doc-toc-title">On this page</div>
            {outline.map((h) => { const id = ids.get(h)!; return <a key={id} href={`#${id}`} className={`l${h.level}${active === id ? ' on' : ''}`} onClick={jump(id)}>{h.text.replace(/[`*_]/g, '')}</a>; })}
          </nav>
        )}
      </div>
    </div>
  );
}
