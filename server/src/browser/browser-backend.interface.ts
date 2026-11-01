/**
 * The seam between BrowserService (tool contract, per-turn sessions, safety
 * rules, screenshots, events) and the thing that actually renders pages.
 * Two implementations (docs/browser-tool.md §2):
 *
 *  - cloudflare: Browser Rendering REST "Quick Actions" — stateless, so the
 *    backend emulates a session by re-rendering from a URL each step.
 *  - playwright: a local Chromium driven by playwright-core, one incognito
 *    context per turn.
 *
 * Both return the same BrowserPage shape so the service formats one output.
 */

export type BrowserBackendName = 'cloudflare' | 'playwright';

export type BrowserElementKind = 'link' | 'button' | 'input' | 'select' | 'textarea' | 'other';

/** One interactive element the model may refer to by number. */
export interface BrowserElement {
  /** 1-based number shown to the model; stable until the next page render. */
  ref: number;
  kind: BrowserElementKind;
  /** Visible text / value / placeholder, trimmed and bounded. */
  text: string;
  /** Absolute href for links. */
  href?: string;
  /** input type attribute (text, search, password, …). */
  type?: string;
  name?: string;
  id?: string;
  /** Associated <label>, aria-label or placeholder. */
  label?: string;
  /** Owning form (index in document order) and its method/action, for GET
   *  form submission on the stateless backend. */
  form?: { index: number; method: 'get' | 'post'; action: string };
  /** CSS selector the backend can resolve this element with (playwright). */
  selector?: string;
  /** True when typing here would be entering a credential/payment secret. */
  sensitive: boolean;
}

export interface BrowserPage {
  url: string;
  title: string;
  /** Readable page text as markdown, already bounded by the backend or the service. */
  markdown: string;
  elements: BrowserElement[];
  /** Raw HTML when the backend has it (used for selector reads). */
  html?: string;
  screenshotPng: Buffer | null;
}

export type BrowserAction = 'click' | 'type' | 'select' | 'scroll' | 'press';
export type BrowserReadWhat = 'text' | 'links' | 'html-snippet';

export interface BrowserSession {
  /** Navigate to an already SSRF-validated URL and render the page. */
  open(url: string): Promise<BrowserPage>;
  /** Read from the current page without navigating. */
  read(what: BrowserReadWhat, selector?: string): Promise<string>;
  /** Perform an action. `target` is a resolved element from the last render
   *  or a raw CSS/text selector string. Returns the page after the action
   *  (which may have navigated). */
  act(action: BrowserAction, target: BrowserElement | string, value?: string): Promise<BrowserPage>;
  /** Fresh screenshot of the current page. */
  screenshot(): Promise<Buffer>;
  /** Current URL, or null before the first open. */
  currentUrl(): string | null;
  close(): Promise<void>;
}

export interface BrowserSessionOptions {
  /** Every navigation — initial, redirect, in-page — goes through this; it
   *  throws for private/internal hosts (common/url-guard.ts). */
  assertUrl: (url: string) => Promise<URL>;
}

export interface BrowserBackend {
  readonly name: BrowserBackendName;
  createSession(opts: BrowserSessionOptions): Promise<BrowserSession>;
}
