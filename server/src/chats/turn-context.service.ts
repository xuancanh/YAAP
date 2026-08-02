/**
 * TurnContextService — resolves everything a turn needs from the session:
 * the provider adapter + model + credentials from the chat's agent type
 * (FR-9.1/9.4; Echo when none, so the app runs without keys), and the system
 * prompt assembled from the type persona, the owning durable agent's charter
 * (FR-11.1), the workspace's durable memory (FR-12.1), and any pending
 * feedback for the agent — which is drained on read (FR-6.5).
 *
 * API keys resolved here live only for the request; they are never persisted
 * into turns or transcripts (FR-13.3).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiProvider } from '../ai/ai-provider.interface';
import { AiProviderFactory } from '../ai/providers.factory';
import { AgentTypesService } from '../agent-types/agent-types.service';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatSession } from './chats.repository';

export interface TurnContext {
  provider: AiProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  system: string;
  maxToolRounds: number;
}

@Injectable()
export class TurnContextService {
  constructor(
    private readonly providers: AiProviderFactory,
    private readonly agentTypes: AgentTypesService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly config: ConfigService,
  ) {}

  async build(session: ChatSession): Promise<TurnContext> {
    const type = session.agentTypeId ? await this.agentTypes.resolve(session.agentTypeId) : undefined;
    const providerName = type?.provider ?? 'echo';
    const provider = this.providers.resolve(providerName);

    const parts: string[] = [];
    if (type?.persona) parts.push(type.persona);

    if (session.agentId) {
      const agent = await this.agents.get(session.agentId).catch(() => null);
      if (agent) {
        parts.push(`You are the durable agent "${agent.name}".`);
        if (agent.charter) parts.push(`Your charter:\n${agent.charter}`);
        parts.push('You maintain your own home page: use update_dashboard to keep a current markdown status board of your work, and save_app to build or refine self-contained HTML mini apps (rendered in a network-blocked sandbox) that the user can open or embed in chats. Apps can request bridge capabilities (window.yaam: storage, chat.compose, files.read/write/propose/watch, tasks.read/write, agent.ask, llm, data, connections, compute) via save_app\'s capabilities field — request only what the app uses; elevated ones wait for user review. Prefer llm.complete over agent.ask for the app\'s own text work (tagging, extraction, summaries): it is cheaper and returns structured output, while agent.ask spends a full turn of yours. Use data collections rather than cramming rows into storage, files.propose (not files.write) when the user should end up with the file, and files.watch so dashboards stay live instead of freezing at open time. Always feature-detect: if (window.yaam) — and degrade to static rendering without it.');
        parts.push('You also own a kanban board (list_tasks / add_task / update_task). Queue noticed work with add_task, move tasks to doing when you start and done when you finish, and review the board at the start of scheduled loops.');
        parts.push('You have long-term recall: search_history searches all of your past conversations with this user — use it whenever they reference earlier work. When you learn a durable fact about the user (a preference, constraint, or stable context), propose it with update_user_profile; the user approves proposals before they are remembered.');
        parts.push('You grow: when multi-step work goes well (especially after positive feedback), capture the reusable procedure with draft_skill so future conversations can repeat it. Drafts activate only after the user approves them.');
        parts.push('You are one of several durable agents. When work clearly belongs to a colleague (their charter, not yours), delegate it with delegate_task instead of doing it badly yourself.');
        parts.push('Your fs_* tools operate on your own private working folder (it also holds your LESSONS.md, JOURNAL.md and knowledge/; .checkpoints/ is read-only rollback history). Organize it however serves your work.');
        if (agent.workspaceFolder?.trim()) {
          parts.push(`You are also assigned the workspace folder "${agent.workspaceFolder.trim()}", mounted at shared/ — files there are shared with the user and other assignees; read and write them via shared/<path>.`);
        }
        parts.push('When the user asks for the same kind of external lookup repeatedly, build it once with save_tool (a parameterized HTTP tool); it becomes callable after the user approves it.');
        const feedback = await this.agents.takeFeedback(agent.id);
        if (feedback.length > 0) {
          parts.push(`Pending user feedback on your recent replies (acknowledge and adapt; it is cleared after this turn):\n${JSON.stringify(feedback)}`);
        }
      }
    }

    const ws = await this.workspaces.get(session.workspaceId).catch(() => null);
    if (ws?.memory) parts.push(`Workspace memory (shared context for this workspace):\n${ws.memory}`);
    if (ws?.profile) parts.push(`What you know about the user (their consented profile — every line was approved by them):\n${ws.profile}`);

    // Quick replies (FR-5.3): a provider-neutral text protocol the UI parses.
    parts.push('When a short list of likely user responses would genuinely help, end your reply with exactly one final line of the form QUICK_REPLIES: ["option one","option two"] (2-4 options, each under 40 characters). Omit the line otherwise. Never mention this mechanism.');

    return {
      provider,
      model: session.model || type?.model || '',
      apiKey: type?.apiKey ?? undefined,
      baseUrl: type?.baseUrl ?? this.providers.defaultBaseUrl(providerName),
      system: parts.join('\n\n'),
      maxToolRounds: this.config.get<number>('maxToolRounds') ?? 24,
    };
  }
}
