/**
 * Mini-app HTML scan (execution-plan item 12): the item-9 scan step, for the
 * third publishable artifact. A mini app runs in a CSP-sealed, network-denied
 * iframe (docs/security.md §c), so the risk is not what the HTML can reach
 * on its own but what it asks the bridge for and what the author *tried* to
 * do: a `fetch(` or `<script src="https://…">` cannot succeed inside the
 * sandbox, and that is exactly why it belongs on the review card — code
 * written to call home is code someone meant to call home.
 *
 * Same contract as scanSkillMd: pure, dumb, loud. Flags, never decides.
 * Blocking flags (size, invisible unicode, unknown capability names) refuse
 * the publish; warnings travel with the item to the install review.
 */
import { APP_CAPABILITIES, APP_FREE_CAPS } from '../agents/agents.service';
import type { ScanFlag, ScanReport } from '../portability/skill-md';

export const APP_HTML_SCAN_CAP = 300_000;
const URL_RE = /\bhttps?:\/\/[^\s)>\]"'`]+/gi;
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|\uDB40[\uDC00-\uDFFF]/g;
const BASE64_RE = /(?:[A-Za-z0-9+/]{4}){40,}={0,2}/g;

/** Network primitives the sandbox denies; each one is a stated intent. */
const NETWORK_HINTS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\s*\(/, 'WebSocket'],
  [/\bEventSource\s*\(/, 'EventSource'],
  [/navigator\.sendBeacon\s*\(/, 'navigator.sendBeacon'],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/\bimport\s*\(\s*['"`]https?:/, 'dynamic import() of a remote module'],
];
/** Markup that pulls in or hands off to another origin. */
const EMBED_HINTS: Array<[RegExp, string]> = [
  [/<script[^>]+src\s*=\s*["']?https?:/i, 'external <script src>'],
  [/<link[^>]+href\s*=\s*["']?https?:/i, 'external <link href>'],
  [/<iframe\b/i, 'a nested <iframe>'],
  [/<form[^>]+action\s*=\s*["']?https?:/i, 'a <form action> posting to another origin'],
  [/<(img|video|audio|source)[^>]+src\s*=\s*["']?https?:/i, 'remote media src'],
  [/\bwindow\.(top|parent)\b/, 'window.top / window.parent access'],
  [/\b(location\.href\s*=|location\.assign|location\.replace|window\.open)\b/, 'navigation away from the sandbox'],
];

export interface AppScanInput {
  html: string;
  capabilities?: string[];
}

export function scanAppHtml(input: AppScanInput): ScanReport {
  const html = input.html ?? '';
  const caps = [...new Set(input.capabilities ?? [])];
  const flags: ScanFlag[] = [];
  const bytes = Buffer.byteLength(html, 'utf8');
  if (!html.trim()) flags.push({ kind: 'size', severity: 'block', detail: 'the app html is empty' });
  if (bytes > APP_HTML_SCAN_CAP) {
    flags.push({ kind: 'size', severity: 'block', detail: `${bytes} bytes exceeds the ${APP_HTML_SCAN_CAP} byte cap` });
  }
  const urls = [...new Set([...html.matchAll(URL_RE)].map((u) => u[0]))].filter((u) => !/^https?:\/\/www\.w3\.org\//i.test(u));
  if (urls.length > 0) {
    flags.push({ kind: 'urls', severity: 'warn', detail: `${urls.length} external URL${urls.length === 1 ? '' : 's'} — the sandbox blocks them, so each one is an intent to reach out` });
  }
  const network = NETWORK_HINTS.filter(([re]) => re.test(html)).map(([, label]) => label);
  if (network.length > 0) {
    flags.push({ kind: 'network', severity: 'warn', detail: `uses ${network.join(', ')} — mini apps have no network; a call like this fails, or was meant to exfiltrate` });
  }
  const embeds = EMBED_HINTS.filter(([re]) => re.test(html)).map(([, label]) => label);
  if (embeds.length > 0) {
    flags.push({ kind: 'embed', severity: 'warn', detail: `contains ${embeds.join(', ')}` });
  }
  const unknown = caps.filter((c) => !(APP_CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    flags.push({ kind: 'capabilities', severity: 'block', detail: `requests capabilities this server does not know: ${unknown.join(', ')}` });
  }
  const elevated = caps.filter((c) => !APP_FREE_CAPS.has(c) && !unknown.includes(c));
  if (elevated.length > 0) {
    flags.push({ kind: 'capabilities', severity: 'warn', detail: `requests elevated capabilities: ${elevated.join(', ')} — parked until you approve them on the app card` });
  }
  const blobs = html.match(BASE64_RE) ?? [];
  if (blobs.length > 0) {
    flags.push({ kind: 'base64', severity: 'warn', detail: `${blobs.length} base64-looking blob${blobs.length === 1 ? '' : 's'} (${blobs.reduce((n, b) => n + b.length, 0)} chars) — content you cannot read` });
  }
  const invisible = html.match(INVISIBLE_RE) ?? [];
  if (invisible.length > 0) {
    flags.push({ kind: 'invisible-unicode', severity: 'block', detail: `${invisible.length} invisible or bidi-control character${invisible.length === 1 ? '' : 's'}` });
  }
  return {
    bytes,
    lines: html.split('\n').length,
    urls: urls.slice(0, 50),
    flags,
    ok: flags.every((f) => f.severity !== 'block'),
    scannedAt: new Date().toISOString(),
  };
}
