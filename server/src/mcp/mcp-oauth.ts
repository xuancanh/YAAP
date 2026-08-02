/**
 * MCP OAuth 2.1 discovery helpers (authorization spec, June 2025 revision):
 * RFC 9728 protected-resource metadata → RFC 8414 authorization-server
 * metadata → optional RFC 7591 dynamic client registration, then an
 * authorization-code + PKCE flow run by McpService. Pure functions over an
 * injectable fetch so the whole chain is testable offline.
 */
import { createHash, randomBytes } from 'node:crypto';
import { assertPublicUrl } from '../common/url-guard';

export interface AuthServerMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    // every candidate here is server-derived (metadata hints, well-knowns of
    // a server-named host) — refuse internal targets before fetching
    await assertPublicUrl(url);
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Candidate well-known URLs: path-aware form first (spec), then root. */
function wellKnown(base: string, suffix: string): string[] {
  const u = new URL(base);
  const out = [`${u.origin}/.well-known/${suffix}${u.pathname === '/' ? '' : u.pathname}`, `${u.origin}/.well-known/${suffix}`];
  return [...new Set(out)];
}

/** Resolve the authorization server's endpoints for an MCP server that
 *  answered 401. wwwAuthenticate may carry a resource_metadata hint. */
export async function discoverAuth(serverUrl: string, wwwAuthenticate: string, fetchFn: typeof fetch): Promise<AuthServerMeta> {
  // 1. Protected-resource metadata (RFC 9728) → authorization server URL.
  const hinted = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1];
  const prCandidates = [...(hinted ? [hinted] : []), ...wellKnown(serverUrl, 'oauth-protected-resource')];
  let asUrl = new URL(serverUrl).origin; // fallback: the server is its own AS
  for (const url of prCandidates) {
    const meta = await getJson(fetchFn, url);
    const servers = meta?.authorization_servers as string[] | undefined;
    if (servers?.[0]) { asUrl = servers[0]; break; }
  }

  // 2. Authorization-server metadata (RFC 8414, OIDC fallback).
  for (const url of [...wellKnown(asUrl, 'oauth-authorization-server'), ...wellKnown(asUrl, 'openid-configuration')]) {
    const meta = await getJson(fetchFn, url);
    if (meta?.authorization_endpoint && meta?.token_endpoint) {
      const endpoints: AuthServerMeta = {
        authorizationEndpoint: String(meta.authorization_endpoint),
        tokenEndpoint: String(meta.token_endpoint),
        registrationEndpoint: meta.registration_endpoint ? String(meta.registration_endpoint) : undefined,
      };
      // the endpoints come from the server's own metadata — they could point
      // anywhere; the browser is sent to one and we POST credentials to others
      await assertPublicUrl(endpoints.authorizationEndpoint);
      await assertPublicUrl(endpoints.tokenEndpoint);
      if (endpoints.registrationEndpoint) await assertPublicUrl(endpoints.registrationEndpoint);
      return endpoints;
    }
  }
  throw new Error(`could not discover OAuth endpoints for ${serverUrl} — the server may not support the MCP authorization spec`);
}

/** RFC 7591 dynamic client registration; returns null when unsupported. */
export async function registerClient(
  registrationEndpoint: string | undefined,
  redirectUri: string,
  fetchFn: typeof fetch,
): Promise<{ clientId: string; clientSecret: string } | null> {
  if (!registrationEndpoint) return null;
  try {
    await assertPublicUrl(registrationEndpoint);
    const res = await fetchFn(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'yaam-chat',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json() as { client_id?: string; client_secret?: string };
    return body.client_id ? { clientId: body.client_id, clientSecret: body.client_secret ?? '' } : null;
  } catch {
    return null;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
