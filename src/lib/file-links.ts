/** Workspace file paths written in text (docs/filesystem.md): agents name
 *  files like `/org/marketing/waitlist/GO-LIVE.md`; the chat draws them as
 *  links that open the file in the side panel (ArtifactPanel). Pure, plus
 *  one window event the store answers (it knows the workspace). */

/** The top-level folders of the workspace tree a path may start with. */
const ROOTS = ['org', 'agents', 'channels', 'uploads', 'archive'];
const PATH_BODY = `(?:${ROOTS.join('|')})\\/[^\\s<>()\\[\\]"'\`]*[^\\s<>()\\[\\]"'\`.,;:!?]\\.[A-Za-z0-9]{1,8}`;
const EXACT = new RegExp(`^\\/?${PATH_BODY}$`);

/** A bare path in running text: it must start with `/` and end in a file extension. */
export const FILE_PATH_SOURCE = `(?<![\\w/.:-])\\/${PATH_BODY}(?![\\w/])`;

/** The workspace path (no leading slash) when `raw` names a file in the tree, else null. */
export function filePathOf(raw: string): string | null {
  const s = raw.trim();
  if (!EXACT.test(s) || s.includes('..')) return null;
  return s.replace(/^\//, '');
}

export const FILE_EVENT = 'yaam:open-file';
export interface FileEventDetail { path: string }

/** Ask the app to show `path` (a workspace path) in the side panel. */
export function openFileInPanel(path: string): void {
  window.dispatchEvent(new CustomEvent<FileEventDetail>(FILE_EVENT, { detail: { path } }));
}
