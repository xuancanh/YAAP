/**
 * Markdown renderer for chat replies, channel posts, dashboards and charters.
 *
 * Builds React elements directly (never innerHTML), so untrusted agent output
 * cannot inject markup. Links are limited to http(s)/mailto, images to
 * http(s)/data:image. Block level: ATX headings 1–6, paragraphs with soft
 * breaks, ordered/unordered lists with nesting and task checkboxes, block
 * quotes with GitHub callouts (`> [!NOTE]`), fenced code with a language
 * label and copy button, GFM tables with alignment, horizontal rules, images,
 * and "rich components": fenced blocks whose language is a component name.
 *
 *   ```chart          {"type":"bar"|"line","title":"…","labels":[…],
 *                      "series":[{"name":"…","values":[…]}]}        → inline SVG
 *   ```kv             key: value lines                              → definition grid
 *   ```steps          one step per line                             → numbered timeline
 *   ```callout        first line: kind (note|tip|warning|danger) [title] → callout
 *   ```details        first line: summary; rest: markdown           → collapsible
 *   ```progress       label: 0-100 per line                          → progress bars
 *
 * Unknown languages render as code. An unterminated fence (a reply still
 * streaming) renders the remainder as code so the layout never jumps.
 *
 * Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), autolinked
 * URLs, ![alt](src), and `#goal:`/`#decision:`/`#task:`/`#meeting:`/`#audit:`
 * reference chips when a `refs` resolver is given (and bare task keys like
 * `ENG-12`, docs/tasks-keys.md, when it knows the key); resolved `@mentions` as
 * chips when a `mentions` finder is given (a code span that is exactly one
 * mention included — agents often write `` `@Name` ``).
 */
import { memo, useState, type CSSProperties, type ReactNode } from 'react';
import { appHref, navigate, parseRoute } from './routes';
import { FILE_PATH_SOURCE, filePathOf, openFileInPanel } from './file-links';
import { Highlighted } from './highlight';

export type RefKind = 'goal' | 'decision' | 'task' | 'meeting' | 'audit';
/** `bare` is set for a task key written without `#task:` (ENG-12): the
 *  resolver answers only for keys it knows, so GPT-4 or UTF-8 stay text. */
export type RefResolver = (kind: RefKind, id: string, bare?: boolean) => { label: string; onClick?: () => void } | null;

/** Finds the resolved `@mentions` in a run of plain text (group chat): each
 *  span is drawn as a chip. */
export type MentionFinder = (text: string) => Array<{ start: number; end: number; kind: 'agent' | 'human' }>;

export interface Ctx { refs?: RefResolver; compact?: boolean; mentions?: MentionFinder }

const mentionStyle: CSSProperties = { display: 'inline', background: 'var(--accent-dim)', color: 'var(--accent-hi)', borderRadius: 4, padding: '0 3px', fontWeight: 600 };

/** Plain text with its resolved `@mentions` as chips. */
function withMentions(text: string, key: string, ctx: Ctx): ReactNode[] {
  const spans = ctx.mentions && text.includes('@') ? ctx.mentions(text) : [];
  if (spans.length === 0) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  spans.forEach((s, j) => {
    if (s.start < last) return;
    if (s.start > last) out.push(text.slice(last, s.start));
    out.push(<span key={`${key}-at${j}`} data-mention={s.kind} style={mentionStyle}>{text.slice(s.start, s.end)}</span>);
    last = s.end;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
/** A link into the app itself — `/<company>/…` or an older `#/ws/…` /
 *  `#/chat/…` link agents wrote (meeting minutes, notifications) — as its
 *  address (docs/routes.md); it opens in place, not in a new tab. */
function appLink(raw: string): string | null {
  if (!raw.startsWith('/') && !raw.startsWith('#/')) return null;
  return appHref(raw, typeof window === 'undefined' ? null : parseRoute(window.location.pathname)?.company ?? null);
}
const SAFE_IMG = /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|svg\+xml);)/i;

// ---------- inline ----------

const INLINE_RE = new RegExp([
  '(`[^`\\n]+`)',                                   // 1 code
  '(\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)',              // 2 bold
  '(\\*[^*\\n]+\\*|\\b_[^_\\n]+_\\b)',                // 3 italic
  '(~~[^~\\n]+~~)',                                  // 4 strike
  '(!\\[[^\\]]*\\]\\([^)\\s]+\\))',                   // 5 image
  '(\\[[^\\]\\n]+\\]\\([^)\\s]+\\))',                 // 6 link
  '(https?:\\/\\/[^\\s<>()\\[\\]"\']+[^\\s<>()\\[\\]"\'.,;:!?])', // 7 bare url
  '(#(?:goal|decision|task|meeting|audit):[A-Za-z0-9_-]+)', // 8 ref chip
  '((?<![\\w-])[A-Z][A-Z0-9]{1,5}-\\d{1,7}(?![\\w-]))', // 9 bare task key (ENG-12)
  `(${FILE_PATH_SOURCE})`,                           // 10 workspace file path (/org/…/x.md)
].join('|'), 'g');

const fileLinkStyle: CSSProperties = { color: 'var(--accent-hi)', textDecoration: 'underline', textDecorationColor: 'var(--accent-dim)', textUnderlineOffset: 2, cursor: 'pointer', wordBreak: 'break-all' };

/** A workspace file path drawn as a link that opens it in the side panel. */
function fileLink(key: string, path: string, label: ReactNode, code = false): ReactNode {
  const open = (e: { preventDefault: () => void }) => { e.preventDefault(); openFileInPanel(path); };
  return (
    <a key={key} href={`#file:/${path}`} data-file={path} title={`Open /${path}`} onClick={open} style={code ? { ...codeStyle, ...fileLinkStyle } : fileLinkStyle}>{label}</a>
  );
}

/** The glyph before a reference chip (goal, decision, task; a meeting or an audit row cited by ask-the-company). */
export const REF_GLYPH: Record<RefKind, string> = { goal: '◎', decision: '⚖', task: '☐', meeting: '🗓', audit: '#' };

const codeStyle: CSSProperties = { fontFamily: 'var(--mono)', fontSize: '.9em', background: 'var(--panel-2)', border: '1px solid var(--border-soft)', borderRadius: 4, padding: '0 4px' };

export function inline(text: string, keyBase: string, ctx: Ctx = {}): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0; let i = 0; let m: RegExpExecArray | null;
  // A fresh regex per call: `inline` recurses for bold/italic/links, and a
  // shared global regex would have its lastIndex reset mid-loop.
  const re = new RegExp(INLINE_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...withMentions(text.slice(last, m.index), `${keyBase}-t${i}`, ctx));
    const tok = m[0]; const key = `${keyBase}-${i++}`;
    if (m[1]) {
      // `@Name` in backticks is how agents often write a tag: a code span
      // that is exactly one resolved mention renders as its chip.
      const body = tok.slice(1, -1);
      const only = ctx.mentions && body.startsWith('@') ? ctx.mentions(body) : [];
      const file = filePathOf(body);
      if (only.length === 1 && only[0].start === 0 && only[0].end === body.length) out.push(...withMentions(body, key, ctx));
      else if (file) out.push(fileLink(key, file, body, true));
      else out.push(<code key={key} style={codeStyle}>{body}</code>);
    }
    else if (m[2]) out.push(<strong key={key}>{inline(tok.slice(2, -2), key, ctx)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(tok.slice(1, -1), key, ctx)}</em>);
    else if (m[4]) out.push(<s key={key} style={{ color: 'var(--text-dim)' }}>{inline(tok.slice(2, -2), key, ctx)}</s>);
    else if (m[5]) {
      const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(tok)!;
      if (SAFE_IMG.test(img[2])) out.push(<img key={key} src={img[2]} alt={img[1]} loading="lazy" style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border-soft)', display: 'block', margin: '6px 0' }} />);
      else out.push(tok);
    } else if (m[6]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const file = SAFE_LINK.test(link[2]) ? null : filePathOf(link[2]);
      const inApp = SAFE_LINK.test(link[2]) || file ? null : appLink(link[2]);
      if (file) out.push(fileLink(key, file, inline(link[1], key, ctx)));
      else if (inApp) out.push(<a key={key} href={inApp} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(inApp); }} style={{ color: 'var(--accent-hi)' }}>{inline(link[1], key, ctx)}</a>);
      else if (SAFE_LINK.test(link[2])) out.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent-hi)' }}>{inline(link[1], key, ctx)}</a>);
      else out.push(tok);
    } else if (m[7]) out.push(<a key={key} href={tok} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--accent-hi)', wordBreak: 'break-all' }}>{tok}</a>);
    else if (m[8] || m[9]) {
      const [, kind, id] = m[9] ? [tok, 'task', tok] : /^#(goal|decision|task|meeting|audit):(.+)$/.exec(tok)!;
      const r = ctx.refs?.(kind as RefKind, id, !!m[9]);
      if (r) out.push(<button key={key} type="button" data-ref={kind} onClick={r.onClick} title={`${kind} ${id}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--accent-dim)', color: 'var(--accent-hi)', border: 'none', borderRadius: 999, padding: '0 8px', fontSize: '.85em', fontWeight: 600, cursor: r.onClick ? 'pointer' : 'default', verticalAlign: 'baseline' }}>{REF_GLYPH[kind as RefKind]} {r.label}</button>);
      else out.push(...withMentions(tok, `${key}-t`, ctx));
    } else if (m[10]) out.push(fileLink(key, filePathOf(tok)!, tok));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(...withMentions(text.slice(last), `${keyBase}-t${i}`, ctx));
  return out;
}

/** Soft line breaks inside a paragraph become <br/>; hard wrap like chat. */
function para(lines: string[], key: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((l, i) => { if (i) out.push(<br key={`${key}-br${i}`} />); out.push(...inline(l, `${key}-l${i}`, ctx)); });
  return out;
}

// ---------- block parsing ----------

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; lines: string[] }
  | { t: 'code'; lang: string; body: string; open: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'table'; align: Array<'left' | 'center' | 'right' | null>; head: string[]; rows: string[][] }
  | { t: 'hr' }
  /** An HTML comment (`<!-- … -->`): not shown, kept in the source. */
  | { t: 'comment'; text: string };
/** `line`: the item's source line (0-based) — what a task toggle rewrites. */
export interface ListItem { text: string; check: boolean | null; children: Block[]; line: number }

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.trimStart().startsWith('<!--')) {
      const buf: string[] = [];
      while (i < lines.length) { buf.push(lines[i]); if (lines[i++].includes('-->')) break; }
      blocks.push({ t: 'comment', text: buf.join('\n') });
      continue;
    }

    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1]; const buf: string[] = []; i++;
      let open = true;
      while (i < lines.length) { if (lines[i].trimStart().startsWith(close)) { open = false; i++; break; } buf.push(lines[i++]); }
      blocks.push({ t: 'code', lang: fence[2].toLowerCase(), body: buf.join('\n'), open });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { blocks.push({ t: 'h', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (HR_RE.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', lines: buf });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ t: 'table', align, head, rows });
      continue;
    }

    const li = LIST_RE.exec(line);
    if (li) { const [list, next] = parseList(lines, i, li[1].length); blocks.push(list); i = next; continue; }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !lines[i].trimStart().startsWith('>') && !lines[i].trimStart().startsWith('<!--') && !LIST_RE.test(lines[i]) && !HR_RE.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]))) buf.push(lines[i++]);
    if (buf.length) blocks.push({ t: 'p', lines: buf });
    else i++;
  }
  return blocks;
}

function parseList(lines: string[], start: number, indent: number): [Block, number] {
  const first = LIST_RE.exec(lines[start])!;
  const ordered = /\d/.test(first[2]);
  const list: Block = { t: 'list', ordered, start: ordered ? parseInt(first[2], 10) || 1 : 1, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length < indent) break;
    if (m[1].length > indent) { // nested list belongs to the previous item
      const last = list.items[list.items.length - 1];
      const [child, next] = parseList(lines, i, m[1].length);
      if (last) last.children.push(child); else list.items.push({ text: '', check: null, children: [child], line: i });
      i = next; continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    let text = m[3]; let check: boolean | null = null;
    const c = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (c) { check = c[1] !== ' '; text = c[2]; }
    const item: ListItem = { text, check, children: [], line: i };
    i++;
    // continuation lines (indented, not list markers, not blank)
    while (i < lines.length && lines[i].trim() && !LIST_RE.test(lines[i]) && /^\s{2,}/.test(lines[i])) item.text += ' ' + lines[i++].trim();
    list.items.push(item);
    // a blank line followed by a deeper-indented list still belongs here
    if (i < lines.length && !lines[i].trim() && i + 1 < lines.length) { const n = LIST_RE.exec(lines[i + 1]); if (n && n[1].length > indent) i++; }
  }
  return [list, i];
}

// ---------- rich components ----------

const KINDS: Record<string, { color: string; icon: string; label: string }> = {
  note: { color: 'var(--blue)', icon: 'ℹ', label: 'Note' },
  tip: { color: 'var(--green)', icon: '✓', label: 'Tip' },
  important: { color: 'var(--accent)', icon: '★', label: 'Important' },
  warning: { color: 'var(--amber)', icon: '⚠', label: 'Warning' },
  caution: { color: 'var(--red)', icon: '⛔', label: 'Caution' },
  danger: { color: 'var(--red)', icon: '⛔', label: 'Danger' },
};

export function Callout({ kind, title, children }: { kind: string; title?: string; children: ReactNode }) {
  const k = KINDS[kind] ?? KINDS.note;
  return (
    <div role="note" style={{ margin: '10px 0', borderLeft: `3px solid ${k.color}`, background: 'var(--panel)', borderRadius: '0 10px 10px 0', padding: '9px 13px' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: k.color, marginBottom: 3 }}>{k.icon} {title || k.label}</div>
      <div style={{ fontSize: '.97em' }}>{children}</div>
    </div>
  );
}

export function CodeBlock({ lang, body, open }: { lang: string; body: string; open: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); };
  return (
    <div style={{ margin: '10px 0', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--code)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px 4px 12px', borderBottom: '1px solid var(--border-soft)', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>
        <span>{lang || 'text'}{open ? ' · …' : ''}</span>
        <button type="button" onClick={copy} style={{ background: 'none', border: 'none', color: copied ? 'var(--green)' : 'var(--text-faint)', cursor: 'pointer', fontSize: 11, padding: '2px 4px' }}>{copied ? 'copied' : 'copy'}</button>
      </div>
      <pre style={{ margin: 0, padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6, overflowX: 'auto', whiteSpace: 'pre' }}><Highlighted code={body} lang={lang} /></pre>
    </div>
  );
}

interface ChartSpec { type?: 'bar' | 'line'; title?: string; labels?: string[]; series?: Array<{ name?: string; values: number[] }>; unit?: string }
const PALETTE = ['var(--accent)', 'var(--blue)', 'var(--green)', 'var(--amber)', 'var(--red)'];

export function parseChart(body: string): ChartSpec | null {
  try {
    const v = JSON.parse(body) as ChartSpec;
    if (!v || !Array.isArray(v.series) || v.series.length === 0) return null;
    if (!v.series.every((s) => Array.isArray(s.values) && s.values.every((n) => typeof n === 'number' && Number.isFinite(n)))) return null;
    return { type: v.type === 'line' ? 'line' : 'bar', title: typeof v.title === 'string' ? v.title : '', labels: Array.isArray(v.labels) ? v.labels.map(String) : [], series: v.series.slice(0, 5), unit: typeof v.unit === 'string' ? v.unit : '' };
  } catch { return null; }
}

function Chart({ spec }: { spec: ChartSpec }) {
  const W = 520; const H = 200; const padL = 36; const padB = 26; const padT = 10; const padR = 8;
  const series = spec.series!; const n = Math.max(...series.map((s) => s.values.length));
  const max = Math.max(0, ...series.flatMap((s) => s.values)); const min = Math.min(0, ...series.flatMap((s) => s.values));
  const range = max - min || 1;
  const y = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / range);
  const x = (i: number) => padL + ((W - padL - padR) / Math.max(n, 1)) * (i + 0.5);
  const ticks = [min, min + range / 2, max];
  const labels = spec.labels ?? [];
  return (
    <figure style={{ margin: '10px 0', padding: '10px 12px 6px', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel)' }}>
      {spec.title && <figcaption style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={spec.title || 'chart'} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border-soft)" />
            <text x={padL - 6} y={y(t) + 3} fontSize="9" textAnchor="end" fill="var(--text-faint)">{fmtNum(t)}{spec.unit}</text>
          </g>
        ))}
        {spec.type === 'line'
          ? series.map((s, si) => (
            <g key={si}>
              <polyline fill="none" stroke={PALETTE[si % PALETTE.length]} strokeWidth={2} points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
              {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={PALETTE[si % PALETTE.length]}><title>{`${s.name ?? ''} ${labels[i] ?? i}: ${v}${spec.unit ?? ''}`}</title></circle>)}
            </g>
          ))
          : series.map((s, si) => {
            const bw = ((W - padL - padR) / Math.max(n, 1)) / (series.length + 1);
            return s.values.map((v, i) => (
              <rect key={`${si}-${i}`} x={x(i) - (bw * series.length) / 2 + bw * si} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(v) - y(0))} rx={2} fill={PALETTE[si % PALETTE.length]}>
                <title>{`${s.name ?? ''} ${labels[i] ?? i}: ${v}${spec.unit ?? ''}`}</title>
              </rect>
            ));
          })}
        {labels.slice(0, n).map((l, i) => <text key={i} x={x(i)} y={H - 8} fontSize="9" textAnchor="middle" fill="var(--text-dim)">{String(l).slice(0, 12)}</text>)}
      </svg>
      {series.length > 1 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4, fontSize: 11, color: 'var(--text-dim)' }}>
          {series.map((s, i) => <span key={i}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: PALETTE[i % PALETTE.length], marginRight: 5 }} />{s.name ?? `Series ${i + 1}`}</span>)}
        </div>
      )}
    </figure>
  );
}
const fmtNum = (n: number) => (Math.abs(n) >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 100) / 100));

function KeyValues({ body, ctx }: { body: string; ctx: Ctx }) {
  const rows = body.split('\n').map((l) => /^\s*([^:]+?)\s*:\s*(.*)$/.exec(l)).filter(Boolean) as RegExpExecArray[];
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', margin: '10px 0', padding: '10px 12px', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel)', fontSize: '.95em' }}>
      {rows.map((r, i) => (<><dt key={`k${i}`} style={{ color: 'var(--text-dim)', fontWeight: 600 }}>{r[1]}</dt><dd key={`v${i}`} style={{ margin: 0 }}>{inline(r[2], `kv${i}`, ctx)}</dd></>))}
    </dl>
  );
}

function Steps({ body, ctx }: { body: string; ctx: Ctx }) {
  const steps = body.split('\n').map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim()).filter(Boolean);
  return (
    <ol style={{ listStyle: 'none', margin: '10px 0', padding: 0 }}>
      {steps.map((s, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, padding: '4px 0', position: 'relative' }}>
          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent-dim)', color: 'var(--accent-hi)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', marginTop: 1 }}>{i + 1}</span>
          <span style={{ lineHeight: 1.55 }}>{inline(s, `st${i}`, ctx)}</span>
        </li>
      ))}
    </ol>
  );
}

function Progress({ body }: { body: string }) {
  const rows = body.split('\n').map((l) => /^\s*(.+?)\s*:\s*(\d{1,3})\s*%?\s*$/.exec(l)).filter(Boolean) as RegExpExecArray[];
  return (
    <div style={{ margin: '10px 0', display: 'grid', gap: 6 }}>
      {rows.map((r, i) => { const v = Math.max(0, Math.min(100, parseInt(r[2], 10))); return (
        <div key={i} style={{ fontSize: '.93em' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)', marginBottom: 2 }}><span>{r[1]}</span><span style={{ fontFamily: 'var(--mono)' }}>{v}%</span></div>
          <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={r[1]} style={{ height: 6, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}><div style={{ width: `${v}%`, height: '100%', background: v >= 100 ? 'var(--green)' : 'var(--accent)' }} /></div>
        </div>); })}
    </div>
  );
}

function Details({ body, ctx }: { body: string; ctx: Ctx }) {
  const nl = body.indexOf('\n');
  const summary = (nl === -1 ? body : body.slice(0, nl)).trim() || 'Details';
  const rest = nl === -1 ? '' : body.slice(nl + 1);
  return (
    <details style={{ margin: '10px 0', border: '1px solid var(--border-soft)', borderRadius: 10, background: 'var(--panel)', padding: '8px 12px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '.95em' }}>{inline(summary, 'dsum', ctx)}</summary>
      <div style={{ marginTop: 6 }}>{renderBlocks(parseBlocks(rest), 'd', ctx)}</div>
    </details>
  );
}

export function richBlock(b: Extract<Block, { t: 'code' }>, key: string, ctx: Ctx): ReactNode {
  switch (b.lang) {
    case 'chart': { const spec = parseChart(b.body); return spec ? <Chart key={key} spec={spec} /> : <CodeBlock key={key} lang="chart" body={b.body} open={b.open} />; }
    case 'kv': return <KeyValues key={key} body={b.body} ctx={ctx} />;
    case 'steps': return <Steps key={key} body={b.body} ctx={ctx} />;
    case 'progress': return <Progress key={key} body={b.body} />;
    case 'details': return <Details key={key} body={b.body} ctx={ctx} />;
    case 'callout': {
      const nl = b.body.indexOf('\n'); const head = (nl === -1 ? b.body : b.body.slice(0, nl)).trim();
      const parsed = /^(\w+)\s*(.*)$/.exec(head);
      const kind = parsed?.[1] ?? 'note'; const title = parsed ? parsed[2] : head;
      return <Callout key={key} kind={(kind || 'note').toLowerCase()} title={title}>{renderBlocks(parseBlocks(nl === -1 ? '' : b.body.slice(nl + 1)), `${key}c`, ctx)}</Callout>;
    }
    default: return <CodeBlock key={key} lang={b.lang} body={b.body} open={b.open} />;
  }
}

// ---------- rendering ----------

const H_SIZE: Record<number, number> = { 1: 20, 2: 17, 3: 15, 4: 14, 5: 13.5, 6: 13 };

function renderList(b: Extract<Block, { t: 'list' }>, key: string, ctx: Ctx): ReactNode {
  const Tag = b.ordered ? 'ol' : 'ul';
  const hasChecks = b.items.some((it) => it.check !== null);
  return (
    <Tag key={key} start={b.ordered ? b.start : undefined} style={{ margin: '6px 0', paddingLeft: hasChecks ? 4 : 22, listStyle: hasChecks ? 'none' : undefined }}>
      {b.items.map((it, i) => (
        <li key={i} style={{ margin: '3px 0', lineHeight: 1.55 }}>
          {it.check !== null && <span aria-hidden style={{ marginRight: 7, color: it.check ? 'var(--green)' : 'var(--text-faint)' }}>{it.check ? '☑' : '☐'}</span>}
          <span style={it.check ? { color: 'var(--text-dim)', textDecoration: 'line-through' } : undefined}>{inline(it.text, `${key}-${i}`, ctx)}</span>
          {it.children.map((c, ci) => renderBlock(c, `${key}-${i}-${ci}`, ctx))}
        </li>
      ))}
    </Tag>
  );
}

function renderBlock(b: Block, key: string, ctx: Ctx): ReactNode {
  switch (b.t) {
    case 'h': return <div key={key} role="heading" aria-level={b.level} style={{ fontSize: H_SIZE[b.level], fontWeight: 700, margin: `${b.level <= 2 ? 14 : 10}px 0 4px`, letterSpacing: '-.2px' }}>{inline(b.text, `${key}h`, ctx)}</div>;
    case 'p': return <p key={key} style={{ margin: ctx.compact ? '4px 0' : '7px 0', lineHeight: 1.6 }}>{para(b.lines, key, ctx)}</p>;
    case 'code': return richBlock(b, key, ctx);
    case 'list': return renderList(b, key, ctx);
    case 'hr': return <hr key={key} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />;
    case 'comment': return null;
    case 'quote': {
      const callout = /^\[!(\w+)\]\s*(.*)$/.exec(b.lines[0] ?? '');
      if (callout) return <Callout key={key} kind={callout[1].toLowerCase()} title={callout[2]}>{renderBlocks(parseBlocks(b.lines.slice(1).join('\n')), `${key}q`, ctx)}</Callout>;
      return <blockquote key={key} style={{ margin: '8px 0', padding: '2px 12px', borderLeft: '3px solid var(--border)', color: 'var(--text-dim)' }}>{renderBlocks(parseBlocks(b.lines.join('\n')), `${key}q`, ctx)}</blockquote>;
    }
    case 'table': return (
      <div key={key} style={{ overflowX: 'auto', margin: '10px 0' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '.93em', minWidth: 'min(100%, 320px)' }}>
          <thead><tr>{b.head.map((c, i) => <th key={i} style={{ textAlign: b.align[i] ?? 'left', padding: '6px 10px', borderBottom: '2px solid var(--border)', color: 'var(--text-dim)', fontWeight: 600, whiteSpace: 'nowrap' }}>{inline(c, `${key}th${i}`, ctx)}</th>)}</tr></thead>
          <tbody>{b.rows.map((r, ri) => <tr key={ri}>{b.head.map((_, ci) => <td key={ci} style={{ textAlign: b.align[ci] ?? 'left', padding: '5px 10px', borderBottom: '1px solid var(--border-soft)', verticalAlign: 'top' }}>{inline(r[ci] ?? '', `${key}td${ri}-${ci}`, ctx)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
}

function renderBlocks(blocks: Block[], key: string, ctx: Ctx): ReactNode[] { return blocks.map((b, i) => renderBlock(b, `${key}${i}`, ctx)); }

export interface MarkdownProps {
  text: string;
  /** Resolve `#goal:`/`#decision:`/`#task:` references into chips. */
  refs?: RefResolver;
  /** Tighter paragraph spacing (channel posts). */
  compact?: boolean;
  /** Streaming: render a caret after the last block. */
  streaming?: boolean;
  /** Draw resolved `@mentions` as chips (group chat). */
  mentions?: MentionFinder;
}

export const Markdown = memo(function Markdown({ text, refs, compact, streaming, mentions }: MarkdownProps) {
  const ctx: Ctx = { refs, compact, mentions };
  const blocks = parseBlocks(text);
  return (
    <div className="md" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      {renderBlocks(blocks, 'b', ctx)}
      {streaming && <span aria-hidden style={{ animation: 'blink 1s infinite', color: 'var(--accent)' }}>▋</span>}
    </div>
  );
});

/** Strip markdown to plain text (for TTS, previews, notifications). */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~#>|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
