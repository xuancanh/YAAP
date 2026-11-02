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
import { AUTHORED_PACKS } from './authored-packs.generated';
import { orgHireRef, segmentOf, segmentSummary } from './segments';

const CATALOG = [...AUTHORED_PACKS, ...PROFESSION_PACKS];

@Injectable()
export class MarketService {
  constructor(private readonly agents: AgentsService, private readonly skills: SkillsService) {}

  async list(workspaceId?: string) {
    const hiredNames = new Set((await this.agents.list({ workspaceId })).map((a) => a.name));
    // Skill bodies stay server-side; the client only needs names for review.
    return CATALOG.map(({ skills, ...item }) => ({
      ...item,
      segment: segmentOf(item),
      // The `templateOrPack` a company hire of this pack sends (null: none).
      orgHire: orgHireRef(item),
      hired: hiredNames.has(item.name),
      ...(skills ? { skills: skills.map((s) => ({ name: s.name, description: s.description })) } : {}),
    }));
  }

  /** The two layers with their counts: personal categories and business
   *  functions in rail order (docs/agent-catalog.md "Segments and functions"). */
  segments() {
    return segmentSummary(CATALOG);
  }

  /** The full instruction text of a pack's bundled skills. The hire review is
   *  their activation gate, and a gate that shows only names is not a review
   *  (docs/permissions.md: show the real artifact, not a summary). Fetched on
   *  demand so the catalog listing stays small. */
  packSkills(id: string) {
    const item = CATALOG.find((m) => m.id === id);
    if (!item) throw new NotFoundException(`market item ${id}`);
    return (item.skills ?? []).map((s) => ({
      name: s.name, description: s.description, instructions: s.instructions,
    }));
  }

  /** Hire into `workspaceId` (the account's default when none is named):
   *  the hired agent belongs to that workspace alone. */
  async hire(id: string, workspaceId?: string) {
    const item = CATALOG.find((m) => m.id === id);
    if (!item) throw new NotFoundException(`market item ${id}`);
    const existing = (await this.agents.list({ workspaceId })).find((a) => a.name === item.name);
    if (existing) throw new ConflictException(`${item.name} is already hired`);
    const agent = await this.agents.create({
      name: item.name,
      workspaceId,
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
