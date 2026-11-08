/**
 * ActionReviewService — the independent action reviewer (docs/permissions.md
 * §6, execution plan item 2).
 *
 * The three deterministic gates stay the floor. This adds a second reader for
 * the calls that would otherwise run WITHOUT a fresh human decision: Auto
 * mode, and remembered approvals in Ask mode. For each such mutating call it
 * (1) runs a deterministic sensitive-information pre-check over the serialized
 * input — any hit forces at least `ask` — and (2) makes ONE bounded,
 * tool-free call to a cheap reviewer model that compares the proposed action
 * with what the user asked for. Parse failure or a provider error → `ask`:
 * the reviewer failing open would make it decoration.
 *
 * It never sees the agent's system prompt or the agent's tools, so content
 * the agent read cannot address it. It is the only place in the turn loop
 * that spends tokens outside the turn's own provider rounds; the spend is
 * returned so the turn counts it into its usage.
 */
import { Injectable, Optional } from '@nestjs/common';
import { AiProvider } from '../ai/ai-provider.interface';
import { streamSignal } from '../ai/provider-timeout';
import { SettingsService } from '../settings/settings.module';
import { buildReviewMessage, parseReviewOutput, REVIEW_SYSTEM, ReviewInput, ReviewVerdict } from './review-prompt';

export type { ReviewVerdict, ReviewInput } from './review-prompt';

/** The reviewer model's context: the session's provider and credentials. */
export interface ReviewerContext {
  provider: AiProvider;
  /** The session model — the fallback when no cheaper sibling is known. */
  model: string;
  apiKey?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  reason: string;
  /** Deterministic pre-check categories found in the input. */
  sensitive: string[];
  /** The model that reviewed, or 'precheck' / 'none' when no model ran. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** What gets persisted on the tool record and emitted on SSE events. */
export type ReviewRecord = Pick<ReviewResult, 'verdict' | 'reason' | 'sensitive' | 'model'>;

/** Bounded output: a verdict and one sentence, never an essay. */
export const REVIEW_MAX_TOKENS = 300;

/** Cheapest known sibling of each provider family, keyed by the adapter's
 *  name and the resolved base URL host. Unknown family → the session model. */
export function cheapestModelFor(providerName: string, baseUrl: string | undefined, sessionModel: string): string {
  if (providerName === 'anthropic') return 'claude-haiku-5-5';
  if (providerName === 'openai-compatible') {
    const host = (() => { try { return new URL(baseUrl ?? '').hostname; } catch { return ''; } })();
    if (host === 'api.openai.com') return 'gpt-6-luna';
    if (host.endsWith('deepseek.com')) return 'deepseek-flash';
    if (host.endsWith('googleapis.com')) return 'gemini-2.5-flash';
  }
  return sessionModel;
}

/** Deterministic sensitive-information pre-check. Each entry names a
 *  category and a matcher over the serialized tool input. */
const PATTERNS: Array<{ label: string; re: RegExp; verify?: (hit: string) => boolean }> = [
  { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'API key', re: /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|gsk_[A-Za-z0-9]{20,})\b/ },
  // Quotes may arrive JSON-escaped (\") since the input is serialized first.
  { label: 'API key', re: /\bapi[_-]?key\b\s*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[A-Za-z0-9_\-./+=]{12,}/i },
  { label: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { label: 'password', re: /\b(?:password|passwd|pwd|passphrase|secret)\b\s*(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[^\s"',\\]{6,}/i },
  { label: 'card number', re: /\b(?:\d[ -]?){12,18}\d\b/, verify: luhnValid },
  { label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/, verify: ibanValid },
  { label: 'SSN-like number', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/ },
];

export function luhnValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Scan serialized tool input for secrets and personal identifiers. Returns
 *  the distinct categories hit, in pattern order. */
export function sensitivePrecheck(input: unknown): string[] {
  let text: string;
  try { text = typeof input === 'string' ? input : JSON.stringify(input ?? {}); } catch { text = String(input); }
  const hits: string[] = [];
  for (const p of PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
    for (const m of text.matchAll(re)) {
      if (p.verify && !p.verify(m[0])) continue;
      if (!hits.includes(p.label)) hits.push(p.label);
      break;
    }
  }
  return hits;
}

@Injectable()
export class ActionReviewService {
  /** Test seam: replaces the model call (not the pre-check). Receives the
   *  prompt input and returns the parsed verdict. */
  reviewFn?: (input: ReviewInput) => Promise<{ verdict: ReviewVerdict; reason: string }>;

  constructor(@Optional() private readonly settings?: SettingsService) {}

  /** Reviewer on/off and model override, from app settings. Defaults: on,
   *  cheapest sibling of the session's provider. */
  async config(): Promise<{ enabled: boolean; model: string }> {
    const all = this.settings ? await this.settings.all().catch((): Record<string, string> => ({})) : {};
    return { enabled: (all.actionReview ?? 'on') !== 'off', model: (all.reviewModel ?? '').trim() };
  }

  /** `opts.model` pins the reviewing model (the agent co-signer of
   *  docs/actions-and-trust.md §5 reads on its own model family). */
  async review(input: Omit<ReviewInput, 'sensitive'>, ctx: ReviewerContext, opts: { model?: string } = {}): Promise<ReviewResult> {
    const sensitive = sensitivePrecheck(input.call.input);
    const full: ReviewInput = { ...input, sensitive };
    const usage = { inputTokens: 0, outputTokens: 0 };

    let verdict: ReviewVerdict;
    let reason: string;
    let model: string;
    if (this.reviewFn) {
      ({ verdict, reason } = await this.reviewFn(full));
      model = 'test';
    } else {
      const { model: override } = await this.config();
      model = opts.model || override || cheapestModelFor(ctx.provider.name, ctx.baseUrl, ctx.model);
      try {
        let out = '';
        for await (const ev of ctx.provider.stream({
          model,
          system: REVIEW_SYSTEM,
          messages: [{ role: 'user', content: buildReviewMessage(full) }],
          maxTokens: REVIEW_MAX_TOKENS,
          apiKey: ctx.apiKey,
          baseUrl: ctx.baseUrl,
          signal: streamSignal(ctx.signal),
        })) {
          if (ev.type === 'answer') out += ev.text;
          if (ev.type === 'usage') { usage.inputTokens += ev.inputTokens; usage.outputTokens += ev.outputTokens; }
        }
        ({ verdict, reason } = parseReviewOutput(out));
      } catch (err) {
        verdict = 'ask';
        reason = `Reviewer unavailable (${err instanceof Error ? err.message : String(err)}); asking you instead.`;
      }
    }
    // The pre-check is the floor: secrets in the input never auto-run.
    if (sensitive.length > 0 && verdict === 'allow') {
      verdict = 'ask';
      reason = `Input contains ${sensitive.join(', ')} — ${reason}`;
    }
    return { verdict, reason, sensitive, model, usage };
  }
}
