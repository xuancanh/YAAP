/**
 * MarketService — the agent market (FR-11.7). Hiring runs the capability
 * review client-side (the modal), then installs the profile as a durable
 * agent with its charter and loops; loops are enabled immediately, which is
 * exactly why the review happens first. Profession packs additionally carry
 * bundled skills, installed private to the hired agent (skills are read-only
 * instruction text, so the hire review is their activation gate).
 */
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { PROFESSION_PACKS } from './profession-packs.generated';

const CATALOG = PROFESSION_PACKS;

@Injectable()
export class MarketService {
  constructor(private readonly agents: AgentsService, private readonly skills: SkillsService) {}

  async list() {
    const hiredNames = new Set((await this.agents.list()).map((a) => a.name));
    // Skill bodies stay server-side; the client only needs names for review.
    return CATALOG.map(({ skills, ...item }) => ({
      ...item,
      hired: hiredNames.has(item.name),
      ...(skills ? { skills: skills.map((s) => ({ name: s.name, description: s.description })) } : {}),
    }));
  }

  async hire(id: string) {
    const item = CATALOG.find((m) => m.id === id);
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
    for (const s of item.skills ?? []) {
      // A name shadowed by a global/builtin skill just skips; the rest install.
      await this.skills.create({
        name: s.name, description: s.description, instructions: s.instructions, agentId: agent.id,
      }).catch(() => {});
    }
    return { ok: true, agent };
  }
}
