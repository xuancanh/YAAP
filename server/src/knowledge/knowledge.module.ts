/**
 * KnowledgeModule — the curated knowledge base each agent pack ships with
 * (docs/knowledge-base.md). Global so the hire doors (MarketService, the
 * company's hire approvals) install a new agent's library without importing
 * it; it depends on nothing but the database and the filesystem.
 * KnowledgeToolsModule offers kb_search / kb_read / kb_list on the turn loop.
 */
import { Global, Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeTools } from './knowledge.tools';

@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}

@Module({
  imports: [ChatsModule],
  providers: [KnowledgeTools],
})
export class KnowledgeToolsModule {}
