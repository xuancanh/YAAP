/**
 * Scopes on the companion side. The server already checked the action
 * against the scopes it holds; this file checks AGAIN, against the scopes the
 * owner typed at pairing, with real filesystem resolution (symlinks) that
 * only this machine can do. Neither side trusts the other to have done it.
 *
 *   screen            computer_screenshot
 *   input             computer_click / _type / _key / _move / _scroll
 *   shell             computer_shell
 *   files:<abs dir>   computer_read_file / _write_file / _list_dir under <dir>
 */
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export type ScopeKind = 'screen' | 'input' | 'shell' | 'files';

export const TOOL_SCOPE: Record<string, ScopeKind> = {
  computer_screenshot: 'screen',
  computer_click: 'input', computer_type: 'input', computer_key: 'input', computer_move: 'input', computer_scroll: 'input',
  computer_shell: 'shell',
  computer_read_file: 'files', computer_write_file: 'files', computer_list_dir: 'files',
};

/** `--scopes screen,input,files:/a,files:/b` → canonical list. Throws on
 *  anything unknown, relative, or a whole drive / the root. */
export function parseScopes(raw: string | string[]): string[] {
  const items = Array.isArray(raw) ? raw : splitScopeArg(raw);
  const out = new Set<string>();
  for (const item of items) {
    const s = item.trim();
    if (!s) continue;
    if (s === 'screen' || s === 'input' || s === 'shell') { out.add(s); continue; }
    if (s.startsWith('files:')) {
      const dir = s.slice('files:'.length).trim();
      if (!dir || !path.isAbsolute(dir)) throw new Error(`files scope needs an absolute directory: "${s}"`);
      const norm = path.resolve(dir);
      if (norm === path.parse(norm).root) throw new Error(`files scope must not be a whole drive or the filesystem root: "${s}"`);
      out.add(`files:${norm}`);
      continue;
    }
    throw new Error(`unknown scope "${s}" (expected screen, input, shell, files:<absolute dir>)`);
  }
  if (out.size === 0) throw new Error('at least one scope is required');
  return [...out];
}

/** Commas separate scopes — but a Windows path like C:\Users is one scope,
 *  so split on commas that precede a scope word or "files:". */
function splitScopeArg(raw: string): string[] {
  return raw.split(/,(?=\s*(?:screen|input|shell|files:))/i);
}

export function fileRoots(scopes: string[]): string[] {
  return scopes.filter((s) => s.startsWith('files:')).map((s) => s.slice('files:'.length));
}

/** Is every scope in `next` covered by `current`? Roots may shrink. */
export function isSubset(current: string[], next: string[]): boolean {
  const roots = fileRoots(current);
  return next.every((s) => (s.startsWith('files:')
    ? roots.some((r) => lexicallyWithin(s.slice('files:'.length), r))
    : current.includes(s)));
}

export function lexicallyWithin(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The fast, lexical check for non-file tools (and the first gate for file
 *  tools before the filesystem is touched). Null = allowed. */
export function scopeDenial(scopes: string[], tool: string): string | null {
  const kind = TOOL_SCOPE[tool];
  if (!kind) return `unknown tool: ${tool}`;
  if (kind === 'files') return fileRoots(scopes).length > 0 ? null : 'no files:<dir> scope was granted at pairing';
  return scopes.includes(kind) ? null : `the ${kind} scope was not granted at pairing`;
}

/**
 * Resolve a path the agent asked for to a real on-disk path that is inside
 * one of the granted roots — following every symlink — or throw.
 *
 *  - roots are realpath'd too (on macOS /tmp is a symlink to /private/tmp);
 *  - an existing target is realpath'd and must land inside a root, so a
 *    symlink in a granted folder that points at ~/.ssh is refused;
 *  - for a path that does not exist yet (a new file to write) the PARENT
 *    must exist, realpath inside a root, and the final name must not itself
 *    be a symlink (a dangling one could be made to point anywhere later).
 */
export async function resolveInRoots(requested: string, roots: string[], opts: { mustExist: boolean }): Promise<string> {
  if (!requested || !path.isAbsolute(requested)) throw new Error('path must be absolute');
  const realRoots = await Promise.all(roots.map(async (r) => realpath(r).catch(() => path.resolve(r))));
  const inside = (p: string) => realRoots.some((r) => lexicallyWithin(p, r));
  const lexical = path.resolve(requested);
  // First gate, before touching the disk: the path as written must sit under
  // a root as written or as resolved (a root may itself be a symlink).
  if (!inside(lexical) && !roots.some((r) => lexicallyWithin(lexical, r))) {
    throw new Error(`path is outside the granted folders (${roots.join(', ')})`);
  }
  const st = await lstat(lexical).catch(() => null);
  if (st) {
    const real = await realpath(lexical);
    if (!inside(real)) throw new Error(`path resolves (through a symlink) to ${real}, outside the granted folders`);
    return real;
  }
  if (opts.mustExist) throw new Error(`no such file or directory: ${requested}`);
  const parentReal = await realpath(path.dirname(lexical)).catch(() => { throw new Error(`parent directory does not exist: ${path.dirname(requested)}`); });
  if (!inside(parentReal)) throw new Error(`parent directory resolves to ${parentReal}, outside the granted folders`);
  return path.join(parentReal, path.basename(lexical));
}
