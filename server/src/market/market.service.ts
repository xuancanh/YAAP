/**
 * MarketService — the agent market (FR-11.7). Hiring runs the capability
 * review client-side (the modal), then installs the profile as a durable
 * agent with its charter and loops; loops are enabled immediately, which is
 * exactly why the review happens first.
 */
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { MARKET_CATALOG } from './market.catalog';

@Injectable()
export class MarketService {
  constructor(private readonly agents: AgentsService) {}

  async list() {
    const hiredNames = new Set((await this.agents.list()).map((a) => a.name));
    return MARKET_CATALOG.map((item) => ({ ...item, hired: hiredNames.has(item.name) }));
  }

  async hire(id: string) {
    const item = MARKET_CATALOG.find((m) => m.id === id);
    if (!item) throw new NotFoundException(`market item ${id}`);
    const existing = (await this.agents.list()).find((a) => a.name === item.name);
    if (existing) throw new ConflictException(`${item.name} is already hired`);
    const agent = await this.agents.create({
      name: item.name,
      emoji: item.emoji,
      colors: item.colors,
      role: item.role,
      charter: item.charter,
      loops: item.loops,
    });
    return { ok: true, agent };
  }
}
