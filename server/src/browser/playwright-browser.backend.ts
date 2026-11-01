/**
 * Local Playwright backend: a Chromium on this machine driven through
 * `playwright-core`, which is an optional dependency — it is imported
 * dynamically at runtime, and when the import or the browser binary is
 * missing the backend reports itself unavailable instead of throwing at boot.
 *
 * Isolation per turn: one incognito BrowserContext per session, closed by
 * BrowserService.endTurn, so cookies, storage and logins never survive the
 * turn. Egress: every request the page makes (navigations, redirects,
 * subresources, in-page link clicks) is routed through the SSRF guard's
 * assertUrl; private hosts are aborted at the network layer, not just the
 * first URL (docs/browser-tool.md §3).
 */
import { existsSync } from 'node:fs';
import {
  BrowserAction, BrowserBackend, BrowserElement, BrowserPage, BrowserReadWhat, BrowserSession, BrowserSessionOptions,
} from './browser-backend.interface';
import { capText, htmlToMarkdown, isSensitiveField, MAX_ELEMENTS, SNIPPET_CAP } from './page-model';

const NAV_TIMEOUT_MS = 30_000;
const VIEWPORT = { width: 1280, height: 900 };
const REF_ATTR = 'data-yaam-ref';

// Minimal structural types for the parts of playwright-core we touch, so the
// dependency stays optional at the type level too.
interface PwLocator {
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  selectOption(value: string, opts?: { timeout?: number }): Promise<string[]>;
  press(key: string, opts?: { timeout?: number }): Promise<void>;
  first(): PwLocator;
  count(): Promise<number>;
  /** Functions are serialised and run inside the page with the element(s);
   *  the parameter is typed structurally so no DOM lib is needed server-side. */
  evaluate<R, E>(fn: (el: E) => R): Promise<R>;
  evaluateAll<R, E>(fn: (els: E[]) => R): Promise<R>;
}
interface PwPage {
  goto(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  screenshot(opts?: { type?: 'png'; fullPage?: boolean }): Promise<Buffer>;
  locator(selector: string): PwLocator;
  getByText(text: string, opts?: { exact?: boolean }): PwLocator;
  /** A string is evaluated as an expression inside the page (Chromium, not Node). */
  evaluate<R>(expression: string): Promise<R>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}
interface PwRoute { request(): { url(): string }; abort(code?: string): Promise<void>; continue(): Promise<void> }
interface PwContext {
  newPage(): Promise<PwPage>;
  route(url: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: { viewport?: { width: number; height: number }; acceptDownloads?: boolean; javaScriptEnabled?: boolean }): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}
interface PwChromium {
  launch(opts?: { executablePath?: string; headless?: boolean; args?: string[] }): Promise<PwBrowser>;
  executablePath(): string;
}

export interface PlaywrightProbe {
  available: boolean;
  detail: string;
  executablePath?: string;
}

/** Can the local backend run here? Resolves the module and a Chromium binary
 *  (BROWSER_CHROMIUM_PATH, else playwright-core's own registry path). */
export async function probePlaywright(chromiumPath: string): Promise<PlaywrightProbe> {
  let chromium: PwChromium;
  try {
    const mod = await import('playwright-core') as unknown as { chromium: PwChromium };
    chromium = mod.chromium;
  } catch {
    return { available: false, detail: 'playwright-core is not installed (npm i playwright-core)' };
  }
  let path = chromiumPath;
  if (!path) {
    try { path = chromium.executablePath(); } catch { path = ''; }
  }
  if (!path || !existsSync(path)) {
    return { available: false, detail: `no Chromium binary at ${path || '(unset)'} — set BROWSER_CHROMIUM_PATH or run \`npx playwright-core install chromium\`` };
  }
  return { available: true, detail: `local Chromium via playwright-core (${path})`, executablePath: path };
}

export class PlaywrightBrowserBackend implements BrowserBackend {
  readonly name = 'playwright' as const;
  private browser: PwBrowser | null = null;

  constructor(private readonly executablePath: string) {}

  private async launch(): Promise<PwBrowser> {
    if (this.browser?.isConnected()) return this.browser;
    const { chromium } = await import('playwright-core') as unknown as { chromium: PwChromium };
    this.browser = await chromium.launch({
      executablePath: this.executablePath || undefined,
      headless: true,
      args: ['--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-background-networking'],
    });
    return this.browser;
  }

  async createSession(opts: BrowserSessionOptions): Promise<BrowserSession> {
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false });
    // The egress wall: every request, including redirects and subresources,
    // is checked. Resolution results are cached per host for the session.
    const verdicts = new Map<string, boolean>();
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      let host: string;
      try { host = new URL(url).host; } catch { await route.abort('blockedbyclient'); return; }
      let ok = verdicts.get(host);
      if (ok === undefined) {
        ok = await opts.assertUrl(url).then(() => true, () => false);
        verdicts.set(host, ok);
      }
      if (ok) await route.continue(); else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    return new PlaywrightSession(context, page, opts);
  }

  async shutdown(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

/** Runs inside the page: tag interactive elements with a ref attribute and
 *  return their descriptors. Kept as a string so it survives bundling and
 *  needs no DOM types on the server side. */
const COLLECT_ELEMENTS_JS = `(attrName) => {
  const out = [];
  const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]');
  let ref = 0;
  for (const n of nodes) {
    if (ref >= ${MAX_ELEMENTS}) break;
    const r = n.getBoundingClientRect();
    const style = getComputedStyle(n);
    if (r.width === 0 && r.height === 0) continue;
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = n.tagName.toLowerCase();
    const type = (n.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && type === 'hidden') continue;
    ref++;
    n.setAttribute(attrName, String(ref));
    const labelEl = n.id ? document.querySelector('label[for="' + n.id.replace(/"/g, '') + '"]') : null;
    const label = (labelEl && labelEl.textContent) || n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.getAttribute('title') || '';
    let kind = 'other';
    let text = (n.innerText || n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    let href;
    if (tag === 'a' || n.getAttribute('role') === 'link') { kind = 'link'; href = n.href || undefined; if (!text) text = label || href || ''; }
    else if (tag === 'button' || n.getAttribute('role') === 'button' || (tag === 'input' && (type === 'submit' || type === 'button' || type === 'image'))) { kind = 'button'; if (!text) text = n.value || label || ''; }
    else if (tag === 'input') { kind = 'input'; text = n.value || ''; }
    else if (tag === 'select') { kind = 'select'; text = Array.from(n.options).slice(0, 12).map((o) => o.textContent.trim()).join(' / '); }
    else if (tag === 'textarea') { kind = 'textarea'; text = (n.value || '').slice(0, 120); }
    out.push({ ref, kind, text, href, type: type || undefined, name: n.getAttribute('name') || undefined, id: n.id || undefined, label: label.trim().slice(0, 80) || undefined });
  }
  return out;
}`;

class PlaywrightSession implements BrowserSession {
  private url: string | null = null;

  constructor(private readonly context: PwContext, private readonly page: PwPage, private readonly opts: BrowserSessionOptions) {}

  currentUrl(): string | null { return this.url; }

  async open(url: string): Promise<BrowserPage> {
    const target = (await this.opts.assertUrl(url)).toString();
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    return this.render();
  }

  private async render(): Promise<BrowserPage> {
    const finalUrl = this.page.url();
    // The route handler already blocked private hosts; this guards the
    // reported URL (about:blank, chrome-error:// after an aborted nav).
    if (!/^https?:/.test(finalUrl)) throw new Error(`navigation was blocked (${finalUrl.split(':')[0]}) — the target or a redirect pointed at a private/internal host`);
    this.url = finalUrl;
    const [title, html, raw] = await Promise.all([
      this.page.title(),
      this.page.content(),
      // Page-side expression string: Playwright evaluates it inside Chromium.
      // Nothing here is eval'd in Node (docs/security.md §c).
      this.page.evaluate<Omit<BrowserElement, 'sensitive' | 'selector'>[]>(`(${COLLECT_ELEMENTS_JS})(${JSON.stringify(REF_ATTR)})`),
    ]);
    const elements: BrowserElement[] = raw.map((e) => ({
      ...e,
      selector: `[${REF_ATTR}="${e.ref}"]`,
      sensitive: isSensitiveField(e),
    }));
    const screenshotPng = await this.page.screenshot({ type: 'png' }).catch(() => null);
    return { url: finalUrl, title, markdown: capText(htmlToMarkdown(html, finalUrl)), elements, html, screenshotPng };
  }

  async read(what: BrowserReadWhat, selector?: string): Promise<string> {
    this.require();
    if (what === 'links') {
      const links = await this.page.locator('a[href]').evaluateAll(
        (els: Array<{ textContent: string | null; href: string }>) =>
          els.slice(0, 120).map((a) => `${(a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)} → ${a.href}`));
      return links.length ? links.join('\n') : '(no links on this page)';
    }
    const loc = selector ? this.resolve(selector) : this.page.locator('body');
    if ((await loc.count()) === 0) return `(no element matches "${selector ?? 'body'}")`;
    if (what === 'html-snippet') return capText(await loc.first().evaluate((el: { outerHTML: string }) => el.outerHTML), SNIPPET_CAP);
    const html = await loc.first().evaluate((el: { innerHTML: string }) => el.innerHTML);
    return capText(htmlToMarkdown(html, this.url ?? undefined));
  }

  async act(action: BrowserAction, target: BrowserElement | string, value?: string): Promise<BrowserPage> {
    this.require();
    if (action === 'scroll') {
      const dir = (value ?? 'down').toLowerCase();
      await this.page.mouse.wheel(0, dir === 'up' ? -700 : 700);
      await this.page.waitForTimeout(300);
      return this.render();
    }
    const loc = typeof target === 'string' ? this.resolve(target) : this.page.locator(target.selector ?? `[${REF_ATTR}="${target.ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`no element matches "${typeof target === 'string' ? target : `[${target.ref}]`}" on the current page`);
    const el = loc.first();
    if (action === 'type' || action === 'select') {
      // Re-check the live element: a selector target was never in our list.
      const attrs = await el.evaluate((n: { id: string; getAttribute(name: string): string | null }) => ({
        type: (n.getAttribute('type') || '').toLowerCase(),
        name: n.getAttribute('name') || undefined,
        id: n.id || undefined,
        label: n.getAttribute('aria-label') || n.getAttribute('placeholder') || undefined,
      }));
      if (isSensitiveField(attrs)) throw new Error('refused: this looks like a password, one-time code or payment field. The user must enter that themselves.');
      if (action === 'type') await el.fill(value ?? '', { timeout: 5_000 });
      else await el.selectOption(value ?? '', { timeout: 5_000 });
    } else if (action === 'click') {
      await el.click({ timeout: 5_000 });
    } else {
      await el.press(value || 'Enter', { timeout: 5_000 });
    }
    await this.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    return this.render();
  }

  async screenshot(): Promise<Buffer> {
    this.require();
    return this.page.screenshot({ type: 'png' });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  /** CSS selector, or `text=…` / plain words matched against visible text. */
  private resolve(selector: string): PwLocator {
    const t = /^text=["']?(.+?)["']?$/.exec(selector.trim());
    if (t) return this.page.getByText(t[1]);
    if (/^[#.[\w]/.test(selector) && /[#.[\]=:>]/.test(selector)) return this.page.locator(selector);
    return this.page.getByText(selector);
  }

  private require(): void {
    if (!this.url) throw new Error('no page is open — call browser_open first');
  }
}
