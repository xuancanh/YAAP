/**
 * `request_model_tier` (docs/agent-types.md "Model selection"): an agent in
 * auto mode may ask for a stronger or a cheaper model for its next turn or
 * run, with a reason. The platform applies it within its guardrails — at
 * most `model.requestCap` tiers off the computed one, never below the risk
 * floor, inside the floor and ceiling — and records the request and what
 * came of it on the decision. Offered only to agents in auto mode, in every
 * session kind alike (agent channel parity).
 */
import { Injectable, Optional } from '@nestjs/common';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import type { ChatSession } from './chats.repository';
import { TurnLoopService, type ToolProviderHook } from './turn-loop.service';
import { ModelSelectionService } from './model-selection.service';
import { AgentsService } from '../agents/agents.service';
import { isTierName } from '../agent-types/model-resolution';

export const REQUEST_MODEL_TIER: AiToolSpec = {
  name: 'request_model_tier',
  description: 'You run in auto model mode: the platform picks your model per turn from the work\'s complexity. Ask for a stronger (or cheaper) tier for your NEXT turn or run when the work clearly needs it — e.g. strong for a hard multi-step analysis, cheap for routine follow-up. Capped by the workspace; the reason is recorded.',
  inputSchema: { type: 'object', properties: { tier: { type: 'string', enum: ['cheap', 'standard', 'strong'] }, reason: { type: 'string', description: 'One line: why this work needs that tier.' } }, required: ['tier', 'reason'] },
};

@Injectable()
export class ModelTierTools implements ToolProviderHook {
  constructor(
    private readonly selection: ModelSelectionService,
    private readonly agents: AgentsService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!session.agentId) return [];
    const agent = await this.agents.get(session.agentId).catch(() => null);
    if (!agent) return [];
    return (await this.selection.modeFor(agent, session.workspaceId)) === 'auto' ? [REQUEST_MODEL_TIER] : [];
  }

  owns(name: string): boolean { return name === REQUEST_MODEL_TIER.name; }
  isReadOnly(): boolean { return true; }
  async contextFor(): Promise<string | null> { return null; }

  async execute(session: ChatSession, _name: string, input: Record<string, unknown>): Promise<string> {
    const tier = input.tier;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!isTierName(tier)) return 'Refused: tier must be cheap, standard or strong.';
    if (!reason) return 'Refused: give a one-line reason.';
    this.selection.requestTier(session.id, tier, reason);
    return `Noted: your next turn here asks for the ${tier} tier ("${reason.slice(0, 120)}"). The platform applies it within the workspace's limits and records the decision; this turn keeps its current model.`;
  }
}
