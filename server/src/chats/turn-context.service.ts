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
    const provider = this.providers.resolve(type?.provider ?? 'echo');

    const parts: string[] = [];
    if (type?.persona) parts.push(type.persona);

    if (session.agentId) {
      const agent = await this.agents.get(session.agentId).catch(() => null);
      if (agent) {
        parts.push(`You are the durable agent "${agent.name}".`);
        if (agent.charter) parts.push(`Your charter:\n${agent.charter}`);
        const feedback = await this.agents.takeFeedback(agent.id);
        if (feedback.length > 0) {
          parts.push(`Pending user feedback on your recent replies (acknowledge and adapt; it is cleared after this turn):\n${JSON.stringify(feedback)}`);
        }
      }
    }

    const ws = await this.workspaces.get(session.workspaceId).catch(() => null);
    if (ws?.memory) parts.push(`Workspace memory (shared context for this workspace):\n${ws.memory}`);

    return {
      provider,
      model: session.model || type?.model || '',
      apiKey: type?.apiKey ?? undefined,
      baseUrl: type?.baseUrl ?? undefined,
      system: parts.join('\n\n'),
      maxToolRounds: this.config.get<number>('maxToolRounds') ?? 24,
    };
  }
}
