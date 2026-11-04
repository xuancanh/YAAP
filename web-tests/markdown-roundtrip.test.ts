import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { editorSchema } from '../src/components/editor/extensions';
import { NOTES_MARKER, generatedNote, markdownCodec, splitFrontMatter, splitNotes, toggleTaskLine } from '../src/lib/markdownDoc';
import { NOTES_MARKER as SERVER_NOTES_MARKER } from '../server/src/files/layout';

const codec = markdownCodec(editorSchema);
const roundTrip = (text: string) => codec.serialize(codec.parse(text).doc, codec.parse(text));

/** The shape of the generated /org/README.md (server/src/org/org-layout.service.ts
 *  renderOrgReadme + withNotes): tables with paths and code, the Notes marker, a kept tail. */
const README = [
  '# Real Jong — the company folder', '',
  '_The index of /org/: what lives where. Generated and kept current by the server (server/src/files/layout.ts) — add your own notes below the Notes line; they are kept._', '',
  '## How the company runs', '',
  '| Path | What it holds | Kept by |', '|---|---|---|',
  '| /org/operating-system.md | the operating profile as diagnosed, every derived parameter with its reason | the chief (seeded at onboarding) |',
  '| /org/meetings/<unit>/<yyyy>/ | minutes `<yyyy-mm-dd>-<kind>.md` and agendas `…-agenda.md` | written when a meeting ends |', '',
  '## Functions', '',
  'One folder per job function (`cs-*` → /org/customer/): `engineering` Engineering, `sales` Sales.', '',
  '| Folder | Function | Head | Unit |', '|---|---|---|---|', '| /org/engineering/ | Engineering | Ada | — |', '',
  '- /channels/<slug>/ — a channel\'s files; `meetings/` holds the minutes.',
  '- /agents/<handle>/ — an agent\'s home: LESSONS.md, JOURNAL.md, knowledge/.', '',
  '<!-- notes: everything below this line is kept when the file is regenerated -->', '',
  '## Notes', '', 'Our own note, *kept*.', '',
].join('\n');

const DOCS: Record<string, string> = {
  tables: '# Plan\n\n| Path | What | Kept by |\n|---|:---:|---:|\n| /org/a.md | the `a` file \\| pipes | chief |\n| /org/b/ | **bold** cell | — |\n\nAfter.\n',
  tasks: '## To do\n\n- [ ] write the brief\n- [x] call Ada\n  - [ ] nested follow-up\n* plain star bullet\n',
  frontMatter: '---\ntitle: Weekly\ntags: [a, b]\n---\n\n<!-- a comment the agent left -->\n\n# Weekly\n\nText with <b>inline html</b> and a [link](https://x.y "t").\n',
  nested: '1. one\n2. two\n   - sub *a*\n   - sub _b_\n     1) deep\n10. ten\n\n> [!NOTE]\n> a callout\n\n```ts\nconst x = 1;\n```\n\n    indented code\n\nSetext\n======\n\n***\n\n[ref]: https://example.com\n',
  loose: '- a\n\n- b\n\nline one\nline two  \nhard break\n',
  crlf: '# Title\r\n\r\n- a\r\n- b\r\n',
  noTrailingNewline: 'just text',
  empty: '',
  readme: README,
};

describe('markdown round-trip (docs/filesystem.md "Editing")', () => {
  for (const [name, text] of Object.entries(DOCS)) {
    it(`opening and saving without edits keeps ${name} byte for byte`, () => {
      expect(roundTrip(text)).toBe(text);
    });
  }

  it('maps the blocks to their source spans', () => {
    const p = codec.parse(DOCS.nested);
    expect(p.spans.length).toBe(p.doc.childCount);
    expect(p.body.slice(p.spans[0].start, p.spans[0].end)).toBe('1. one\n2. two\n   - sub *a*\n   - sub _b_\n     1) deep\n10. ten');
  });

  it('parses task lists, tables with alignment, HTML comments and front matter', () => {
    const t = codec.parse(DOCS.tasks).doc;
    expect(t.child(1).type.name).toBe('taskList');
    expect(t.child(1).child(1).attrs.checked).toBe(true);
    expect(t.child(2).type.name).toBe('bulletList');
    const tb = codec.parse(DOCS.tables).doc.child(1);
    expect(tb.type.name).toBe('table');
    expect(tb.child(0).child(1).attrs.align).toBe('center');
    expect(tb.child(0).child(0).type.name).toBe('tableHeader');
    const fm = codec.parse(DOCS.frontMatter);
    expect(fm.front).toBe('---\ntitle: Weekly\ntags: [a, b]\n---\n');
    expect(fm.doc.child(0).type.name).toBe('rawBlock');
  });

  /** Replace the text of top-level block `i` (a paragraph or heading). */
  const editBlock = (doc: PMNode, i: number, text: string): PMNode => {
    const kids: PMNode[] = [];
    doc.forEach((n, _o, k) => kids.push(k === i ? n.type.create(n.attrs, editorSchema.text(text)) : n));
    return doc.type.create(doc.attrs, kids);
  };

  it('an edit re-serialises only the edited block; everything else stays verbatim', () => {
    const p = codec.parse(DOCS.nested);
    const idx = [...Array(p.doc.childCount).keys()].find((i) => p.doc.child(i).type.name === 'heading')!;
    const out = codec.serialize(editBlock(p.doc, idx, 'Renamed'), p);
    expect(out).toBe(DOCS.nested.replace('Setext\n======', '## Renamed'.replace('##', '#')));
  });

  it('keeps the generated README\'s Notes marker and tail when a note is added', () => {
    const p = codec.parse(README);
    const kids: PMNode[] = [];
    p.doc.forEach((n) => kids.push(n));
    kids.push(editorSchema.node('paragraph', null, editorSchema.text('My own note.')));
    const out = codec.serialize(p.doc.type.create(null, kids), p);
    expect(out).toBe(`${README.replace(/\n$/, '')}\n\nMy own note.\n`);
    expect(out).toContain(NOTES_MARKER);
  });

  it('serialises new content: tasks, tables, code, marks', () => {
    const s = editorSchema;
    const doc = s.node('doc', null, [
      s.node('heading', { level: 2 }, s.text('New')),
      s.node('taskList', null, [s.node('taskItem', { checked: true }, s.node('paragraph', null, s.text('done'))), s.node('taskItem', { checked: false }, s.node('paragraph', null, s.text('todo')))]),
      s.node('table', null, [
        s.node('tableRow', null, [s.node('tableHeader', null, s.node('paragraph', null, s.text('a'))), s.node('tableHeader', { align: 'right' }, s.node('paragraph', null, s.text('b')))]),
        s.node('tableRow', null, [s.node('tableCell', null, s.node('paragraph', null, s.text('x|y'))), s.node('tableCell', { align: 'right' }, s.node('paragraph'))]),
      ]),
      s.node('codeBlock', { language: 'js' }, s.text('let a = 1;')),
      s.node('paragraph', null, [s.text('bold', [s.marks.bold.create()]), s.text(' and '), s.text('code', [s.marks.code.create()])]),
    ]);
    expect(codec.serialize(doc)).toBe('## New\n\n- [x] done\n- [ ] todo\n\n| a | b |\n|---|---:|\n| x\\|y |  |\n\n```js\nlet a = 1;\n```\n\n**bold** and `code`\n');
    // and it parses back to the same document
    expect(codec.parse(codec.serialize(doc)).doc.toJSON()).toEqual(doc.toJSON());
  });
});

describe('markdown helpers', () => {
  it('the Notes marker mirrors the server\'s', () => {
    expect(NOTES_MARKER).toBe(SERVER_NOTES_MARKER);
    const parts = splitNotes(README)!;
    expect(parts.head.endsWith(NOTES_MARKER)).toBe(true);
    expect(parts.head + parts.tail).toBe(README);
  });
  it('front matter splits off verbatim', () => {
    expect(splitFrontMatter('---\na: 1\n---\nbody').front).toBe('---\na: 1\n---\n');
    expect(splitFrontMatter('--- not\nbody').front).toBe('');
  });
  it('recognises wholly generated files', () => {
    expect(generatedNote('# Calendar\n\n_Generated from the cadences and kept current — edits are overwritten the next time it changes._\n')).toMatch(/Generated from the cadences/);
    expect(generatedNote(README)).toBeNull();
  });
  it('toggles a task on its source line, keeping CRLF', () => {
    expect(toggleTaskLine('a\n- [ ] x\n', 1, true)).toBe('a\n- [x] x\n');
    expect(toggleTaskLine('- [X] x\r\n', 0, false)).toBe('- [ ] x\r\n');
    expect(toggleTaskLine('- x\n', 0, true)).toBeNull();
  });
});
