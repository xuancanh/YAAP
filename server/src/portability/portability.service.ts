/**
 * PortabilityService — the agent as portable property (execution-plan item 9).
 *
 * Two directions, one rule. Out: AGENT.json v2 carries everything the agent
 * is — identity, loops, dashboard, apps (v1) plus lessons, private skills,
 * open tasks and, on request, the workspace profile. In: whatever comes
 * back, from our own export or from another assistant's, lands as something
 * a person still has to click: lessons quarantined (`import` provenance,
 * trusted only when the user ticks it), skills as drafts, profile lines as
 * proposals, a persona as a charter diff. The import path is how a stranger's
 * text gets into an agent's standing instructions, so it is held to the same
 * posture as a mini app teaching its agent (docs/agent-memory.md §3, §8).
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { AgentMemoryService } from '../agents/agent-memory.service';
import { SkillsService } from '../skills/skills.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { importBundle, IMPORT_FORMATS, ImportContent, ImportFormat } from './importers';

export const AGENT_JSON_FORMAT_VERSION = 2;

export interface ImportOptions {
  /** Default false: imported lessons are quarantined until promoted. */
  trustLessons?: boolean;
  /** Section toggles from the review modal (default: everything present). */
  lessons?: boolean;
  skills?: boolean;
  tasks?: boolean;
  profile?: boolean;
  /** Where profile lines are proposed; without it they are skipped. */
  workspaceId?: string;
}

export interface MemoryImportSummary {
  format: ImportFormat;
  lessons: { added: number; skipped: number; trusted: false };
  profileProposals: { proposed: number; skipped: number; workspaceId: string | null };
  charterSuggestion: { addendum: string; proposed: string } | null;
  files: { used: string[]; ignored: string[] };
}

const SKILL_IMPORT_MAX = 40;
const TASK_IMPORT_MAX = 100;
const PROFILE_PROPOSE_MAX = 30;

@Injectable()
export class PortabilityService {
  constructor(
    private readonly agents: AgentsService,
    private readonly memory: AgentMemoryService,
    private readonly skills: SkillsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** AGENT.json v2. `includeProfile` is opt-in because the profile is the
   *  user's, not the agent's — exporting an agent must not leak it by default. */
  async exportAgent(id: string, opts: { includeProfile?: boolean; workspaceId?: string } = {}) {
    const base = await this.agents.exportJson(id);
    const lessons = (await this.memory.list(id)).map((l) => ({
      text: l.text, sourceKind: l.sourceKind, trusted: l.trusted, pinned: l.pinned, useCount: l.useCount, createdAt: l.createdAt,
    }));
    const skills = (await this.skills.list(undefined, id))
      .filter((s) => s.agentId === id)
      .map((s) => ({ name: s.name, description: s.description, instructions: s.instructions, enabled: s.enabled, draft: s.draft }));
    const tasks = (await this.agents.listTasks(id))
      .filter((t) => t.status !== 'done')
      .map((t) => ({ title: t.title, note: t.note, status: t.status }));
    let profile: string | undefined;
    if (opts.includeProfile) {
      const ws = opts.workspaceId
        ? await this.workspaces.get(opts.workspaceId).catch(() => null)
        : (await this.workspaces.list())[0] ?? null;
      profile = ws?.profile ?? '';
    }
    return {
      formatVersion: AGENT_JSON_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      ...base,
      lessons,
      skills,
      tasks,
      ...(profile !== undefined ? { profile } : {}),
    };
  }

  /**
   * AGENT.json v1 or v2. The v1 core (identity, loops, dashboard, apps) goes
   * through AgentsService.importJson unchanged; the v2 sections are added
   * behind the review modal's toggles. Lessons default to quarantine, skills
   * always land as drafts, tasks as todo, profile lines as proposals.
   */
  async importAgent(profile: Record<string, unknown>, opts: ImportOptions = {}) {
    const version = typeof profile.formatVersion === 'number' ? profile.formatVersion : 1;
    if (version > AGENT_JSON_FORMAT_VERSION) throw new BadRequestException(`AGENT.json formatVersion ${version} is newer than this server understands (${AGENT_JSON_FORMAT_VERSION})`);
    const agent = await this.agents.importJson(profile);
    const summary = { lessons: { added: 0, skipped: 0, trusted: opts.trustLessons === true }, skills: { added: 0, skipped: 0 }, tasks: { added: 0 }, profileProposals: 0 };

    if (opts.lessons !== false && Array.isArray(profile.lessons)) {
      const rows = profile.lessons.filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as Record<string, unknown>).text === 'string');
      const texts = rows.map((l) => l.text as string);
      const pinned = rows.filter((l) => l.pinned === 1 || l.pinned === true).map((l) => l.text as string);
      const res = await this.memory.importLessons(agent.id, texts, { trusted: opts.trustLessons === true, pinned });
      summary.lessons.added = res.added;
      summary.lessons.skipped = res.skipped + (profile.lessons.length - rows.length);
    }
    if (opts.skills !== false && Array.isArray(profile.skills)) {
      for (const raw of profile.skills.slice(0, SKILL_IMPORT_MAX)) {
        const s = raw as Record<string, unknown>;
        if (typeof s?.name !== 'string' || typeof s?.instructions !== 'string' || !s.instructions.trim()) { summary.skills.skipped++; continue; }
        try {
          await this.skills.create({
            name: s.name.toLowerCase().slice(0, 64),
            description: typeof s.description === 'string' ? s.description.slice(0, 300) : '',
            instructions: s.instructions.slice(0, 20_000),
            agentId: agent.id,
            draft: true,
            proposedBy: `import: ${agent.name}`,
          });
          summary.skills.added++;
        } catch { summary.skills.skipped++; }
      }
    }
    if (opts.tasks !== false && Array.isArray(profile.tasks)) {
      for (const raw of profile.tasks.slice(0, TASK_IMPORT_MAX)) {
        const t = raw as Record<string, unknown>;
        if (typeof t?.title !== 'string' || !t.title.trim()) continue;
        await this.agents.addTask(agent.id, { title: t.title, note: typeof t.note === 'string' ? t.note : undefined, origin: 'user' }).catch(() => null);
        summary.tasks.added++;
      }
    }
    if (opts.profile !== false && typeof profile.profile === 'string' && profile.profile.trim() && opts.workspaceId) {
      summary.profileProposals = await this.proposeProfileLines(opts.workspaceId, profile.profile.split('\n'), `import: ${agent.name}`);
    }
    return { agent: await this.agents.get(agent.id), formatVersion: version, summary };
  }

  /** Another assistant's memory → proposals for this agent (item 9.2). */
  async importMemory(agentId: string, input: { format: string; content: ImportContent; workspaceId?: string }): Promise<MemoryImportSummary> {
    const agent = await this.agents.get(agentId);
    if (!IMPORT_FORMATS.includes(input.format as ImportFormat)) {
      throw new BadRequestException(`unknown import format "${input.format}" — one of ${IMPORT_FORMATS.join(', ')}`);
    }
    if (typeof input.content !== 'string' && (!input.content || typeof input.content !== 'object')) {
      throw new BadRequestException('content must be a string or a { filename: text } map');
    }
    const total = typeof input.content === 'string' ? input.content.length : Object.values(input.content).reduce((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);
    if (total > 2_000_000) throw new BadRequestException('import exceeds 2 MB');
    const format = input.format as ImportFormat;
    const bundle = importBundle(format, input.content);

    const lessons = await this.memory.importLessons(agentId, bundle.lessons, { trusted: false });
    let proposed = 0;
    if (input.workspaceId && bundle.profile.length > 0) {
      proposed = await this.proposeProfileLines(input.workspaceId, bundle.profile, `import: ${format}`);
    }
    const charterSuggestion = bundle.charter
      ? {
        addendum: bundle.charter,
        proposed: `${agent.charter.trimEnd()}\n\n## Imported from ${format}\n\n${bundle.charter}`.trim().slice(0, 20_000),
      }
      : null;
    return {
      format,
      lessons: { added: lessons.added, skipped: lessons.skipped, trusted: false },
      profileProposals: { proposed, skipped: bundle.profile.length - proposed, workspaceId: input.workspaceId ?? null },
      charterSuggestion,
      files: bundle.files,
    };
  }

  /** Each line becomes one profile proposal; the queue cap (30) bounds it,
   *  and duplicates of known facts are skipped by WorkspacesService. */
  private async proposeProfileLines(workspaceId: string, lines: string[], agentName: string): Promise<number> {
    let proposed = 0;
    for (const raw of lines) {
      if (proposed >= PROFILE_PROPOSE_MAX) break;
      const entry = raw.replace(/^\s*[-*•]\s*/, '').trim();
      if (entry.length < 3) continue;
      const res = await this.workspaces.addProfileProposal(workspaceId, { entry, agentName }).catch(() => '');
      if (res.startsWith('Proposed')) proposed++;
    }
    return proposed;
  }
}
