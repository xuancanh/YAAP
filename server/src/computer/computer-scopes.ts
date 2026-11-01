/**
 * Computer-control scopes (docs/computer-control.md §3) — the pure half of
 * the model, shared by the service (server-side check before an action is
 * queued) and the tests. The companion carries an equivalent copy and checks
 * again locally: two independent gates, neither trusting the other.
 *
 *   screen            computer_screenshot
 *   input             computer_click / _type / _key / _move / _scroll
 *   shell             computer_shell
 *   files:<abs dir>   computer_read_file / _write_file / _list_dir under <dir>
 *
 * Scopes are chosen on the companion at pair time and can only be narrowed
 * afterwards (`isNarrowing`): the server never grants itself more than the
 * machine's owner typed at the keyboard.
 */

export const COMPUTER_TOOLS = [
  'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_move', 'computer_scroll',
  'computer_shell', 'computer_read_file', 'computer_write_file', 'computer_list_dir',
] as const;
export type ComputerTool = typeof COMPUTER_TOOLS[number];

export type ScopeKind = 'screen' | 'input' | 'shell' | 'files';

/** Which scope kind each tool needs. */
export const TOOL_SCOPE: Record<ComputerTool, ScopeKind> = {
  computer_screenshot: 'screen',
  computer_click: 'input', computer_type: 'input', computer_key: 'input', computer_move: 'input', computer_scroll: 'input',
  computer_shell: 'shell',
  computer_read_file: 'files', computer_write_file: 'files', computer_list_dir: 'files',
};

/** Tools a chat may remember an approval for ("always allow"): the
 *  observational ones. Anything that acts — click, type, key, shell, write —
 *  asks on every call, in every mode (docs/computer-control.md §4). */
export const REMEMBERABLE_COMPUTER_TOOLS = new Set<string>([
  'computer_screenshot', 'computer_move', 'computer_scroll', 'computer_list_dir', 'computer_read_file',
]);

export function isComputerTool(name: string): name is ComputerTool {
  return (COMPUTER_TOOLS as readonly string[]).includes(name);
}

/** Forward slashes, no trailing slash (except a bare root), Windows drive
 *  letters upper-cased, "." and ".." collapsed. Purely lexical — the
 *  companion does the realpath. */
export function normalizeDir(p: string): string {
  let s = p.trim().replace(/\\/g, '/');
  if (/^[a-z]:\//.test(s)) s = s[0].toUpperCase() + s.slice(1);
  const abs = s.startsWith('/');
  const drive = /^[A-Z]:\//.exec(s)?.[0] ?? '';
  const rest = s.slice(drive.length);
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  const joined = out.join('/');
  if (drive) return drive + joined;
  return (abs ? '/' : '') + joined;
}

export function isAbsoluteDir(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Validate and canonicalise a scope list. Throws on anything unknown, a
 *  relative files root, a whole-drive root, or an empty set. */
export function parseScopes(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('scopes must be an array of strings');
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new Error('scopes must be strings');
    const s = item.trim();
    if (s === 'screen' || s === 'input' || s === 'shell') { out.add(s); continue; }
    if (s.startsWith('files:')) {
      const dir = s.slice('files:'.length);
      if (!dir || !isAbsoluteDir(dir)) throw new Error(`files scope needs an absolute directory: "${s}"`);
      const norm = normalizeDir(dir);
      if (!norm || norm === '/' || /^[A-Z]:\/?$/.test(norm)) {
        throw new Error(`files scope must not be a whole drive or the filesystem root: "${s}"`);
      }
      out.add(`files:${norm}`);
      continue;
    }
    throw new Error(`unknown scope "${s}" (expected screen, input, shell, files:<absolute dir>)`);
  }
  if (out.size === 0) throw new Error('at least one scope is required');
  return [...out];
}

export function fileRoots(scopes: string[]): string[] {
  return scopes.filter((s) => s.startsWith('files:')).map((s) => s.slice('files:'.length));
}

/** True when `path` (absolute) is `root` or inside it, lexically. */
export function pathWithinRoot(path: string, root: string): boolean {
  const p = normalizeDir(path);
  const r = normalizeDir(root);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/** Is `next` a subset of `current`? A files root may shrink to one of its
 *  sub-directories; nothing may appear that was not there before. */
export function isNarrowing(current: string[], next: string[]): boolean {
  const curRoots = fileRoots(current);
  for (const s of next) {
    if (s.startsWith('files:')) {
      if (!curRoots.some((r) => pathWithinRoot(s.slice('files:'.length), r))) return false;
    } else if (!current.includes(s)) {
      return false;
    }
  }
  return true;
}

/** The one check every action passes before it is queued: does this scope
 *  set allow this tool with this input? Returns null when allowed, else the
 *  reason. */
export function scopeDenial(scopes: string[], tool: string, input: Record<string, unknown>): string | null {
  if (!isComputerTool(tool)) return `unknown computer tool: ${tool}`;
  const kind = TOOL_SCOPE[tool];
  if (kind === 'files') {
    const roots = fileRoots(scopes);
    if (roots.length === 0) return 'the companion was paired without any files:<dir> scope';
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    if (!path || !isAbsoluteDir(path)) return '"path" must be an absolute path';
    if (!roots.some((r) => pathWithinRoot(path, r))) return `path is outside the allowed roots (${roots.join(', ')})`;
    return null;
  }
  if (kind === 'shell') {
    if (!scopes.includes('shell')) return 'the companion was paired without the shell scope';
    const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (cwd && !isAbsoluteDir(cwd)) return '"cwd" must be an absolute path';
    return null;
  }
  return scopes.includes(kind) ? null : `the companion was paired without the ${kind} scope`;
}

/** One line for the audit table and the tool card: the target, never the
 *  full typed text or file content (they may hold secrets). */
export function summarizeInput(tool: string, input: Record<string, unknown>): string {
  const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const s = (v: unknown, n = 120) => text(v).replace(/\s+/g, ' ').slice(0, n);
  switch (tool) {
    case 'computer_screenshot': return 'screenshot';
    case 'computer_click': return `click ${s(input.button ?? 'left')}${input.double ? ' ×2' : ''} at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_move': return `move to (${s(input.x)}, ${s(input.y)})`;
    case 'computer_scroll': return `scroll (${s(input.dx)}, ${s(input.dy)}) at (${s(input.x)}, ${s(input.y)})`;
    case 'computer_type': return `type ${text(input.text).length} chars`;
    case 'computer_key': return `key ${s(input.combo, 40)}`;
    case 'computer_shell': return `$ ${s(input.command, 160)}${input.cwd ? ` (in ${s(input.cwd, 60)})` : ''}`;
    case 'computer_read_file': return `read ${s(input.path, 160)}`;
    case 'computer_write_file': return `write ${s(input.path, 160)} (${text(input.content).length} chars)`;
    case 'computer_list_dir': return `list ${s(input.path, 160)}`;
    default: return s(JSON.stringify(input), 160);
  }
}
