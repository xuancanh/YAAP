// Thin edge proxy for the YAAP SPA.
//
// - /api/* is forwarded to the container-hosted API origin (behind a
//   cloudflared tunnel), preserving method/headers/body and streaming the
//   response back untouched — SSE turn streams must never be buffered here,
//   so the Response is returned directly (never await .text()/.json()).
// - Everything else is served from Workers Static Assets (SPA fallback to
//   index.html is configured in wrangler.toml).

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      // Rebuild the URL against the API origin; keep path + query as-is.
      const target = new URL(url.pathname + url.search, env.API_ORIGIN);
      // Pass the original request through: method, headers (incl. auth),
      // and body stream are preserved by fetch(). Default redirect handling
      // is fine — same-origin redirects from the API (e.g. OAuth callbacks)
      // come back to this worker and re-enter normally.
      const upstream = await fetch(target, request);
      // Mark API responses uncacheable; no-transform keeps intermediaries
      // from recompressing/buffering SSE event streams.
      const headers = new Headers(upstream.headers);
      headers.set('Cache-Control', 'no-store, no-transform');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    // Static asset or SPA route — let the assets binding handle it.
    return env.ASSETS.fetch(request);
  },
};
