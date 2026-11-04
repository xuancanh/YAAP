/**
 * Markdown ↔ editor document (docs/filesystem.md "Editing"). Markdown is the
 * storage format — agents read and write .md — so the WYSIWYG editor works on
 * a ProseMirror document parsed from the file and writes Markdown back.
 *
 * Fidelity, in order of strength:
 *  1. A document nobody changed serialises to the exact original text (the
 *     editor never writes it at all).
 *  2. Every top-level block the user did not touch is written back verbatim,
 *     with the original text between blocks (blank lines, link reference
 *     definitions…). Only edited blocks are re-serialised.
 *  3. Front matter (`---` … `---` at the top) is kept outside the editor and
 *     put back as it was; HTML blocks and comments (the generated files'
 *     Notes marker) are atoms the editor keeps verbatim; CRLF files stay CRLF.
 *
 * Edited blocks are normalised: `*`/`_` emphasis → `*`/`**`, setext → ATX
 * headings, indented → fenced code, a table's column padding, escapes.
 * Bullet markers, ordered delimiters and tight/loose lists are kept.
 */
import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { MarkdownParser, MarkdownSerializer, defaultMarkdownSerializer, type MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

export { NOTES_MARKER, generatedNote, splitFrontMatter, splitNotes, toggleTaskLine } from './markdownText';
import { splitFrontMatter } from './markdownText';

// ------------------------------------------------------------- tokenizer

const md = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);

const TASK_RE = /^\[([ xX])\][ \t]+/;

/** markdown-it tokens → the shapes the editor schema wants: task lists,
 *  cell paragraphs, inline HTML as text. */
function preprocess(tokens: Token[]): Token[] {
  const T = tokens[0]?.constructor as (new (type: string, tag: string, nesting: number) => Token) | undefined;
  // task lists: a bullet list whose every item starts with [ ] / [x]
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'bullet_list_open') continue;
    let depth = 0; let close = -1; const items: number[] = [];
    for (let j = i; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open' || t.type === 'task_list_open') depth++;
      if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close' || t.type === 'task_list_close') { depth--; if (depth === 0) { close = j; break; } }
      if (t.type === 'list_item_open' && t.level === open.level + 1) items.push(j);
    }
    if (close < 0 || items.length === 0) continue;
    const isTask = items.every((j) => tokens[j + 1]?.type === 'paragraph_open' && tokens[j + 2]?.type === 'inline' && TASK_RE.test(tokens[j + 2].content));
    if (!isTask) continue;
    open.type = 'task_list_open'; tokens[close].type = 'task_list_close';
    for (const j of items) {
      const item = tokens[j]; const inl = tokens[j + 2];
      const checked = TASK_RE.exec(inl.content)![1] !== ' ';
      item.type = 'task_item_open'; item.attrSet('checked', String(checked));
      inl.content = inl.content.replace(TASK_RE, '');
      inl.children = md.parseInline(inl.content, {})[0]?.children ?? [];
      // its matching close
      let d = 0;
      for (let k = j; k < tokens.length; k++) {
        if (tokens[k].type === 'list_item_open' || tokens[k].type === 'task_item_open') d++;
        if (tokens[k].type === 'list_item_close') { d--; if (d === 0) { tokens[k].type = 'task_item_close'; break; } }
      }
    }
  }
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.children) t.children = t.children.map((c) => (c.type === 'html_inline' ? Object.assign(c, { type: 'text' }) : c));
    if (T && (t.type === 'th_open' || t.type === 'td_open')) { out.push(t, new T('paragraph_open', 'p', 1)); continue; }
    if (T && (t.type === 'th_close' || t.type === 'td_close')) { out.push(new T('paragraph_close', 'p', -1), t); continue; }
    out.push(t);
  }
  return out;
}

function listTight(tokens: Token[], i: number): boolean {
  while (++i < tokens.length) if (tokens[i].type !== 'list_item_open' && tokens[i].type !== 'task_item_open') return tokens[i].hidden;
  return true;
}
const alignOf = (t: Token): 'left' | 'center' | 'right' | null => {
  const m = /text-align:\s*(left|center|right)/.exec(t.attrGet('style') ?? '');
  return (m?.[1] as 'left' | 'center' | 'right' | undefined) ?? null;
};

// ------------------------------------------------------------ the codec

export interface ParsedMarkdown {
  doc: PMNode;
  /** Front matter, verbatim (outside the editor). */
  front: string;
  crlf: boolean;
  /** The body, LF-normalised. */
  body: string;
  /** Per top-level node: its original text span in `body`. */
  spans: Array<{ start: number; end: number }>;
  /** The top-level nodes as first loaded (rebased onto the editor's doc). */
  nodes: PMNode[];
}

export interface MarkdownCodec {
  parse(text: string): ParsedMarkdown;
  serialize(doc: PMNode, from?: ParsedMarkdown): string;
  /** Use the editor's own copy of the loaded doc for "unchanged" checks. */
  rebase(parsed: ParsedMarkdown, doc: PMNode): void;
}

export function markdownCodec(schema: Schema): MarkdownCodec {
  let last: Token[] = [];
  const tokenizer = { parse: (src: string, env: object) => (last = preprocess(md.parse(src, env))) } as unknown as MarkdownIt;
  const parser = new MarkdownParser(schema, tokenizer, {
    blockquote: { block: 'blockquote' },
    paragraph: { block: 'paragraph' },
    list_item: { block: 'listItem' },
    bullet_list: { block: 'bulletList', getAttrs: (t, ts, i) => ({ tight: listTight(ts, i), bullet: t.markup || '-' }) },
    ordered_list: { block: 'orderedList', getAttrs: (t, ts, i) => ({ start: Number(t.attrGet('start') ?? 1), tight: listTight(ts, i), delim: t.markup || '.' }) },
    task_list: { block: 'taskList', getAttrs: (t, ts, i) => ({ tight: listTight(ts, i), bullet: t.markup || '-' }) },
    task_item: { block: 'taskItem', getAttrs: (t) => ({ checked: t.attrGet('checked') === 'true' }) },
    heading: { block: 'heading', getAttrs: (t) => ({ level: Number(t.tag.slice(1)) }) },
    code_block: { block: 'codeBlock', noCloseToken: true },
    fence: { block: 'codeBlock', getAttrs: (t) => ({ language: t.info.trim() || null }), noCloseToken: true },
    hr: { node: 'horizontalRule' },
    image: { node: 'image', getAttrs: (t) => ({ src: t.attrGet('src'), title: t.attrGet('title') || null, alt: t.children?.map((c) => c.content).join('') || null }) },
    hardbreak: { node: 'hardBreak' },
    softbreak: { node: 'hardBreak' },
    html_block: { node: 'rawBlock', getAttrs: (t) => ({ text: t.content.replace(/\n+$/, '') }) },
    table: { block: 'table' },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: 'tableRow' },
    th: { block: 'tableHeader', getAttrs: (t) => ({ align: alignOf(t) }) },
    td: { block: 'tableCell', getAttrs: (t) => ({ align: alignOf(t) }) },
    em: { mark: 'italic' },
    strong: { mark: 'bold' },
    s: { mark: 'strike' },
    link: { mark: 'link', getAttrs: (t) => ({ href: t.attrGet('href'), title: t.attrGet('title') || null }) },
    code_inline: { mark: 'code', noCloseToken: true },
  });

  const d = defaultMarkdownSerializer.nodes;
  const inlineOf = (node: PMNode): string => serializer.serialize(schema.node('doc', null, [schema.node('paragraph', null, node.content)]), { tightLists: true }).trim();
  const cellText = (cell: PMNode): string => {
    const parts: string[] = [];
    cell.forEach((p) => parts.push(p.isTextblock ? inlineOf(p) : serializer.serialize(schema.node('doc', null, [p]), { tightLists: true }).trim()));
    return parts.join('<br>').replace(/\n/g, '<br>').replace(/(?<!\\)\|/g, '\\|');
  };
  const serializer: MarkdownSerializer = new MarkdownSerializer({
    paragraph: d.paragraph,
    text: d.text,
    heading: d.heading,
    blockquote: d.blockquote,
    codeBlock: (s, n) => {
      const ticks = n.textContent.match(/`{3,}/gm);
      const fence = ticks ? `${ticks.sort().slice(-1)[0]}\`` : '```';
      s.write(`${fence}${(n.attrs.language as string | null) ?? ''}\n`);
      s.text(n.textContent, false);
      s.write('\n'); s.write(fence); s.closeBlock(n);
    },
    horizontalRule: (s, n) => { s.write('---'); s.closeBlock(n); },
    bulletList: (s, n) => s.renderList(n, '  ', () => `${(n.attrs.bullet as string) || '-'} `),
    taskList: (s, n) => s.renderList(n, '  ', () => `${(n.attrs.bullet as string) || '-'} `),
    orderedList: (s, n) => {
      const start = (n.attrs.start as number) ?? 1;
      const delim = (n.attrs.delim as string) || '.';
      const maxW = String(start + n.childCount - 1).length;
      s.renderList(n, s.repeat(' ', maxW + 2), (i) => { const k = String(start + i); return `${s.repeat(' ', maxW - k.length)}${k}${delim} `; });
    },
    listItem: (s, n) => s.renderContent(n),
    taskItem: (s, n) => { s.write(n.attrs.checked ? '[x] ' : '[ ] '); s.renderContent(n); },
    image: d.image,
    hardBreak: (s, n, parent, index) => {
      for (let i = index + 1; i < parent.childCount; i++) if (parent.child(i).type !== n.type) { s.write('\n'); return; }
    },
    rawBlock: (s, n) => { s.text(n.attrs.text as string, false); s.closeBlock(n); },
    table: (s, n) => {
      const rows: Array<Array<{ text: string; align: string | null }>> = [];
      n.forEach((row) => { const cells: Array<{ text: string; align: string | null }> = []; row.forEach((c) => cells.push({ text: cellText(c), align: c.attrs.align as string | null })); rows.push(cells); });
      const cols = Math.max(1, ...rows.map((r) => r.length));
      const line = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
      const aligns = Array.from({ length: cols }, (_, i) => rows[0]?.[i]?.align ?? null);
      const sep = `|${aligns.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---')).join('|')}|`;
      const out = [line((rows[0] ?? []).map((c) => c.text)), sep, ...rows.slice(1).map((r) => line(r.map((c) => c.text)))];
      s.text(out.join('\n'), false);
      s.closeBlock(n);
    },
    tableRow: () => undefined, tableHeader: () => undefined, tableCell: () => undefined,
  }, {
    italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
    bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
    strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
    code: defaultMarkdownSerializer.marks.code,
    link: defaultMarkdownSerializer.marks.link,
  });

  // GitHub callouts: `> [!NOTE]` must not come out as `> \[!NOTE\]`
  const serializeNode = (n: PMNode): string => serializer.serialize(schema.node('doc', null, [n]), { tightLists: true }).replace(/\n+$/, '').replace(/^(\s*(?:>\s*)+)\\\[!(\w+)\\\]/gm, '$1[!$2]');

  const parse = (text: string): ParsedMarkdown => {
    const crlf = text.includes('\r\n');
    const norm = crlf ? text.replace(/\r\n/g, '\n') : text;
    const { front, body } = splitFrontMatter(norm);
    const doc = parser.parse(body);
    // top-level block spans from the token maps (lines → offsets)
    const lineStart: number[] = [0];
    for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStart.push(i + 1);
    const lineEnd = (l: number) => (l + 1 < lineStart.length ? lineStart[l + 1] - 1 : body.length);
    const spans: Array<{ start: number; end: number }> = [];
    for (const t of last) {
      if (t.level !== 0 || t.nesting < 0 || !t.map) continue;
      const [a, b] = t.map;
      let endLine = Math.max(a, b - 1);
      while (endLine > a && body.slice(lineStart[endLine], lineEnd(endLine)).trim() === '') endLine--;
      spans.push({ start: lineStart[a], end: lineEnd(endLine) });
    }
    const nodes: PMNode[] = [];
    doc.forEach((n) => nodes.push(n));
    return { doc, front, crlf, body, spans: spans.length === nodes.length ? spans : [], nodes: spans.length === nodes.length ? nodes : [] };
  };

  const serialize = (doc: PMNode, from?: ParsedMarkdown): string => {
    const finish = (bodyOut: string) => { const all = (from?.front ?? '') + bodyOut; return from?.crlf ? all.replace(/\n/g, '\r\n') : all; };
    if (from && doc.eq(from.doc)) return finish(from.body);
    // a lone empty paragraph is an empty file
    if (doc.childCount === 1 && doc.firstChild!.type.name === 'paragraph' && doc.firstChild!.content.size === 0) return finish('');
    const spans = from?.spans ?? [];
    const nodes = from?.nodes ?? [];
    const body = from?.body ?? '';
    const used = new Set<number>();
    const gapAfter = (j: number) => body.slice(spans[j].end, j + 1 < spans.length ? spans[j + 1].start : body.length);
    let out = '';
    let prev = -2;
    doc.forEach((node, _o, i) => {
      let j = -1;
      if (prev >= -1 && prev + 1 < nodes.length && !used.has(prev + 1) && nodes[prev + 1].eq(node)) j = prev + 1;
      else for (let k = 0; k < nodes.length; k++) if (!used.has(k) && nodes[k].eq(node)) { j = k; break; }
      if (i === 0) {
        if (j === 0) out += body.slice(0, spans[0].start);
        else if (spans.length && body.slice(0, spans[0].start).trim()) out += body.slice(0, spans[0].start).replace(/\n*$/, '\n\n');
      } else if (!(j >= 0 && prev === j - 1)) {
        // the previous block's gap was already written when it had content
        if (!out.endsWith('\n\n')) out = out.replace(/\n*$/, '\n\n');
      }
      if (j >= 0) {
        used.add(j);
        out += body.slice(spans[j].start, spans[j].end);
        const gap = gapAfter(j);
        const nextIsNext = i + 1 < doc.childCount && j + 1 < nodes.length && !used.has(j + 1) && nodes[j + 1].eq(doc.child(i + 1));
        if (nextIsNext || j === nodes.length - 1 || gap.trim()) out += gap;
      } else out += serializeNode(node);
      prev = j;
    });
    // the trailing text was written with the last original block; otherwise one newline, as the file had
    if (!(prev >= 0 && prev === nodes.length - 1)) out = out.replace(/\n+$/, '') + (!from || body === '' || body.endsWith('\n') ? '\n' : '');
    return finish(out);
  };

  const rebase = (parsed: ParsedMarkdown, doc: PMNode) => {
    if (doc.childCount !== parsed.spans.length) return;
    const nodes: PMNode[] = [];
    doc.forEach((n) => nodes.push(n));
    parsed.nodes = nodes;
    parsed.doc = doc;
  };

  return { parse, serialize, rebase };
}

export type { MarkdownSerializerState };
