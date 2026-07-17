/**
 * AiProviderFactory — resolves a chat's provider name (from its agent type)
 * to a streaming adapter. `anthropic-compatible` reuses the Anthropic adapter
 * with the type's baseUrl; OpenAI, DeepSeek, Kimi, GLM, and custom endpoints
 * share the OpenAI-compatible adapter with per-provider default base URLs.
 * Remaining FR-9.2 providers (Gemini native, Bedrock) still to come.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { AiProvider } from './ai-provider.interface';
import { AnthropicAiProvider } from './anthropic-ai.provider';
import { OpenAiCompatProvider, OPENAI_COMPAT_BASE_URLS } from './openai-ai.provider';
import { EchoAiProvider } from './echo-ai.provider';

@Injectable()
export class AiProviderFactory {
  constructor(
    private readonly anthropic: AnthropicAiProvider,
    private readonly openai: OpenAiCompatProvider,
    private readonly echo: EchoAiProvider,
  ) {}

  resolve(name: string): AiProvider {
    switch (name) {
      case 'anthropic':
      case 'anthropic-compatible':
        return this.anthropic;
      case 'openai':
      case 'deepseek':
      case 'kimi':
      case 'glm':
      case 'custom':
      case 'openai-compatible':
        return this.openai;
      case 'echo':
        return this.echo;
      default:
        throw new BadRequestException(`provider "${name}" is not supported yet`);
    }
  }

  /** The default endpoint for a provider when the agent type sets none. */
  defaultBaseUrl(name: string): string | undefined {
    return OPENAI_COMPAT_BASE_URLS[name] || undefined;
  }
}
