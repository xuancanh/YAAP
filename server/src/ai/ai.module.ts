/**
 * AiModule — provider adapters behind the provider-neutral factory.
 * The Echo development provider is the default when a chat has no agent type,
 * so the app runs end to end without credentials.
 */
import { Module } from '@nestjs/common';
import { AiProviderFactory } from './providers.factory';
import { AnthropicAiProvider } from './anthropic-ai.provider';
import { OpenAiCompatProvider } from './openai-ai.provider';
import { EchoAiProvider } from './echo-ai.provider';
import { ProviderHealthService } from './provider-health';

@Module({
  providers: [
    AiProviderFactory,
    // Built via factory: the constructor's injectable fetch function is a test
    // seam, not a DI dependency.
    { provide: AnthropicAiProvider, useFactory: () => new AnthropicAiProvider() },
    { provide: OpenAiCompatProvider, useFactory: () => new OpenAiCompatProvider() },
    EchoAiProvider,
    // Degradation (execution-plan item 29): in-memory provider health per workspace.
    ProviderHealthService,
  ],
  exports: [AiProviderFactory, ProviderHealthService],
})
export class AiModule {}
