/**
 * The Markdown editor (docs/filesystem.md "Editing"): TipTap (ProseMirror)
 * on the schema in ./extensions, loaded from and saved to Markdown through
 * src/lib/markdownDoc.ts. Notion-like: `/` opens the block menu, Markdown
 * shortcuts work as you type (`# `, `- `, `1. `, `[] `, `> `, ``` ``` ```,
 * `---`), a toolbar floats over a selection, blocks drag by their handle,
 * tables get a row/column bar, ⌘B/⌘I/⌘E/⌘K/⌘Z/⌘S. Lazy-loaded: the chunk
 * is fetched the first time someone edits a Markdown file.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type Editor, type NodeViewProps } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { Extension, type ChainedCommands, type Range } from '@tiptap/core';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import CodeBlock from '@tiptap/extension-code-block';
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode, Slice } from '@tiptap/pm/model';
import { editorExtensions, editorSchema } from './extensions';
import { markdownCodec, type MarkdownCodec, type ParsedMarkdown } from '../../lib/markdownDoc';
import { lex } from '../../lib/highlight';

// ------------------------------------------------------ code blocks

function codeDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'codeBlock') return true;
    for (const t of lex(node.textContent, node.attrs.language as string | null, 60_000)) decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: `tok-${t.kind}` }));
    return false;
  });
  return DecorationSet.create(doc, decos);
}

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper className="ed-code">
      <input className="ed-lang" contentEditable={false} spellCheck={false} aria-label="Code language" placeholder="text"
        defaultValue={(node.attrs.language as string | null) ?? ''}
        onChange={(e) => updateAttributes({ language: e.target.value.trim() || null })} />
      <pre><NodeViewContent<'code'> as="code" /></pre>
    </NodeViewWrapper>
  );
}

const HighlightedCodeBlock = CodeBlock.extend({
  addNodeView() { return ReactNodeViewRenderer(CodeBlockView); },
  addProseMirrorPlugins() {
    const key = new PluginKey('codeHighlight');
    return [...(this.parent?.() ?? []), new Plugin<DecorationSet>({
      key,
      state: { init: (_, { doc }) => codeDecorations(doc), apply: (tr, old) => (tr.docChanged ? codeDecorations(tr.doc) : old) },
      props: { decorations(state: EditorState) { return key.getState(state) as DecorationSet; } },
    })];
  },
});

// ------------------------------------------------------- slash menu

export interface SlashItem { id: string; label: string; hint: string; icon: string; keywords?: string; run: (c: ChainedCommands, editor: Editor) => void }

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: 'Text', hint: 'Plain paragraph', icon: 'T', run: (c) => c.setParagraph().run() },
  { id: 'h1', label: 'Heading 1', hint: 'Big section heading', icon: 'H1', keywords: 'title', run: (c) => c.setHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: 'H2', run: (c) => c.setHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', hint: 'Small section heading', icon: 'H3', run: (c) => c.setHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bulleted list', hint: 'A simple list', icon: '•', keywords: 'ul unordered', run: (c) => c.toggleBulletList().run() },
  { id: 'numbered', label: 'Numbered list', hint: 'A list with numbers', icon: '1.', keywords: 'ol ordered', run: (c) => c.toggleOrderedList().run() },
  { id: 'todo', label: 'To-do list', hint: 'Tasks with checkboxes', icon: '☐', keywords: 'task check', run: (c) => c.toggleTaskList().run() },
  { id: 'quote', label: 'Quote', hint: 'A quoted passage', icon: '“', keywords: 'blockquote', run: (c) => c.toggleBlockquote().run() },
  { id: 'callout', label: 'Callout', hint: 'A note that stands out', icon: 'i', keywords: 'note tip warning', run: (c) => c.toggleBlockquote().insertContent([{ type: 'text', text: '[!NOTE]' }, { type: 'hardBreak' }]).run() },
  { id: 'code', label: 'Code block', hint: 'Code with a language', icon: '{}', keywords: 'fence snippet', run: (c) => c.toggleCodeBlock().run() },
  { id: 'table', label: 'Table', hint: 'Rows and columns', icon: '▦', keywords: 'grid', run: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', label: 'Image', hint: 'From a link', icon: '▣', keywords: 'picture photo', run: (c) => { const src = window.prompt('Image address (https://…)')?.trim(); if (src) c.setImage({ src }).run(); else c.run(); } },
  { id: 'divider', label: 'Divider', hint: 'A horizontal rule', icon: '—', keywords: 'hr rule line', run: (c) => c.setHorizontalRule().run() },
];

export const filterSlash = (q: string): SlashItem[] => {
  const s = q.trim().toLowerCase();
  if (!s) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) => `${i.label} ${i.id} ${i.keywords ?? ''}`.toLowerCase().includes(s));
};

interface SlashState { items: SlashItem[]; rect: DOMRect | null; command: (item: SlashItem) => void }
/** Functions, not refs: TipTap deep-merges options, so an object would be copied. */
interface SlashOptions { onState: (s: SlashState | null) => void; onKey: (e: KeyboardEvent) => boolean }
type KeyRef = { current: ((e: KeyboardEvent) => boolean) | null };

const SlashCommand = Extension.create<SlashOptions>({
  name: 'slashCommand',
  // before the keymaps, so Enter picks an item instead of splitting the block
  priority: 1000,
  addOptions() { return { onState: () => undefined, onKey: () => false }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    const show = (p: SuggestionProps<SlashItem, SlashItem>) => opts.onState({ items: p.items, rect: p.clientRect?.() ?? null, command: (it) => p.command(it) });
    return [Suggestion<SlashItem, SlashItem>({
      editor: this.editor,
      char: '/',
      pluginKey: new PluginKey('slashCommand'),
      allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
      items: ({ query }) => filterSlash(query),
      command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => props.run(editor.chain().focus().deleteRange(range), editor),
      render: () => ({
        onStart: show,
        onUpdate: show,
        onKeyDown: ({ event }) => { if (event.key === 'Escape') { opts.onState(null); return true; } return opts.onKey(event); },
        onExit: () => opts.onState(null),
      }),
    })];
  },
});

function SlashMenu({ state, keys }: { state: SlashState; keys: KeyRef }) {
  const [sel, setSel] = useState(0);
  const items = state.items;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(0), [items]);
  useEffect(() => {
    keys.current = (e) => {
      if (e.key === 'ArrowDown') { setSel((s) => (items.length ? (s + 1) % items.length : 0)); return true; }
      if (e.key === 'ArrowUp') { setSel((s) => (items.length ? (s - 1 + items.length) % items.length : 0)); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { const it = items[sel]; if (it) { state.command(it); return true; } return false; }
      return false;
    };
    return () => { keys.current = null; };
  }, [items, sel, state, keys]);
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView?.({ block: 'nearest' }); }, [sel]);
  const r = state.rect;
  // below the caret, or above it when the window has no room below
  const above = !!r && r.bottom + 330 > window.innerHeight && r.top > 340;
  const pos = !r ? { top: 80 } : above ? { bottom: window.innerHeight - r.top + 6 } : { top: Math.min(r.bottom + 6, window.innerHeight - 330) };
  const left = r ? Math.min(r.left, window.innerWidth - 270) : 80;
  return (
    <div className="ed-slash" role="listbox" aria-label="Insert block" ref={list} style={{ ...pos, left }} data-testid="slash-menu" onMouseDown={(e) => e.preventDefault()}>
      {items.length === 0 && <div className="none">No matching blocks</div>}
      {items.map((it, i) => (
        <button key={it.id} type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : undefined} onMouseEnter={() => setSel(i)} onClick={() => state.command(it)}>
          <span className="ico" aria-hidden>{it.icon}</span>
          <span><div className="lbl">{it.label}</div><div className="sub">{it.hint}</div></span>
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------ shortcuts

const promptLink = (editor: Editor) => {
  const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
  const href = window.prompt('Link address', prev || 'https://');
  if (href === null) return;
  if (!href.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
  else editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run();
};

const Shortcuts = Extension.create<{ onSave: () => void }>({
  name: 'docShortcuts',
  addOptions() { return { onSave: () => undefined }; },
  addKeyboardShortcuts() {
    return {
      'Mod-s': () => { this.options.onSave(); return true; },
      'Mod-k': () => { promptLink(this.editor); return true; },
    };
  },
});

// ------------------------------------------------------ drag handle

interface Dragging { slice: Slice; move: boolean; node?: NodeSelection }

function useBlockHandle(editor: Editor | null, root: React.RefObject<HTMLDivElement | null>) {
  const [h, setH] = useState<{ top: number; pos: number } | null>(null);
  const onMove = (e: React.MouseEvent) => {
    if (!editor || !root.current || editor.isDestroyed) return;
    const view = editor.view;
    const pm = view.dom.getBoundingClientRect();
    const hit = view.posAtCoords({ left: Math.max(pm.left + 8, Math.min(e.clientX, pm.right - 8)), top: e.clientY });
    if (!hit) return;
    const $p = view.state.doc.resolve(hit.pos);
    let pos: number;
    if ($p.depth > 0) pos = $p.before(1);
    else if (hit.inside >= 0) { const $i = view.state.doc.resolve(hit.inside); pos = $i.depth > 0 ? $i.before(1) : hit.inside; } else return;
    if (!view.state.doc.nodeAt(pos)) return;
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (!dom?.getBoundingClientRect) return;
    const top = dom.getBoundingClientRect().top - root.current.getBoundingClientRect().top;
    setH((old) => (old && old.pos === pos && old.top === top ? old : { top, pos }));
  };
  const select = () => {
    if (!editor || !h) return null;
    const sel = NodeSelection.create(editor.state.doc, h.pos);
    editor.view.dispatch(editor.state.tr.setSelection(sel));
    return sel;
  };
  const onDragStart = (e: React.DragEvent) => {
    const sel = select();
    if (!editor || !sel || !h) return;
    const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null;
    if (dom) e.dataTransfer.setDragImage(dom, 0, 0);
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', sel.node.textContent);
    (editor.view as unknown as { dragging: Dragging | null }).dragging = { slice: sel.content(), move: true, node: sel };
  };
  return { h, onMove, onDragStart, onClick: () => { select(); editor?.view.focus(); }, hide: () => setH(null) };
}

// ------------------------------------------------------ the editor

export interface MarkdownEditorProps {
  text: string;
  /** Changed; `get` returns the current Markdown. */
  onChange: (get: () => string) => void;
  onSave?: () => void;
  placeholder?: string;
  /** Tests and the page reach the TipTap editor through this. */
  onReady?: (editor: Editor, toMarkdown: () => string) => void;
  /** Rendered above the content, inside the column (title, notices). */
  children?: ReactNode;
}

export default function MarkdownEditor({ text, onChange, onSave, placeholder = "Type '/' for blocks, or just start writing", onReady }: MarkdownEditorProps) {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const keys = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const live = useRef({ onChange, onSave });
  live.current = { onChange, onSave };
  const codec = useRef<{ codec: MarkdownCodec; parsed: ParsedMarkdown } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const initial = useMemo(() => text, []); // eslint-disable-line react-hooks/exhaustive-deps -- remounted (key) on a new text
  const initialJson = useMemo(() => markdownCodec(editorSchema).parse(initial).doc.toJSON(), [initial]);
  const extensions = useMemo(() => [
    ...editorExtensions({ placeholder, codeBlock: HighlightedCodeBlock as unknown as typeof CodeBlock }),
    SlashCommand.configure({ onState: setSlash, onKey: (e: KeyboardEvent) => keys.current?.(e) ?? false }),
    Shortcuts.configure({ onSave: () => live.current.onSave?.() }),
  ], [placeholder]);

  const editor = useEditor({
    extensions,
    content: initialJson,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'doc-prose md', 'aria-label': 'Document', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' } },
    onCreate: ({ editor: ed }) => {
      const c = markdownCodec(ed.schema);
      const parsed = c.parse(initial);
      c.rebase(parsed, ed.state.doc);
      codec.current = { codec: c, parsed };
      onReady?.(ed, () => c.serialize(ed.state.doc, parsed));
    },
    onUpdate: ({ editor: ed }) => {
      const c = codec.current;
      if (!c) return;
      live.current.onChange(() => c.codec.serialize(ed.state.doc, c.parsed));
    },
  }, [extensions]);

  const ui = useEditorState({
    editor,
    selector: ({ editor: ed }) => ed ? ({
      bold: ed.isActive('bold'), italic: ed.isActive('italic'), strike: ed.isActive('strike'), code: ed.isActive('code'), link: ed.isActive('link'),
      h2: ed.isActive('heading', { level: 2 }), h3: ed.isActive('heading', { level: 3 }), quote: ed.isActive('blockquote'), table: ed.isActive('table'),
    }) : null,
  });
  const handle = useBlockHandle(editor, root);

  if (!editor) return null;
  const chain = () => editor.chain().focus();
  const b = (label: string, on: boolean | undefined, run: () => void, title: string, content: ReactNode = label) => (
    <button type="button" aria-label={title} title={title} aria-pressed={!!on} className={on ? 'on' : undefined} onMouseDown={(e) => e.preventDefault()} onClick={run}>{content}</button>
  );

  return (
    <div className="ed-root" ref={root} onMouseMove={handle.onMove} onMouseLeave={handle.hide} data-testid="markdown-editor">
      {ui?.table && (
        <div className="ed-tablebar" role="toolbar" aria-label="Table">
          <span className="lbl">Table</span>
          <button type="button" className="art-btn" onClick={() => chain().addRowBefore().run()}>Row above</button>
          <button type="button" className="art-btn" onClick={() => chain().addRowAfter().run()}>Row below</button>
          <button type="button" className="art-btn" onClick={() => chain().addColumnBefore().run()}>Column left</button>
          <button type="button" className="art-btn" onClick={() => chain().addColumnAfter().run()}>Column right</button>
          <button type="button" className="art-btn" onClick={() => chain().deleteRow().run()}>Delete row</button>
          <button type="button" className="art-btn" onClick={() => chain().deleteColumn().run()}>Delete column</button>
          <button type="button" className="art-btn" style={{ color: 'var(--red-text)' }} onClick={() => chain().deleteTable().run()}>Delete table</button>
        </div>
      )}
      {handle.h && (
        <button type="button" className="ed-handle show" draggable aria-label="Drag to move this block; click to select it" title="Drag to move · click to select"
          style={{ top: handle.h.top }} onDragStart={handle.onDragStart} onClick={handle.onClick}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden><circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" /><circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" /><circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" /></svg>
        </button>
      )}
      <BubbleMenu editor={editor} className="ed-bubble" shouldShow={({ editor: ed, state }) => !state.selection.empty && !ed.isActive('codeBlock') && !(state.selection instanceof NodeSelection)}>
        {b('B', ui?.bold, () => chain().toggleBold().run(), 'Bold (⌘B)', <b>B</b>)}
        {b('I', ui?.italic, () => chain().toggleItalic().run(), 'Italic (⌘I)', <i>I</i>)}
        {b('S', ui?.strike, () => chain().toggleStrike().run(), 'Strikethrough (⌘⇧S)', <s>S</s>)}
        {b('Code', ui?.code, () => chain().toggleCode().run(), 'Inline code (⌘E)', <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{'<>'}</span>)}
        {b('Link', ui?.link, () => promptLink(editor), 'Link (⌘K)', <span style={{ fontSize: 12.5 }}>Link</span>)}
        <span className="div" aria-hidden />
        {b('H2', ui?.h2, () => chain().toggleHeading({ level: 2 }).run(), 'Heading 2', <span style={{ fontSize: 12, fontWeight: 650 }}>H2</span>)}
        {b('H3', ui?.h3, () => chain().toggleHeading({ level: 3 }).run(), 'Heading 3', <span style={{ fontSize: 12, fontWeight: 650 }}>H3</span>)}
        {b('Quote', ui?.quote, () => chain().toggleBlockquote().run(), 'Quote', <span style={{ fontSize: 15 }}>“</span>)}
      </BubbleMenu>
      <EditorContent editor={editor} />
      {slash && <SlashMenu state={slash} keys={keys} />}
    </div>
  );
}
