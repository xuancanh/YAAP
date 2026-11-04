/**
 * agentskills.io SKILL.md — parse, scan, render (execution-plan item 9.3).
 *
 * The open format (https://agentskills.io/specification): YAML frontmatter
 * with `name` (1-64 chars, lowercase alphanumerics and single hyphens, no
 * leading/trailing hyphen), `description` (1-1024 chars), and optional
 * `license`, `compatibility`, `metadata` (string → string map) and
 * `allowed-tools` (a space-separated string, experimental); the Markdown body
 * is the instructions, with no format restrictions.
 *
 * A skill is text the model will later follow, i.e. a persistent prompt
 * (docs/permissions.md "Skills"). An imported one was written by someone we
 * do not know, so before it can even become a draft it goes through a scan
 * that is deliberately dumb and loud: it does not decide, it flags, and the
 * review card shows every flag beside the full body. Only the user enables.
 */

export interface ParsedSkillMd {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools: string[];
  metadata: Record<string, string>;
  /** The Markdown body after the frontmatter — the instructions. */
  body: string;
}

export type ScanFlagKind =
  | 'size'
  | 'urls'
  | 'instruction-smell'
  | 'secrets'
  | 'base64'
  | 'invisible-unicode'
  | 'foreign-tools'
  | 'frontmatter'
  /* registry/app-scan.ts — mini-app HTML flags */
  | 'network'
  | 'capabilities'
  | 'embed';

export interface ScanFlag {
  kind: ScanFlagKind;
  /** Human-readable, shown verbatim on the review card. */
  detail: string;
  /** warn = look before enabling; block = refused at import. */
  severity: 'warn' | 'block';
}

export interface ScanReport {
  bytes: number;
  lines: number;
  urls: string[];
  flags: ScanFlag[];
  /** False when any flag blocks the import. */
  ok: boolean;
  scannedAt: string;
}

export const SKILL_MD_SIZE_CAP = 64 * 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const URL_RE = /\bhttps?:\/\/[^\s)>\]"']+/gi;
/** Phrases that read as an attempt to steer the agent against its user. */
const SMELLS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|earlier|above) (instructions|rules|guidance)/i, '"ignore previous instructions"'],
  [/disregard (your|the) (system prompt|instructions|rules)/i, '"disregard the system prompt"'],
  [/do not (tell|inform|mention|reveal|show)( this)? (to )?the user/i, '"do not tell the user"'],
  [/without (telling|informing|asking) the user/i, '"without telling the user"'],
  [/(hide|conceal) (this|it|these steps) from the user/i, '"hide this from the user"'],
  [/you are now|new persona|act as (an? )?(unrestricted|jailbroken)/i, 'persona override'],
  [/(exfiltrate|send|post|upload) .{0,40}(credentials|secrets|tokens|passwords|keys)/i, 'sending credentials elsewhere'],
];
const SECRET_HINTS: Array<[RegExp, string]> = [
  [/\.env\b/i, '.env file'],
  [/\b(api[_ -]?keys?|secret[_ -]?keys?|access[_ -]?tokens?|private[_ -]?keys?)\b/i, 'API keys / tokens'],
  [/\b(password|passwd|credentials?)\b/i, 'passwords / credentials'],
  [/~\/\.(ssh|aws|config\/gcloud|kube)/i, '~/.ssh, ~/.aws or similar'],
  [/\b(id_rsa|id_ed25519|\.pem|\.p12|keychain)\b/i, 'key material'],
];
/** 80+ chars of base64 alphabet in one run: a payload, not prose. */
const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){20,}={0,2}/g;
/** Zero-width and bidi-control characters; a tag-character block (U+E0000
 *  range) is what "invisible prompt" payloads are written in. */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|\uDB40[\uDC00-\uDFFF]/g;

/** Our own tool vocabulary, as prefixes or exact names, for the
 *  `allowed-tools` check. Anything else is a foreign tool reference the
 *  skill expects and we cannot honour — flagged, not failed. */
export const KNOWN_TOOL_PATTERNS: RegExp[] = [
  /^fs_(list|read|write|delete|search)$/, /^web_(search|fetch)$/, /^slides_create$/, /^http_request$/,
  /^run_(js|python)$/, /^skill_[a-z0-9_]+$/, /^mcp_[a-z0-9_]+$/, /^tool_[a-z0-9_]+$/,
  /^(update_dashboard|save_app|list_tasks|add_task|update_task|save_tool|delegate_task|search_history|draft_skill|revise_skill|update_user_profile)$/,
  /^(calendar|gmail|drive|mail|onedrive)_[a-z0-9_]+$/,
];

/** Minimal YAML subset: `key: value`, quoted or bare scalars, one level of
 *  nested `key:` + indented `  sub: value` (for `metadata`). The spec's
 *  frontmatter never needs more, and pulling a YAML parser in for it would
 *  widen the attack surface this file exists to narrow. */
function parseFrontmatter(text: string): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  let nested: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indented = /^\s+/.test(raw);
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = unquote(rawValue.trim());
    if (indented && nested) {
      (out[nested] as Record<string, string>)[key] = value;
      continue;
    }
    if (value === '') { nested = key; out[key] = {}; continue; }
    nested = null;
    out[key] = value;
  }
  return out;
}

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

export function parseSkillMd(content: string): ParsedSkillMd {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) throw new Error('SKILL.md must start with a YAML frontmatter block (--- … ---)');
  const fm = parseFrontmatter(m[1]);
  const str = (k: string) => (typeof fm[k] === 'string' ? (fm[k] as string) : undefined);
  const name = (str('name') ?? '').trim();
  const description = (str('description') ?? '').trim();
  if (!name) throw new Error('frontmatter is missing `name`');
  if (name.length > 64 || !NAME_RE.test(name)) {
    throw new Error('`name` must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen');
  }
  if (!description) throw new Error('frontmatter is missing `description`');
  const metadata = typeof fm.metadata === 'object' ? (fm.metadata as Record<string, string>) : {};
  return {
    name,
    description: description.slice(0, 1024),
    license: str('license'),
    compatibility: str('compatibility')?.slice(0, 500),
    allowedTools: (str('allowed-tools') ?? '').split(/\s+/).filter(Boolean),
    metadata,
    body: m[2].trim(),
  };
}

/** The scan step. Pure: same input, same report. */
export function scanSkillMd(content: string, parsed: ParsedSkillMd): ScanReport {
  const flags: ScanFlag[] = [];
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > SKILL_MD_SIZE_CAP) {
    flags.push({ kind: 'size', severity: 'block', detail: `${bytes} bytes exceeds the ${SKILL_MD_SIZE_CAP} byte cap` });
  }
  const urls = [...new Set([...content.matchAll(URL_RE)].map((u) => u[0]))];
  if (urls.length > 0) {
    flags.push({ kind: 'urls', severity: 'warn', detail: `${urls.length} URL${urls.length === 1 ? '' : 's'} — the agent may be told to fetch from them` });
  }
  for (const [re, label] of SMELLS) {
    if (re.test(content)) flags.push({ kind: 'instruction-smell', severity: 'warn', detail: `reads like ${label}` });
  }
  for (const [re, label] of SECRET_HINTS) {
    if (re.test(parsed.body)) flags.push({ kind: 'secrets', severity: 'warn', detail: `mentions ${label}` });
  }
  const blobs = content.match(BASE64_RE) ?? [];
  if (blobs.length > 0) {
    flags.push({ kind: 'base64', severity: 'warn', detail: `${blobs.length} base64-looking blob${blobs.length === 1 ? '' : 's'} (${blobs.reduce((n, b) => n + b.length, 0)} chars) — content you cannot read` });
  }
  const invisible = content.match(INVISIBLE_RE) ?? [];
  if (invisible.length > 0) {
    flags.push({ kind: 'invisible-unicode', severity: 'block', detail: `${invisible.length} invisible or bidi-control character${invisible.length === 1 ? '' : 's'} — hidden text is never acceptable in instructions` });
  }
  const foreign = parsed.allowedTools.filter((t) => !KNOWN_TOOL_PATTERNS.some((re) => re.test(t)));
  if (foreign.length > 0) {
    flags.push({ kind: 'foreign-tools', severity: 'warn', detail: `allowed-tools names tools we do not have: ${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ', …' : ''}` });
  }
  if (!parsed.body) {
    flags.push({ kind: 'frontmatter', severity: 'block', detail: 'the instruction body is empty' });
  }
  return {
    bytes,
    lines: content.split('\n').length,
    urls: urls.slice(0, 50),
    flags,
    ok: flags.every((f) => f.severity !== 'block'),
    scannedAt: new Date().toISOString(),
  };
}

/** Render one of our skills as a spec-conformant SKILL.md. */
export function renderSkillMd(skill: { name: string; description: string; instructions: string; proposedBy?: string; createdAt?: string }): string {
  const quote = (v: string) => JSON.stringify(v.replace(/\s+/g, ' ').trim());
  const lines = [
    '---',
    `name: ${skill.name}`,
    `description: ${quote(skill.description || skill.name)}`,
    'metadata:',
    '  exported-by: "yaap"',
    ...(skill.proposedBy ? [`  author: ${quote(skill.proposedBy)}`] : []),
    ...(skill.createdAt ? [`  created: ${quote(skill.createdAt.slice(0, 10))}`] : []),
    '---',
    '',
    skill.instructions.trim(),
    '',
  ];
  return lines.join('\n');
}
