/**
 * AgentApprovalsController — the addressee's side of a routed approval
 * (docs/shared-agents.md §3).
 *
 *  POST /api/agents/:id/events/:eventId/decide { decision: 'allow' | 'deny' }
 *
 * A turn another member started wants to run a mutating tool on *this*
 * member's connection. The turn is paused on an `approval_request` inbox
 * event addressed to them; this route lets them (and only them) answer it,
 * which resumes or denies the paused call through the same resolver a live
 * approval uses. Anyone else gets a 404 — the event is invisible to them, so
 * its existence is not confirmed. After the turn loop's TTL the call has
 * already been denied and the answer reports `resolved: false`.
 *
 * Lives in ChatsModule (it needs TurnLoopService) under the agents prefix so
 * the URL reads as part of the inbox.
 */
import { BadRequestException, Body, Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { actorId, currentAccountId } from '../accounts/account-context';
import { AgentsService } from '../agents/agents.service';
import { TurnLoopService } from './turn-loop.service';

class DecideDto { @IsIn(['allow', 'deny']) decision!: 'allow' | 'deny' }

@Controller('agents')
export class AgentApprovalsController {
  constructor(private readonly agents: AgentsService, private readonly turns: TurnLoopService) {}

  @Post(':id/events/:eventId/decide')
  async decide(@Param('id') id: string, @Param('eventId') eventId: string, @Body() dto: DecideDto) {
    const me = actorId();
    const ev = await this.agents.getEvent(id, eventId);
    // '' addresses the owner (the channel runtime and turn loop store the
    // owner's own approvals that way); anyone else must be the named member.
    const addressee = ev.forMemberAccountId || currentAccountId();
    if (addressee !== me) throw new NotFoundException(`event ${eventId}`);
    if (ev.kind !== 'approval_request') throw new BadRequestException(`this request was already ${ev.kind.replace('approval_', '')}`);
    const payload = JSON.parse(ev.payload || '{}') as { callId?: string };
    if (!ev.sessionId || !payload.callId) throw new BadRequestException('event has no pending call');
    const resolved = this.turns.resolveApproval(ev.sessionId, payload.callId, dto.decision === 'allow' ? 'allow-once' : 'deny', me);
    if (!resolved) {
      // The turn loop's TTL denied it (or the turn ended): record that.
      await this.agents.patchEvent(ev.id, { kind: 'approval_expired', readAt: new Date().toISOString() });
    }
    return { resolved, decision: dto.decision };
  }
}
