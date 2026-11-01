/**
 * LoopsController — the agent-home side of event triggers (docs/triggers.md):
 * per-loop trigger state for the loop list ("last fired"), and minting the
 * shared secret of a webhook loop, returned exactly once.
 */
import { Controller, Get, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsService } from '../agents/agents.service';
import { LoopsService } from './loops.service';

@Controller('agents')
export class LoopsController {
  constructor(
    private readonly loops: LoopsService,
    private readonly agents: AgentsService,
    private readonly config: ConfigService,
  ) {}

  @Get(':id/loops/state')
  states(@Param('id') id: string) {
    return this.loops.states(id);
  }

  /** Mint a new secret for a webhook loop; the old one stops working. */
  @Post(':id/loops/:name/webhook-secret')
  async rotate(@Param('id') id: string, @Param('name') name: string) {
    const { secret, path } = await this.agents.rotateWebhookSecret(id, name);
    const base = (this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790').replace(/\/+$/, '');
    return { secret, path, url: `${base}${path}?token=${secret}` };
  }
}
