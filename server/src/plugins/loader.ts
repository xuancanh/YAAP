/**
 * The plugin loader (docs/plugins.md §3.2, §6.1 step 1): turns a folder (a
 * first-party plugin shipped in the repository under `plugins/first-party/`)
 * or an inline package (`@local` in developer mode) into a validated
 * package. Nothing is executed and nothing is installed here.
 *
 * Archive rules: no symlinks, no path that escapes, no executable bit, no
 * script or binary by extension, no `package.json` with scripts; a 5 MB
 * package cap, 256 KB per manifest and interface data file, 64 KB per
 * skill. Only files the manifest references load; anything else is listed
 * as a warning. Referenced data files (conformance suites, fixtures) are
 * parsed and validated strictly.
 */
import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalJson, sha256 } from '../actions/action-classes';
import { validateFixtures, validateManifest, validateSuite, type Fixtures, type Manifest, type Suite } from './manifest';

export const PACKAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DATA_FILE_MAX_BYTES = 256 * 1024;
export const SKILL_MAX_BYTES = 64 * 1024;

const SCRIPT_EXT_RE = /\.(sh|bash|zsh|ps1|bat|cmd|exe|dll|so|dylib|bin|py|rb|pl|js|mjs|cjs|ts|wasm|node|jar|class)$/i;

export class PluginLoadError extends Error {
  constructor(readonly errors: string[], readonly warnings: string[] = []) {
    super(errors.join('; '));
  }
}

export interface PluginPackage {
  manifest: Manifest;
  /** Referenced text files by relative path. */
  files: Record<string, string>;
  suites: Record<string, Suite>;
  fixtures: Record<string, Fixtures>;
  warnings: string[];
  /** sha256 over the canonical manifest and every referenced file. */
  digest: string;
  manifestHash: string;
}

/** Every file a manifest references (relative paths). */
export function referencedFiles(m: Manifest): { suites: string[]; fixtures: string[]; text: string[] } {
  const suites = new Set<string>(), fixtures = new Set<string>(), text = new Set<string>();
  for (const i of m.interfaces ?? []) {
    suites.add(i.conformance);
    for (const s of [...(i.skills ?? []), ...(i.playbooks ?? [])]) text.add(s);
  }
  for (const p of m.provides ?? []) {
    for (const impl of Object.values(p.operations)) if ('fixture' in impl) fixtures.add(impl.fixture);
  }
  for (const t of m.tools?.items ?? []) if ('fixture' in t.impl) fixtures.add(t.impl.fixture);
  for (const s of [...(m.skills ?? []), ...(m.rolePacks ?? []), ...(m.playbooks ?? [])]) text.add(s);
  return { suites: [...suites], fixtures: [...fixtures], text: [...text] };
}

function checkPath(p: string): string | null {
  if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) return `${p}: escapes the plugin folder`;
  if (SCRIPT_EXT_RE.test(p)) return `${p}: scripts and binaries are refused`;
  return null;
}

/** Build a package from a manifest and its files (the inline / `@local` form). */
export function packageFrom(rawManifest: unknown, files: Record<string, string>, extraWarnings: string[] = [], manifestBytes?: number): PluginPackage {
  const errors: string[] = [];
  const warnings = [...extraWarnings];
  let total = manifestBytes ?? JSON.stringify(rawManifest ?? null).length;
  for (const [p, body] of Object.entries(files)) {
    const bad = checkPath(p);
    if (bad) errors.push(bad);
    if (typeof body !== 'string') { errors.push(`${p}: must be text`); continue; }
    total += Buffer.byteLength(body, 'utf8');
    if (p === 'package.json' || p.endsWith('/package.json')) {
      try {
        const pkg = JSON.parse(body) as Record<string, unknown>;
        if (pkg.scripts && Object.keys(pkg.scripts as object).length > 0) errors.push(`${p}: package scripts are refused (nothing runs at install)`);
      } catch { errors.push(`${p}: not JSON`); }
    }
  }
  if (total > PACKAGE_MAX_BYTES) errors.push(`the package is ${total} bytes; the cap is ${PACKAGE_MAX_BYTES}`);
  const v = validateManifest(rawManifest, manifestBytes);
  warnings.push(...v.warnings);
  if (!v.ok) throw new PluginLoadError([...errors, ...v.errors], warnings);
  if (errors.length > 0) throw new PluginLoadError(errors, warnings);
  const m = v.manifest;
  const refs = referencedFiles(m);
  const kept: Record<string, string> = {};
  const suites: Record<string, Suite> = {};
  const fixtures: Record<string, Fixtures> = {};
  const need = (p: string, cap: number): string | null => {
    const body = files[p];
    if (body === undefined) { errors.push(`${p}: referenced by the manifest but missing`); return null; }
    if (Buffer.byteLength(body, 'utf8') > cap) { errors.push(`${p}: larger than ${cap} bytes`); return null; }
    kept[p] = body;
    return body;
  };
  for (const p of refs.suites) {
    const body = need(p, DATA_FILE_MAX_BYTES);
    if (body === null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { errors.push(`${p}: not JSON`); continue; }
    const s = validateSuite(parsed);
    if (!s.ok) errors.push(...s.errors.map((e) => `${p}: ${e}`)); else suites[p] = s.suite;
  }
  for (const p of refs.fixtures) {
    const body = need(p, DATA_FILE_MAX_BYTES);
    if (body === null) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { errors.push(`${p}: not JSON`); continue; }
    const f = validateFixtures(parsed);
    if (!f.ok) errors.push(...f.errors.map((e) => `${p}: ${e}`)); else fixtures[p] = f.fixtures;
  }
  for (const p of refs.text) need(p, SKILL_MAX_BYTES);
  for (const p of Object.keys(files)) if (!(p in kept) && p !== 'plugin.json' && !/^(README|CHANGELOG)\.md$|^icon\.svg$|^LICENSE/i.test(p)) warnings.push(`${p}: not referenced by the manifest (not loaded)`);
  if (errors.length > 0) throw new PluginLoadError(errors, warnings);
  const manifestHash = sha256(canonicalJson(m));
  const digest = sha256(canonicalJson({ manifest: m, files: kept }));
  return { manifest: m, files: kept, suites, fixtures, warnings, digest, manifestHash };
}

/** Load a plugin folder from disk, enforcing the archive rules on every entry. */
export async function loadPluginFolder(dir: string): Promise<PluginPackage> {
  const root = resolve(dir);
  const errors: string[] = [];
  const files: Record<string, string> = {};
  let total = 0;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 8) { errors.push(`${relative(root, d)}: nested too deep`); return; }
    for (const ent of await fs.readdir(d, { withFileTypes: true })) {
      const abs = join(d, ent.name);
      const rel = relative(root, abs).split(sep).join('/');
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) { errors.push(`${rel}: symlinks are refused`); continue; }
      if (st.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!st.isFile()) { errors.push(`${rel}: not a regular file`); continue; }
      if ((st.mode & 0o111) !== 0) { errors.push(`${rel}: an executable bit is refused`); continue; }
      total += st.size;
      if (total > PACKAGE_MAX_BYTES) { errors.push(`the package is over ${PACKAGE_MAX_BYTES} bytes`); return; }
      if (ent.name.startsWith('.')) continue;
      files[rel] = await fs.readFile(abs, 'utf8');
    }
  };
  await walk(root, 0);
  if (errors.length > 0) throw new PluginLoadError(errors);
  const rawText = files['plugin.json'];
  if (rawText === undefined) throw new PluginLoadError([`${dir}: no plugin.json`]);
  let raw: unknown;
  try { raw = JSON.parse(rawText); } catch { throw new PluginLoadError(['plugin.json: not JSON']); }
  const rest = { ...files };
  delete rest['plugin.json'];
  return packageFrom(raw, rest, [], Buffer.byteLength(rawText, 'utf8'));
}

/** Where first-party plugins live: `YAAM_PLUGINS_DIR` or `plugins/first-party` under the working directory. */
export function firstPartyDir(): string {
  return resolve(process.env.YAAM_PLUGINS_DIR || join(process.cwd(), 'plugins', 'first-party'));
}

/** The first-party catalog: every folder with a plugin.json, by plugin id. */
export async function loadFirstParty(dir = firstPartyDir()): Promise<Map<string, PluginPackage>> {
  const out = new Map<string, PluginPackage>();
  let entries: string[];
  try { entries = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return out; }
  for (const name of entries) {
    const pkg = await loadPluginFolder(join(dir, name));
    if (!pkg.manifest.id.endsWith('@yaam')) throw new PluginLoadError([`${name}: first-party plugins are @yaam`]);
    out.set(pkg.manifest.id, pkg);
  }
  return out;
}
