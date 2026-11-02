/**
 * Coding-harness settings (docs/coding-harnesses.md §4): one record per
 * harness, stored as one JSON row in app_settings (`harness.config`,
 * account-scoped like every setting). The API key is sealed with secretbox
 * at rest and never leaves the server: the SPA sees `hasApiKey` only.
 *
 * Pure: defaults, validation of a patch from the settings API, and the
 * redacted view. No I/O here.
 */
import { open, seal } from '../common/secretbox';

export const HARNESS_IDS = ['claude_code', 'codex', 'pi', 'deepseek'] as const;
export type HarnessId = typeof HARNESS_IDS[number];

export function isHarnessId(x: unknown): x is HarnessId {
  return typeof x === 'string' && (HARNESS_IDS as readonly string[]).includes(x);
}

/** How much the harness may do inside its run directory, mapped to each
 *  CLI's own flags (harness-commands.ts):
 *   read_only  read and search files only
 *   edit       read and edit files, no shell
 *   full       files and a shell (the CLI's own sandbox where it has one) */
export const HARNESS_MODES = ['read_only', 'edit', 'full'] as const;
export type HarnessMode = typeof HARNESS_MODES[number];

/** Pi's built-in providers this pane offers, with the env var each reads
 *  (pi docs/providers.md). */
export const PI_PROVIDERS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

export interface HarnessConfig {
  enabled: boolean;
  /** Absolute path to the CLI; '' = look it up on PATH. */
  binaryPath: string;
  /** api_key: the key below, and an isolated CLI home per run.
   *  cli_login: the CLI's own login on this machine (its real config dir). */
  auth: 'api_key' | 'cli_login';
  /** Sealed (secretbox) at rest; '' when none. */
  apiKey: string;
  /** Custom endpoint: DeepSeek's Anthropic-compatible URL, an
   *  OpenAI-compatible provider for Codex / Pi. '' = the CLI's default. */
  baseUrl: string;
  /** Pi only: which built-in provider the model is looked up in. */
  provider: string;
  model: string;
  maxTurns: number;
  timeoutS: number;
  /** USD per run; 0 = no cap. */
  costCapUsd: number;
  mode: HarnessMode;
  /** Wrap the CLI in the OS sandbox (Seatbelt / bubblewrap): writes jailed
   *  to the run directory, network kept (the CLI must reach its model). */
  osSandbox: boolean;
  /** Which agents may use it: every agent, or the listed agent ids. */
  agents: 'all' | string[];
  /** Agents whose code_agent calls run without approval (the owner's
   *  explicit opt-in; docs/coding-harnesses.md §5). Empty by default. */
  freeAgents: string[];
}

export type HarnessSettings = Record<HarnessId, HarnessConfig>;

export const DEEPSEEK_ANTHROPIC_URL = 'https://api.deepseek.com/anthropic';

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
  deepseek: 'DeepSeek (via Claude Code)',
};

/** The executable each harness runs; DeepSeek drives the Claude Code CLI
 *  against DeepSeek's Anthropic-compatible endpoint. */
export const HARNESS_BINARY: Record<HarnessId, string> = {
  claude_code: 'claude', codex: 'codex', pi: 'pi', deepseek: 'claude',
};

export const LIMITS = {
  maxTurns: { min: 1, max: 200, def: 30 },
  timeoutS: { min: 30, max: 3600, def: 900 },
  costCapUsd: { min: 0, max: 100, def: 2 },
} as const;

export function defaultConfig(id: HarnessId): HarnessConfig {
  return {
    enabled: false,
    binaryPath: '',
    auth: 'api_key',
    apiKey: '',
    baseUrl: id === 'deepseek' ? DEEPSEEK_ANTHROPIC_URL : '',
    provider: id === 'pi' ? 'anthropic' : '',
    model: id === 'deepseek' ? 'deepseek-v4-pro' : '',
    maxTurns: LIMITS.maxTurns.def,
    timeoutS: LIMITS.timeoutS.def,
    costCapUsd: LIMITS.costCapUsd.def,
    mode: 'edit',
    osSandbox: true,
    agents: 'all',
    freeAgents: [],
  };
}

export function defaultSettings(): HarnessSettings {
  return Object.fromEntries(HARNESS_IDS.map((id) => [id, defaultConfig(id)])) as HarnessSettings;
}

/** A model id: no leading dash (it would read as a flag), no whitespace or
 *  shell-ish characters. Brackets allow DeepSeek's `[1m]` suffix. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/;
export function validModelName(s: string): boolean {
  return NAME_RE.test(s);
}

export class HarnessConfigError extends Error {}

/** Parse the stored row, tolerating anything: unknown fields drop, a
 *  corrupt harness keeps its defaults. */
export function parseSettings(raw: string | null | undefined): HarnessSettings {
  const out = defaultSettings();
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const id of HARNESS_IDS) {
    const row = (parsed as Record<string, unknown>)[id];
    if (!row || typeof row !== 'object') continue;
    try {
      out[id] = applyPatch(id, out[id], row as Record<string, unknown>, { stored: true });
    } catch { /* keeps its defaults */ }
  }
  return out;
}

function num(v: unknown, lim: { min: number; max: number }, field: string): number {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' || !Number.isFinite(n) || n < lim.min || n > lim.max) {
    throw new HarnessConfigError(`${field} must be a number from ${lim.min} to ${lim.max}`);
  }
  return n;
}

function idList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !/^[\w-]{1,64}$/.test(x))) throw new HarnessConfigError(`${field} must be a list of agent ids`);
  return [...new Set(v as string[])].slice(0, 500);
}

/**
 * Apply a settings patch to one harness. Strict: an invalid field throws
 * HarnessConfigError (the API answers 400) rather than being dropped. The
 * API key arrives in clear (`apiKey`; '' clears it) and is sealed here;
 * `stored` reads a stored row back (its key is already sealed).
 */
export function applyPatch(id: HarnessId, current: HarnessConfig, patch: Record<string, unknown>, opts: { stored?: boolean } = {}): HarnessConfig {
  const next: HarnessConfig = { ...current };
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new HarnessConfigError('enabled must be true or false');
    next.enabled = patch.enabled;
  }
  if ('binaryPath' in patch) {
    const p = String(patch.binaryPath ?? '').trim();
    if (p && (!p.startsWith('/') || p.includes('\0') || p.length > 500)) throw new HarnessConfigError('binaryPath must be an absolute path to the executable');
    next.binaryPath = p;
  }
  if ('auth' in patch) {
    if (patch.auth !== 'api_key' && patch.auth !== 'cli_login') throw new HarnessConfigError('auth must be api_key or cli_login');
    if (patch.auth === 'cli_login' && id === 'deepseek') throw new HarnessConfigError('DeepSeek needs an API key — the Claude Code login is for Anthropic');
    next.auth = patch.auth;
  }
  if ('apiKey' in patch) {
    const k = String(patch.apiKey ?? '').trim();
    if (opts.stored) next.apiKey = k;
    else {
      if (k.length > 500 || /\s/.test(k)) throw new HarnessConfigError('apiKey looks malformed');
      next.apiKey = k ? seal(k) : '';
    }
  }
  if ('baseUrl' in patch) {
    const u = String(patch.baseUrl ?? '').trim();
    if (u) {
      let url: URL;
      try { url = new URL(u); } catch { throw new HarnessConfigError('baseUrl must be a URL'); }
      const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new HarnessConfigError('baseUrl must be https (http only for localhost)');
      if (url.username || url.password) throw new HarnessConfigError('baseUrl must not carry credentials — use the API key field');
    }
    next.baseUrl = u.replace(/\/+$/, '');
  }
  if ('provider' in patch) {
    const p = String(patch.provider ?? '');
    if (p && !(p in PI_PROVIDERS)) throw new HarnessConfigError(`provider must be one of ${Object.keys(PI_PROVIDERS).join(', ')}`);
    next.provider = p;
  }
  if ('model' in patch) {
    const m = String(patch.model ?? '').trim();
    if (m && !validModelName(m)) throw new HarnessConfigError('model must be a plain model id');
    next.model = m;
  }
  if ('maxTurns' in patch) next.maxTurns = Math.floor(num(patch.maxTurns, LIMITS.maxTurns, 'maxTurns'));
  if ('timeoutS' in patch) next.timeoutS = Math.floor(num(patch.timeoutS, LIMITS.timeoutS, 'timeoutS'));
  if ('costCapUsd' in patch) next.costCapUsd = num(patch.costCapUsd, LIMITS.costCapUsd, 'costCapUsd');
  if ('mode' in patch) {
    if (!(HARNESS_MODES as readonly unknown[]).includes(patch.mode)) throw new HarnessConfigError(`mode must be one of ${HARNESS_MODES.join(', ')}`);
    next.mode = patch.mode as HarnessMode;
  }
  if ('osSandbox' in patch) {
    if (typeof patch.osSandbox !== 'boolean') throw new HarnessConfigError('osSandbox must be true or false');
    next.osSandbox = patch.osSandbox;
  }
  if ('agents' in patch) next.agents = patch.agents === 'all' ? 'all' : idList(patch.agents, 'agents');
  if ('freeAgents' in patch) next.freeAgents = idList(patch.freeAgents, 'freeAgents');
  return next;
}

/** The view the SPA gets: no key material, only whether one is stored. */
export type RedactedHarnessConfig = Omit<HarnessConfig, 'apiKey'> & { hasApiKey: boolean };

export function redact(cfg: HarnessConfig): RedactedHarnessConfig {
  const { apiKey, ...rest } = cfg;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/** The clear key for a run ('' when none or unreadable). */
export function openKey(cfg: HarnessConfig): string {
  if (!cfg.apiKey) return '';
  try { return open(cfg.apiKey); } catch { return ''; }
}

/** Whether an agent may use a harness. */
export function agentAllowed(cfg: HarnessConfig, agentId: string): boolean {
  return cfg.agents === 'all' || cfg.agents.includes(agentId);
}
