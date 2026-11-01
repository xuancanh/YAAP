/**
 * BrowserService — the credential-free, viewable browser tool behind the
 * standard tool gates (docs/browser-tool.md). Owns the four tools, picks a
 * backend (cloudflare | playwright) the way RunnerService does, keeps one
 * browser session per chat turn, stores every screenshot in the chat's file
 * store and emits `browser` TurnEvents so the artifact panel can show the
 * agent browsing live.
 *
 * Invariants:
 *  - the session ends with the turn (TurnLoopService calls endTurn in its
 *    finally); nothing — cookies, logins, the page — survives it;
 *  - every navigation passes the SSRF guard (assertPublicUrl), including
 *    link clicks and, on the local backend, every request the page makes;
 *  - the agent never types into a credential field; the refusal tells the
 *    model the user must do that themselves;
 *  - page content reaches the model wrapped as untrusted data;
 *  - browser_open / browser_read / browser_screenshot are read-only (they
 *    auto-run in Ask mode); browser_act is mutating (click/type can submit
 *    forms), so Ask mode pauses on it and loop turns queue it.
 */
import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiToolSpec } from '../ai/ai-provider.interface';
import { assertPublicUrl } from '../common/url-guard';
import { StorageService } from '../storage/storage.service';
import { FileRoot, fileRootKey } from '../chats/tools.service';
import {
  BrowserAction, BrowserBackend, BrowserBackendName, BrowserElement, BrowserPage, BrowserReadWhat, BrowserSession,
} from './browser-backend.interface';
import { CloudflareBrowserBackend } from './cloudflare-browser.backend';
import { PlaywrightBrowserBackend, probePlaywright } from './playwright-browser.backend';
import { describeElement, wrapPageContent } from './page-model';

export interface BrowserStatus {
  backend: BrowserBackendName | null;
  /** Human-readable reason when backend is null, or what is live. */
  detail: string;
  /** The hosted backend cannot run live DOM actions (docs/browser-tool.md §2). */
  interactive: boolean;
}

/** Streamed to the client for the live "Browser" tab and recorded on the
 *  tool record so the panel can be rebuilt after the turn. */
export interface BrowserStep {
  url: string;
  title: string;
  /** Path under the chat's file root (browser/<sessionId>/<n>.png). */
  screenshotPath: string;
  step: number;
}

export type BrowserTurnEvent = { type: 'browser'; sessionId: string } & BrowserStep;

/** What the turn loop needs to know about the chat a tool runs in. */
export interface BrowserToolContext {
  sessionId: string;
  fileRoot: FileRoot;
}

const ACTIONS: BrowserAction[] = ['click', 'type', 'select', 'scroll', 'press'];
const READS: BrowserReadWhat[] = ['text', 'links', 'html-snippet'];

const TOOLS: Array<{ name: string; readOnly: boolean }> = [
  { name: 'browser_open', readOnly: true },
  { name: 'browser_read', readOnly: true },
  { name: 'browser_act', readOnly: false },
  { name: 'browser_screenshot', readOnly: true },
];

interface TurnSession {
  session: BrowserSession;
  elements: BrowserElement[];
  pendingEvents: BrowserTurnEvent[];
  lastStep: BrowserStep | null;
}

@Injectable()
export class BrowserService implements OnModuleDestroy {
  /** Test seam: a backend injected here wins over config-based selection. */
  backendOverride: BrowserBackend | null = null;
  /** Test seam / probe cache: whether the local backend can run here. */
  playwright: { available: boolean; detail: string; executablePath?: string } | null = null;
  /** Injectable for tests (same seam as RunnerService). */
  fetchImpl: typeof fetch = fetch;

  private cloudflare: CloudflareBrowserBackend | null = null;
  private playwrightBackend: PlaywrightBrowserBackend | null = null;
  private readonly turns = new Map<string, TurnSession>();
  private readonly stepCounters = new Map<string, number>();
  private readonly probing: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly storage?: StorageService,
  ) {
    const mode = this.mode();
    // Probe once at boot so status()/specs() stay synchronous like the runner's.
    this.probing = mode === 'off' || mode === 'cloudflare'
      ? Promise.resolve()
      : probePlaywright(String(this.config.get('browserChromiumPath') ?? '')).then((p) => { this.playwright ??= p; }, () => { this.playwright ??= { available: false, detail: 'probe failed' }; });
  }

  /** Await the boot-time probe (tests, status endpoint). */
  ready(): Promise<void> { return this.probing; }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.turns.keys()]) await this.endTurn(id);
    await this.playwrightBackend?.shutdown();
  }

  private mode(): string { return String(this.config.get('browserBackend') ?? 'auto'); }

  /** 'auto' prefers cloudflare when configured (an explicit paid setup), else
   *  the local Playwright backend when importable, else no tools at all. */
  status(): BrowserStatus {
    if (this.backendOverride) return { backend: this.backendOverride.name, detail: 'injected backend', interactive: this.backendOverride.name === 'playwright' };
    const mode = this.mode();
    const cfReady = Boolean(this.config.get('browserCfAccountId') && this.config.get('browserCfToken'));
    if (mode === 'off') return { backend: null, detail: 'disabled (BROWSER_BACKEND=off)', interactive: false };
    if (mode === 'cloudflare' || (mode === 'auto' && cfReady)) {
      if (!cfReady) return { backend: null, detail: 'cloudflare backend selected but BROWSER_CF_ACCOUNT_ID / BROWSER_CF_TOKEN are not set', interactive: false };
      return { backend: 'cloudflare', detail: 'Cloudflare Browser Rendering (REST, stateless: links and GET forms only)', interactive: false };
    }
    const pw = this.playwright;
    if (!pw) return { backend: null, detail: 'probing for playwright-core…', interactive: false };
    if (!pw.available) return { backend: null, detail: pw.detail, interactive: false };
    return { backend: 'playwright', detail: pw.detail, interactive: true };
  }

  specs(): AiToolSpec[] {
    const { backend, interactive } = this.status();
    if (!backend) return [];
    const actNote = interactive
      ? 'click / type / select / scroll / press on the live page.'
      : 'On this backend only link clicks, typing into GET-form fields, and press Enter (submit) work — there is no live page.';
    return [
      {
        name: 'browser_open',
        description: 'Open a public web page in a disposable browser and return its title, readable text (markdown), a numbered list of interactive elements (links, buttons, fields) and a screenshot the user can see. The browser has no logins or cookies and is thrown away when this turn ends. Read-only.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL to open' } }, required: ['url'] },
      },
      {
        name: 'browser_read',
        description: 'Read from the page currently open in the browser without navigating: "text" (readable markdown, optionally of one CSS selector), "links" (every link with its URL), or "html-snippet" (outer HTML of a selector, bounded). Read-only.',
        inputSchema: {
          type: 'object',
          properties: {
            what: { type: 'string', enum: READS },
            selector: { type: 'string', description: 'Optional CSS selector to narrow the read' },
          },
          required: ['what'],
        },
      },
      {
        name: 'browser_act',
        description: `Act on the open page: ${actNote} "target" is an element number from the last browser_open/browser_act result, or a CSS / text= selector. "value" is the text to type, the option to select, the key to press (default Enter), or up/down for scroll. Never used for passwords, one-time codes or card numbers — those fields are refused and the user must fill them. Mutating: needs approval in Ask mode because clicks and typing can submit forms.`,
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ACTIONS },
            target: { oneOf: [{ type: 'number' }, { type: 'string' }], description: 'Element number or selector' },
            value: { type: 'string' },
          },
          required: ['action'],
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Take a fresh screenshot of the open page for the user to see in the Browser panel. Read-only.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  owns(name: string): boolean { return TOOLS.some((t) => t.name === name); }

  isReadOnly(name: string): boolean | undefined {
    return TOOLS.find((t) => t.name === name)?.readOnly;
  }

  /** Browser events produced since the last drain, in order. The turn loop
   *  yields them before the tool_result so the panel updates first. */
  takeEvents(sessionId: string): BrowserTurnEvent[] {
    const t = this.turns.get(sessionId);
    if (!t) return [];
    const out = t.pendingEvents;
    t.pendingEvents = [];
    return out;
  }

  /** The latest step a tool call produced, for the tool record. */
  lastStep(sessionId: string): BrowserStep | null {
    return this.turns.get(sessionId)?.lastStep ?? null;
  }

  /** Close the chat's browser session: incognito context / cached render gone. */
  async endTurn(sessionId: string): Promise<void> {
    const t = this.turns.get(sessionId);
    if (!t) return;
    this.turns.delete(sessionId);
    await t.session.close().catch(() => {});
  }

  async execute(ctx: BrowserToolContext, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.owns(name)) throw new Error(`unknown tool: ${name}`);
    const status = this.status();
    if (!status.backend) throw new Error(`browser is not available: ${status.detail}`);
    const t = await this.sessionFor(ctx.sessionId);
    t.lastStep = null;
    switch (name) {
      case 'browser_open': {
        const url = typeof input.url === 'string' ? input.url.trim() : '';
        if (!url) throw new Error('invalid arguments: "url" must be a non-empty string');
        // Checked here AND by the backend (every hop): a private target never
        // reaches a backend call at all.
        await assertPublicUrl(url);
        const page = await t.session.open(url);
        return this.present(ctx, t, page);
      }
      case 'browser_read': {
        const what = String(input.what ?? 'text') as BrowserReadWhat;
        if (!READS.includes(what)) throw new Error(`invalid arguments: "what" must be one of ${READS.join(', ')}`);
        const selector = typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : undefined;
        const body = await t.session.read(what, selector);
        return wrapPageContent(t.session.currentUrl() ?? '', body);
      }
      case 'browser_act': {
        const action = String(input.action ?? '') as BrowserAction;
        if (!ACTIONS.includes(action)) throw new Error(`invalid arguments: "action" must be one of ${ACTIONS.join(', ')}`);
        const value = typeof input.value === 'string' ? input.value : undefined;
        const target = this.resolveTarget(t, input.target, action);
        if ((action === 'type' || action === 'select') && typeof target !== 'string' && target.sensitive) {
          return `Refused: [${target.ref}] is a password, one-time code or payment field (${target.label ?? target.name ?? target.type ?? 'credential'}). The browser never enters credentials — ask the user to sign in or complete this step themselves, then continue.`;
        }
        if ((action === 'type' || action === 'select') && value === undefined) throw new Error(`invalid arguments: "value" is required for ${action}`);
        const page = await t.session.act(action, target, value);
        return this.present(ctx, t, page, `After ${action}${typeof target === 'string' ? ` on "${target}"` : ` on [${target.ref}]`}:`);
      }
      default: { // browser_screenshot
        const url = t.session.currentUrl();
        if (!url) throw new Error('no page is open — call browser_open first');
        const png = await t.session.screenshot();
        const step = await this.record(ctx, t, url, '', png);
        return step ? `Screenshot saved as ${step.screenshotPath} (step ${step.step}); the user can see it in the Browser panel.` : 'Screenshot taken but could not be stored.';
      }
    }
  }

  private resolveTarget(t: TurnSession, raw: unknown, action: BrowserAction): BrowserElement | string {
    if (action === 'scroll') return typeof raw === 'string' ? raw : 'body';
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
      const n = Number(raw);
      const el = t.elements.find((e) => e.ref === n);
      if (!el) throw new Error(`no element [${n}] in the last page render (1-${t.elements.length}); open or re-read the page first`);
      return el;
    }
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    throw new Error('invalid arguments: "target" must be an element number or a selector');
  }

  private async sessionFor(sessionId: string): Promise<TurnSession> {
    let t = this.turns.get(sessionId);
    if (t) return t;
    const backend = await this.backend();
    const session = await backend.createSession({ assertUrl: (u) => assertPublicUrl(u) });
    t = { session, elements: [], pendingEvents: [], lastStep: null };
    this.turns.set(sessionId, t);
    return t;
  }

  private async backend(): Promise<BrowserBackend> {
    if (this.backendOverride) return this.backendOverride;
    const { backend } = this.status();
    if (backend === 'cloudflare') {
      this.cloudflare ??= new CloudflareBrowserBackend({
        accountId: String(this.config.get('browserCfAccountId') ?? ''),
        token: String(this.config.get('browserCfToken') ?? ''),
        fetchImpl: this.fetchImpl,
      });
      return this.cloudflare;
    }
    if (backend === 'playwright') {
      this.playwrightBackend ??= new PlaywrightBrowserBackend(this.playwright?.executablePath ?? '');
      return this.playwrightBackend;
    }
    throw new Error(`browser is not available: ${this.status().detail}`);
  }

  /** Format a rendered page for the model and record its screenshot. */
  private async present(ctx: BrowserToolContext, t: TurnSession, page: BrowserPage, lead = ''): Promise<string> {
    t.elements = page.elements;
    const step = page.screenshotPng ? await this.record(ctx, t, page.url, page.title, page.screenshotPng) : null;
    const elements = page.elements.length
      ? `\n\nInteractive elements (refer to them by number in browser_act):\n${page.elements.map(describeElement).join('\n')}`
      : '\n\n(no interactive elements found)';
    const body = `# ${page.title || '(untitled)'}\nURL: ${page.url}\n\n${page.markdown || '(no readable text)'}${elements}`;
    const shot = step ? `\nScreenshot: ${step.screenshotPath} (step ${step.step}) — shown to the user in the Browser panel.` : '';
    return `${lead ? `${lead}\n` : ''}${wrapPageContent(page.url, body)}${shot}`;
  }

  private async record(ctx: BrowserToolContext, t: TurnSession, url: string, title: string, png: Buffer): Promise<BrowserStep | null> {
    if (!this.storage) return null;
    const n = await this.nextStep(ctx);
    const screenshotPath = `browser/${ctx.sessionId}/${n}.png`;
    try {
      await this.storage.put(fileRootKey(ctx.fileRoot, screenshotPath), png, 'image/png');
    } catch {
      return null;
    }
    const step: BrowserStep = { url, title, screenshotPath, step: n };
    t.lastStep = step;
    t.pendingEvents.push({ type: 'browser', sessionId: ctx.sessionId, ...step });
    return step;
  }

  /** Step numbers keep counting across turns so earlier screenshots survive. */
  private async nextStep(ctx: BrowserToolContext): Promise<number> {
    let n = this.stepCounters.get(ctx.sessionId);
    if (n === undefined) {
      n = 0;
      try {
        const prefix = fileRootKey(ctx.fileRoot, `browser/${ctx.sessionId}`) + '/';
        for (const o of await this.storage!.list(prefix)) {
          const m = /(\d+)\.png$/.exec(o.key);
          if (m) n = Math.max(n, Number(m[1]));
        }
      } catch { /* a fresh counter is fine */ }
    }
    n += 1;
    this.stepCounters.set(ctx.sessionId, n);
    return n;
  }
}
