/**
 * AppLlmService — `yaam.llm.*`, a plain model call for mini apps
 * (docs/miniapp-roadmap.md §3).
 *
 * Deliberately NOT `agent.ask`. That runs a full turn: the agent's charter,
 * its files, its tools, its memory, its token ceiling. Right for "crunch the
 * numbers in my folder", wrong for the thing most apps actually want — tag
 * these 40 entries, extract fields from this pasted text, summarize this
 * note. Routing those through an agent turn costs the whole system prompt per
 * call, returns prose where the app needed JSON, and may decide to use a tool.
 *
 * So: no agent context, no tools, no memory, no file access, no conversation.
 * The risk class is cost, not agency — the worst an app can do here is spend
 * tokens, which is what the daily budget bounds. That makes it strictly safer
 * than the agent.ask we already ship, and it activates without a per-call
 * confirm.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AiProvider } from '../ai/ai-provider.interface';
import { AiProviderFactory } from '../ai/providers.factory';
import { AgentTypesService } from '../agent-types/agent-types.service';
import { SettingsService } from '../settings/settings.module';
import { streamSignal } from '../ai/provider-timeout';
import { AppBridgeService } from './app-bridge.service';

const PROMPT_CAP = 20_000;
const MAX_OUTPUT_TOKENS = 2_000;
/** Per app per UTC day. Generous enough to tag a few hundred rows, small
 *  enough that a runaway loop is a rounding error rather than a bill. */
export const LLM_TOKENS_PER_DAY = 200_000;

/** No persona, no charter, no tools — this is a text function, not an agent.
 *  It must not inherit the agent's instructions, or an app would get the
 *  agent's authority through the side door. */
const LLM_SYSTEM = 'You are a text-processing function embedded in a small application. '
  + 'Answer the request directly and concisely. You have no tools, no memory of previous '
  + 'calls, and no ability to act — return only the requested output, with no preamble.';

export interface LlmResult {
  text: string;
  /** Parsed object when a schema was requested and the model complied. */
  data?: unknown;
  /** Set when a schema was requested but the output would not parse. */
  parseError?: string;
  remainingTokensToday: number;
}

@Injectable()
export class AppLlmService {
  /** Estimated token spend per app per UTC day. In-memory, like the ask
   *  budget: a restart refills it, erring forgiving. */
  private spend = new Map<string, { day: string; used: number }>();

  constructor(
    private readonly bridge: AppBridgeService,
    private readonly providers: AiProviderFactory,
    private readonly agentTypes: AgentTypesService,
    private readonly settings: SettingsService,
  ) {}

  /** Which model an app's calls run on: the user's default agent type, else
   *  the first enabled one, else Echo (so the app runs without keys). */
  private async resolveProvider(): Promise<{ provider: AiProvider; model: string; apiKey?: string; baseUrl?: string }> {
    const settings = await this.settings.all().catch(() => ({}) as Record<string, string>);
    const types = await this.agentTypes.list().catch(() => []);
    const pick = types.find((t) => t.id === settings.defaultAgentTypeId && t.enabled)
      ?? types.find((t) => t.enabled)
      ?? types[0];
    // list() redacts credentials; resolve() returns the row with its key
    const type = pick ? await this.agentTypes.resolve(pick.id) : undefined;
    const name = type?.provider ?? 'echo';
    return {
      provider: this.providers.resolve(name),
      model: type?.model ?? '',
      apiKey: type?.apiKey ?? undefined,
      baseUrl: type?.baseUrl ?? this.providers.defaultBaseUrl(name),
    };
  }

  /** chars/4, the same estimate compaction uses — no extra model call just
   *  to measure what a model call cost. */
  private estimate(...parts: string[]): number {
    return Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 4);
  }

  private budget(appId: string): { day: string; used: number } {
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.spend.get(appId);
    return cur?.day === day ? cur : { day, used: 0 };
  }

  remaining(appId: string): number {
    return Math.max(0, LLM_TOKENS_PER_DAY - this.budget(appId).used);
  }

  /** One tool-free completion. `schema` (JSON Schema) asks for structured
   *  output so apps parse an object instead of regexing prose. */
  async complete(
    agentId: string,
    appId: string,
    prompt: string,
    opts: { schema?: unknown; maxTokens?: number } = {},
  ): Promise<LlmResult> {
    const { system, text } = await this.prepare(agentId, appId, prompt, opts.schema);
    const { provider, model, apiKey, baseUrl } = await this.resolveProvider();

    let out = '';
    for await (const ev of provider.stream({
      model,
      system,
      messages: [{ role: 'user', content: text }],
      maxTokens: Math.min(opts.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      apiKey,
      baseUrl,
      signal: streamSignal(),
    })) {
      if (ev.type === 'answer') out += ev.text;
    }
    return this.finish(appId, text, out, opts.schema);
  }

  /** Same call, yielding chunks — apps show text as it arrives instead of a
   *  spinner. The host page consumes the HTTP stream and relays chunks into
   *  the frame; the frame itself still has no network. */
  async *stream(
    agentId: string,
    appId: string,
    prompt: string,
    opts: { maxTokens?: number } = {},
  ): AsyncGenerator<{ type: 'chunk'; text: string } | { type: 'done'; result: LlmResult }> {
    const { system, text } = await this.prepare(agentId, appId, prompt, undefined);
    const { provider, model, apiKey, baseUrl } = await this.resolveProvider();

    let out = '';
    for await (const ev of provider.stream({
      model,
      system,
      messages: [{ role: 'user', content: text }],
      maxTokens: Math.min(opts.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      apiKey,
      baseUrl,
      signal: streamSignal(),
    })) {
      if (ev.type === 'answer') { out += ev.text; yield { type: 'chunk', text: ev.text }; }
    }
    yield { type: 'done', result: this.finish(appId, text, out, undefined) };
  }

  /** Shared preflight: gate, budget, and schema framing. */
  private async prepare(agentId: string, appId: string, prompt: string, schema?: unknown) {
    await this.bridge.gate(agentId, appId, 'llm', 'llm.complete');
    const text = (prompt ?? '').trim().slice(0, PROMPT_CAP);
    if (!text) throw new BadRequestException('prompt is required');

    const b = this.budget(appId);
    if (b.used >= LLM_TOKENS_PER_DAY) {
      throw new ForbiddenException(`this app has used its ${LLM_TOKENS_PER_DAY} model tokens for today`);
    }

    // Schema compliance is prompt-level, not provider-enforced: the family of
    // providers behind AiProvider does not share a structured-output API, so
    // we ask for JSON and tell the caller when it did not parse rather than
    // pretending the guarantee is stronger than it is.
    const system = schema
      ? `${LLM_SYSTEM}\n\nRespond with JSON only — no prose, no code fence — matching this JSON Schema:\n${JSON.stringify(schema).slice(0, 4_000)}`
      : LLM_SYSTEM;
    return { system, text };
  }

  /** Shared epilogue: bill the spend, parse structured output if asked. */
  private finish(appId: string, prompt: string, out: string, schema?: unknown): LlmResult {
    const b = this.budget(appId);
    this.spend.set(appId, { day: b.day, used: b.used + this.estimate(prompt, out, LLM_SYSTEM) });

    const text = out.trim();
    const result: LlmResult = { text, remainingTokensToday: this.remaining(appId) };
    if (schema) {
      // models fence JSON even when told not to
      const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      try { result.data = JSON.parse(body) as unknown; } catch (err) {
        result.parseError = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  }
}
