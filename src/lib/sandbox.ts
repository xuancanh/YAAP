/**
 * The wall behind every iframe we render (docs/code-execution.md §1).
 *
 * `sandbox="allow-scripts"` makes a frame opaque-origin, but it does NOT
 * block network: an app could still fetch(), set img.src, or pull a remote
 * script, and exfiltrate anything it can read. docs/miniapp-capabilities.md
 * builds its whole exfiltration-safety argument on "mini apps have no
 * network" — this Content-Security-Policy is what makes that true.
 *
 * `default-src 'none'` denies every fetch destination, including connect-src
 * (fetch/XHR/WebSocket/beacon) and script-src by URL. The allowances that
 * follow are the minimum an offline document needs to render itself:
 *  - inline script + style: apps are a single self-contained HTML string
 *  - 'unsafe-eval': some app code and chart helpers need it, and eval cannot
 *    cross the boundary — the wall is the network and the opaque origin
 *  - data:/blob: images, media and fonts: generated content, still local
 *  - base-uri/form-action 'none': no re-pointing relative URLs, no POSTing out
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;

/** Put the CSP meta as early in the document as the parser will honour it.
 *  A meta placed before <!doctype> would trigger quirks mode and change how
 *  the page lays out, so full documents get it injected into <head> instead
 *  of prepended. Fragments (no doctype, no html) just get it up front. */
export function sealHtml(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + CSP_META + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + CSP_META + html.slice(at);
  }
  return CSP_META + html;
}
