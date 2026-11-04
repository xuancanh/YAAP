/** Markdown as text (docs/filesystem.md "Editing"): the small helpers the
 *  viewer needs — front matter, the Notes marker of generated files, task
 *  toggles — kept free of the editor's dependencies so the main bundle does
 *  not pull in the Markdown parser. */

/** Mirror of NOTES_MARKER in server/src/org/org-layout.service.ts: generated
 *  files keep whatever follows it when the server regenerates them. */
export const NOTES_MARKER = '<!-- notes: everything below this line is kept when the file is regenerated -->';

/** `---\n…\n---\n` at the very top. */
export function splitFrontMatter(text: string): { front: string; body: string } {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(text);
  return m ? { front: m[0], body: text.slice(m[0].length) } : { front: '', body: text };
}

/** A generated file with a kept Notes tail: the head is the server's, the tail is ours. */
export function splitNotes(text: string): { head: string; tail: string } | null {
  const i = text.indexOf(NOTES_MARKER);
  if (i < 0) return null;
  const head = text.slice(0, i + NOTES_MARKER.length);
  return { head, tail: text.slice(head.length) };
}

/** A file the server regenerates wholesale (`_Generated from … — edits are overwritten …_`). */
export function generatedNote(text: string): string | null {
  if (text.includes(NOTES_MARKER)) return null;
  const m = /^_Generated from ([^\n]*?) and kept current — edits are overwritten[^\n]*_\s*$/m.exec(text.slice(0, 1200));
  return m ? `Generated from ${m[1]} — the server rewrites it when that changes, so edits here are overwritten.` : null;
}

/** Flip the task checkbox on source line `line` (0-based, as parseBlocks counts). */
export function toggleTaskLine(text: string, line: number, checked: boolean): string | null {
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(lines[line] ?? '');
  if (!m) return null;
  lines[line] = `${m[1]}${checked ? 'x' : ' '}${m[3]}`;
  const out = lines.join('\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

