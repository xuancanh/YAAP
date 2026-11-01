/**
 * Cloudflare Browser Rendering backend (REST "Quick Actions",
 * https://developers.cloudflare.com/browser-rendering/rest-api/). The API is
 * stateless — every call renders a URL in a fresh headless browser on
 * Cloudflare's side and returns — so there is no cookie jar to leak and no
 * session to close; a "session" here is just the URL we are on plus the
 * last render. Consequences, documented in docs/browser-tool.md §2:
 *
 *  - open:  POST /snapshot  → HTML + markdown + screenshot + title in one call
 *  - read:  cached render; a selector read goes to POST /scrape
 *  - act:   clicking a link navigates to its href; typing into a GET form and
 *           pressing Enter / clicking its submit button builds the query URL
 *           and navigates; POST forms, arbitrary buttons, selects and scroll
 *           are not possible without a live DOM and say so.
 *
 * Egress is Cloudflare's, not ours, so a redirect to a private address from
 * their browser cannot reach our network; the initial URL still passes the
 * SSRF guard for consistency with the local backend.
 */
import {
  BrowserAction, BrowserBackend, BrowserElement, BrowserPage, BrowserReadWhat, BrowserSession, BrowserSessionOptions,
} from './browser-backend.interface';
import { capText, describeElement, extractElements, htmlToMarkdown, matchElement, SNIPPET_CAP, titleFrom } from './page-model';

const CF_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 900 };

export interface CloudflareBrowserConfig {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

interface SnapshotResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: { content?: string; screenshot?: string; markdown?: string };
  meta?: { status?: number; title?: string };
}

interface ScrapeResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: Array<{ selector: string; results: Array<{ text?: string; html?: string; attributes?: Array<{ name: string; value: string }> }> }>;
}

export class CloudflareBrowserBackend implements BrowserBackend {
  readonly name = 'cloudflare' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: CloudflareBrowserConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async createSession(opts: BrowserSessionOptions): Promise<BrowserSession> {
    return new CloudflareSession(this, opts);
  }

  /** POST one Quick Action; JSON envelope `{ success, result, errors }`. */
  async call<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.cfg.accountId)}/browser-rendering/${endpoint}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CF_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => '');
    let data: T & { success?: boolean; errors?: Array<{ message?: string }> };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      throw new Error(`browser rendering ${endpoint} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || data.success === false) {
      const msg = data.errors?.map((e) => e.message).filter(Boolean).join('; ') || text.slice(0, 200);
      throw new Error(`browser rendering ${endpoint} failed (${res.status}): ${msg}`);
    }
    return data;
  }
}

class CloudflareSession implements BrowserSession {
  private page: BrowserPage | null = null;

  constructor(private readonly backend: CloudflareBrowserBackend, private readonly opts: BrowserSessionOptions) {}

  currentUrl(): string | null { return this.page?.url ?? null; }

  async open(url: string): Promise<BrowserPage> {
    const target = (await this.opts.assertUrl(url)).toString();
    const data = await this.backend.call<SnapshotResponse>('snapshot', {
      url: target,
      formats: ['content', 'screenshot', 'markdown'],
      viewport: VIEWPORT,
      gotoOptions: { waitUntil: 'networkidle2', timeout: 30_000 },
      screenshotOptions: { type: 'png' },
    });
    const html = data.result?.content ?? '';
    const markdown = data.result?.markdown?.trim() || htmlToMarkdown(html, target);
    this.page = {
      url: target,
      title: data.meta?.title || titleFrom(html),
      markdown: capText(markdown),
      elements: extractElements(html, target),
      html,
      screenshotPng: data.result?.screenshot ? Buffer.from(data.result.screenshot, 'base64') : null,
    };
    return this.page;
  }

  async read(what: BrowserReadWhat, selector?: string): Promise<string> {
    const page = this.require();
    if (what === 'links') {
      const links = page.elements.filter((e) => e.kind === 'link');
      return links.length ? links.map(describeElement).join('\n') : '(no links on this page)';
    }
    if (!selector) {
      return what === 'text' ? page.markdown : capText(page.html ?? '', SNIPPET_CAP);
    }
    const data = await this.backend.call<ScrapeResponse>('scrape', { url: page.url, elements: [{ selector }] });
    const hits = data.result?.[0]?.results ?? [];
    if (hits.length === 0) return `(no element matches "${selector}")`;
    if (what === 'html-snippet') return capText(hits.map((h) => h.html ?? '').join('\n'), SNIPPET_CAP);
    return capText(hits.map((h) => (h.text ?? '').trim()).filter(Boolean).join('\n\n'));
  }

  async act(action: BrowserAction, target: BrowserElement | string, value?: string): Promise<BrowserPage> {
    const page = this.require();
    const el = typeof target === 'string' ? matchElement(page.elements, target) : target;
    if (action === 'scroll') return page; // the stateless render is already the full page
    if (!el) throw new Error(`no element matches "${String(target)}" on the current page`);

    if (action === 'click') {
      if (el.kind === 'link' && el.href) return this.open(el.href);
      if (el.kind === 'button' && el.form) return this.submitForm(el.form.index);
      throw new Error(`the hosted browser backend can follow links and submit GET forms, but cannot click "${el.text || el.kind}" (no live page). Use the link's URL with browser_open, or configure the local Playwright backend.`);
    }
    if (action === 'type' || action === 'select') {
      if (el.kind !== 'input' && el.kind !== 'textarea' && el.kind !== 'select') throw new Error(`[${el.ref}] is a ${el.kind}, not a field`);
      if (!el.form) throw new Error('the hosted browser backend can only fill fields that belong to a form');
      el.text = value ?? '';
      return page; // staged; submitted by press Enter or clicking the form's button
    }
    // press
    if ((value ?? 'Enter') !== 'Enter') throw new Error('the hosted browser backend only supports pressing Enter to submit a form');
    if (!el.form) throw new Error('press Enter needs a form field as the target');
    return this.submitForm(el.form.index);
  }

  /** GET forms become a URL; POST forms need a live browser. */
  private async submitForm(index: number): Promise<BrowserPage> {
    const page = this.require();
    const fields = page.elements.filter((e) => e.form?.index === index);
    const form = fields[0]?.form;
    if (!form) throw new Error('form not found on the current page');
    if (form.method !== 'get') throw new Error('this form submits with POST, which the hosted browser backend cannot do without a live page. Configure the local Playwright backend for interactive forms.');
    const url = new URL(form.action);
    for (const f of fields) {
      if ((f.kind === 'input' || f.kind === 'textarea' || f.kind === 'select') && f.name && !f.sensitive) url.searchParams.set(f.name, f.text);
    }
    return this.open(url.toString());
  }

  async screenshot(): Promise<Buffer> {
    const page = this.require();
    if (page.screenshotPng) return page.screenshotPng;
    const data = await this.backend.call<SnapshotResponse>('snapshot', {
      url: page.url, formats: ['screenshot', 'markdown'], viewport: VIEWPORT, screenshotOptions: { type: 'png' },
    });
    const png = data.result?.screenshot ? Buffer.from(data.result.screenshot, 'base64') : null;
    if (!png) throw new Error('no screenshot returned');
    page.screenshotPng = png;
    return png;
  }

  async close(): Promise<void> { this.page = null; }

  private require(): BrowserPage {
    if (!this.page) throw new Error('no page is open — call browser_open first');
    return this.page;
  }
}
