/**
 * AiModule — binds the provider-neutral AI_PROVIDER token.
 *
 * Currently the Echo development provider; real adapters (Anthropic first,
 * then the rest of FR-9.2) will be selected per-request from the chat's agent
 * type instead of a single static binding.
 */
import { Module } from '@nestjs/common';
import { AI_PROVIDER } from './ai-provider.interface';
import { EchoAiProvider } from './echo-ai.provider';

@Module({
  providers: [{ provide: AI_PROVIDER, useClass: EchoAiProvider }],
  exports: [AI_PROVIDER],
})
export class AiModule {}
