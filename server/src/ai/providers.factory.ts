/**
 * AiProviderFactory — resolves a chat's provider name (from its agent type)
 * to a streaming adapter. `anthropic-compatible` reuses the Anthropic adapter
 * with the type's baseUrl. The remaining FR-9.2 providers (OpenAI, DeepSeek,
 * Kimi, Gemini, GLM, Bedrock) land here as adapters are written.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { AiProvider } from './ai-provider.interface';
import { AnthropicAiProvider } from './anthropic-ai.provider';
import { EchoAiProvider } from './echo-ai.provider';

@Injectable()
export class AiProviderFactory {
  constructor(
    private readonly anthropic: AnthropicAiProvider,
    private readonly echo: EchoAiProvider,
  ) {}

  resolve(name: string): AiProvider {
    switch (name) {
      case 'anthropic':
      case 'anthropic-compatible':
        return this.anthropic;
      case 'echo':
        return this.echo;
      default:
        throw new BadRequestException(`provider "${name}" is not supported yet`);
    }
  }
}
