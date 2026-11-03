/** Foundry helpers (docs/foundry.md §8): tier and role words, the class mix
 *  of an interface's operations, and error text from the API. Pure. */
import type { PluginFilter } from './market';

export const TIER_LABEL: Record<string, string> = { first_party: 'First party', verified: 'Verified', community: 'Community', local: 'Local' };
export const TIER_TONE: Record<string, string> = { first_party: 'var(--accent-hi)', verified: 'var(--blue)', community: 'var(--amber)', local: 'var(--text-dim)' };
export const TIER_BLURB: Record<string, string> = {
  first_party: 'Made and signed by yaam',
  verified: "Signed by a publisher's key bound to its domain",
  community: 'Scanned and reviewed by the registry; installs only with your opt-in',
  local: 'Loaded by you into this workspace only',
};

/** Action classes from least to most consequential. */
export const CLASS_ORDER = ['read', 'internal_write', 'external_reversible', 'external_irreversible', 'money'];

export function classMix(ops: Array<{ effectiveClass: string }>): Array<{ cls: string; count: number }> {
  const n = new Map<string, number>();
  for (const o of ops) n.set(o.effectiveClass, (n.get(o.effectiveClass) ?? 0) + 1);
  return [...n.entries()].map(([cls, count]) => ({ cls, count })).sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls));
}

export function roleLabel(r: string): string {
  return r === 'interface' ? 'Interface' : r === 'provider' ? 'Provider' : r === 'consumer' ? 'Consumer' : r;
}

export function pluginKindLabel(f: PluginFilter): string {
  return ({ '': 'All', interface: 'Interfaces', provider: 'Providers', consumer: 'Consumers', connectors: 'Connectors', skills: 'Skills & apps' } as const)[f];
}

/** "version 1.0.0 was recalled: why" → "Version 1.0.0 was recalled: why." */
export function recallSentence(notice: string): string {
  const t = notice.trim();
  if (!t) return 'Its version was recalled.';
  return `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}

/** The message (and blockers) of an API error, as one line. */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /"message":"([^"]+)"/.exec(msg);
  const b = /"blockers":\[([^\]]*)\]/.exec(msg);
  return [m?.[1] ?? msg.slice(0, 200), b?.[1]?.replace(/"/g, '')].filter(Boolean).join(' — ');
}

/**
 * A picked folder as `{ relative path: text }`, the shape the plugin loader
 * takes (`source.files`, with `plugin.json` among them). The browser names
 * each file `folder/sub/file`; the top folder is dropped. Hidden files are
 * skipped, as the server loader skips them. Every file is read as text: the
 * server refuses scripts and binaries by name, so nothing here filters them.
 */
export async function folderFiles(files: Array<{ name: string; webkitRelativePath?: string; text: () => Promise<string> }>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).split('/');
    const path = (rel.length > 1 ? rel.slice(1) : rel).join('/');
    if (!path || path.split('/').some((seg) => seg.startsWith('.'))) continue;
    out[path] = await f.text();
  }
  return out;
}
