/**
 * SSRF guard for every outbound URL the server is told to fetch (web_fetch /
 * http_request tools, agent custom tools, MCP servers and their OAuth
 * metadata). Name-based checks alone are not enough: literal IPs come in many
 * forms (hex v4, IPv4-mapped v6, link-local/ULA v6), a hostname can resolve
 * to a private address (rebinding, split-horizon), and a public URL can
 * redirect to an internal one. `assertPublicUrl` therefore checks literal IP
 * forms AND every resolved address, and `fetchPublic` re-validates each
 * redirect hop. Dev escape hatch: YAAM_ALLOW_PRIVATE_URLS=true skips the
 * private-address checks (local integrations against internal hosts).
 */
import { lookup } from 'node:dns/promises';

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const realLookup: AddressLookup = (hostname) => lookup(hostname, { all: true, verbatim: true });
let lookupImpl: AddressLookup = realLookup;

/** Test seam: swap DNS resolution; passing null restores the real lookup. */
export function setAddressLookup(fn: AddressLookup | null): void {
  lookupImpl = fn ?? realLookup;
}

function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Loopback, RFC-1918, link-local (incl. cloud metadata 169.254.169.254),
 *  CGNAT, benchmarking, protocol-assignments, multicast and reserved space. */
function isPrivateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Expand an IPv6 literal (with or without brackets, `::` compression, and an
 *  embedded dotted quad) to eight 16-bit words, or null when invalid. */
function parseIpv6(raw: string): number[] | null {
  let s = raw;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = idx >= 0 ? parseIpv4(s.slice(idx + 1)) : null;
    if (!v4) return null;
    s = `${s.slice(0, idx)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** True for any non-public IP literal, v4 or v6. Non-IP strings return false
 *  (hostnames are checked by resolution instead). */
export function isPrivateIp(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return isPrivateV4(v4);
  const w = parseIpv6(address);
  if (!w) return false;
  if (w.every((x) => x === 0)) return true; // ::
  if (w[7] === 1 && w.slice(0, 7).every((x) => x === 0)) return true; // ::1
  const v4of = () => [(w[6] >> 8) & 0xff, w[6] & 0xff, (w[7] >> 8) & 0xff, w[7] & 0xff];
  if (w[5] === 0xffff && w.slice(0, 5).every((x) => x === 0)) return isPrivateV4(v4of()); // ::ffff:a.b.c.d
  if (w.slice(0, 6).every((x) => x === 0)) return isPrivateV4(v4of()); // ::a.b.c.d (deprecated mapped form)
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Parse `raw`, require http(s), and reject private/internal targets — both
 *  literal IP forms and hostnames that resolve to a non-public address.
 *  Returns the parsed URL. DNS failures are refused closed. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid arguments: "url" is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http/https URLs are allowed');
  }
  if (process.env.YAAM_ALLOW_PRIVATE_URLS === 'true') return url;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || isPrivateIp(host)) {
    throw new Error('requests to private/internal hosts are not allowed');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupImpl(host);
  } catch {
    throw new Error(`could not resolve host "${host}"`);
  }
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('requests to private/internal hosts are not allowed');
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** fetch() with redirects followed manually: every hop is re-validated
 *  against the SSRF guard, so a public URL cannot 302 to an internal target.
 *  At most `maxRedirects` hops; the caller's signal/timeout spans all hops. */
export async function fetchPublic(
  raw: string,
  init: RequestInit,
  fetchFn: typeof fetch = fetch,
  maxRedirects = 5,
): Promise<Response> {
  let current = (await assertPublicUrl(raw)).toString();
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(current, { ...init, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= maxRedirects) throw new Error('too many redirects');
    current = (await assertPublicUrl(new URL(location, current).toString())).toString();
  }
}
