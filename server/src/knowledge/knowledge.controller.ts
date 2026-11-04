/**
 * The knowledge base over HTTP (docs/knowledge-base.md): what the agent page
 * shows — the role's knowledge base and its files under /library/ — and an
 * install on demand (the page's "Install" when the files are missing).
 */
import { Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';

@Controller('agents')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get(':id/knowledge')
  async get(@Param('id') id: string) {
    const out = await this.knowledge.forAgent(id);
    if (!out) throw new NotFoundException(`agent ${id}`);
    return out;
  }

  @Post(':id/knowledge/install')
  async install(@Param('id') id: string) {
    if (!(await this.knowledge.forAgent(id))) throw new NotFoundException(`agent ${id}`);
    return this.knowledge.installFor(id);
  }
}
