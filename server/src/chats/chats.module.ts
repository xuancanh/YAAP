/**
 * ChatsModule — conversations, the transcript, and the streaming turn loop.
 * Depends on AiModule for the provider-neutral LLM interface.
 */
import { Module } from '@nestjs/common';
import { ChatsController } from './chats.controller';
import { ChatsService } from './chats.service';
import { ChatsRepository } from './chats.repository';
import { TurnLoopService } from './turn-loop.service';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AiModule],
  controllers: [ChatsController],
  providers: [ChatsService, ChatsRepository, TurnLoopService],
  exports: [ChatsService],
})
export class ChatsModule {}
