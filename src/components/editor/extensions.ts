/** The Markdown editor's schema (docs/filesystem.md "Editing"): TipTap's
 *  nodes, each limited to what Markdown can store, plus the attributes the
 *  round-trip needs (list markers, tightness, cell alignment) and `rawBlock`
 *  for HTML blocks and comments, kept verbatim. No React here, so the codec
 *  tests can build the schema without a DOM editor. */
import { Node, getSchema, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BulletList, OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';
import { Placeholder } from '@tiptap/extensions';

const keep = (def: unknown) => ({ default: def, rendered: false, keepOnSplit: true });

const align = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.textAlign || null,
    renderHTML: (a: Record<string, unknown>) => (a.align ? { style: `text-align:${String(a.align)}` } : {}),
  },
};

/** An HTML block or comment: an atom shown as its source, saved as it was. */
export const RawBlock = Node.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() { return { text: { default: '', rendered: false } }; },
  parseHTML() { return [{ tag: 'div[data-raw-block]', getAttrs: (el) => ({ text: (el as HTMLElement).getAttribute('data-raw-block') ?? '' }) }]; },
  renderHTML({ node, HTMLAttributes }) {
    const text = String(node.attrs.text);
    const comment = /^<!--[\s\S]*-->$/.test(text.trim());
    return ['div', mergeAttributes(HTMLAttributes, { 'data-raw-block': text, class: comment ? 'ed-raw comment' : 'ed-raw', contenteditable: 'false' }),
      ['span', { class: 'ed-raw-label' }, comment ? (text.includes('notes:') ? 'Notes marker — kept when the file is regenerated' : 'Comment') : 'HTML'],
      ['code', {}, text]];
  },
});

export interface EditorExtensionOptions { placeholder?: string; codeBlock?: typeof CodeBlock }

export function editorExtensions(opts: EditorExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      bulletList: false, orderedList: false, codeBlock: false, underline: false, trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: true, HTMLAttributes: { rel: 'noreferrer noopener', target: '_blank' } },
    }),
    BulletList.extend({ addAttributes() { return { ...this.parent?.(), tight: keep(true), bullet: keep('-') }; } }),
    OrderedList.extend({ addAttributes() { return { ...this.parent?.(), tight: keep(true), delim: keep('.') }; } }),
    TaskList.extend({ addAttributes() { return { ...this.parent?.(), tight: keep(true), bullet: keep('-') }; } }),
    TaskItem.configure({ nested: true }),
    (opts.codeBlock ?? CodeBlock).configure({ defaultLanguage: null }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader.extend({ addAttributes() { return { ...this.parent?.(), ...align }; } }),
    TableCell.extend({ addAttributes() { return { ...this.parent?.(), ...align }; } }),
    Image.configure({ inline: true, allowBase64: true }),
    RawBlock,
    ...(opts.placeholder !== undefined ? [Placeholder.configure({ placeholder: opts.placeholder, includeChildren: false })] : []),
  ];
}

/** The schema alone (codec, tests). */
export const editorSchema = getSchema(editorExtensions());
