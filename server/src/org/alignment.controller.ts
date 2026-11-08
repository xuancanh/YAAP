/**
 * CEO alignment routes (docs/alignment.md), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/alignments                       every gated item with its state, brief, classification and thread
 *  GET    /api/workspaces/:id/org/alignments/classes               the classes (what needs the CEO, criteria, rationale, sources) and who aligns each here
 *  GET    /api/workspaces/:id/org/alignments/spot-check            under- and over-escalation findings
 *  GET    /api/workspaces/:id/org/alignments/:alignmentId          one item
 *  POST   /api/workspaces/:id/org/alignments/:alignmentId/comment  { text } — a comment on the thread (reaches the owner agent)
 *  POST   /api/workspaces/:id/org/alignments/:alignmentId/decide   { decision: approve | approve_with_changes | send_back | reject | pull_in | not_needed, note? }
 *
 * A decision on an item with a pending card goes through the approvals path
 * (OrgController.decide: who may decide, delegations, the decision log);
 * otherwise the CEO aligns a draft directly, reviews or overrides an
 * alignment granted without them, pulls in an item an agent did not
 * escalate, or says an escalation was not needed. Writes are the CEO's.
 */
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgAlignmentService } from './org-alignment.service';
import { ALIGNMENT_CLASS_DEFS, ALIGNMENT_CRITERIA, ALIGNMENT_SOURCES, alignerFor, floorRequired } from './alignment';

export class AlignmentCommentDto { @IsString() text!: string }
export class AlignmentDecideDto {
  @IsIn(['approve', 'approve_with_changes', 'send_back', 'reject', 'pull_in', 'not_needed']) decision!: 'approve' | 'approve_with_changes' | 'send_back' | 'reject' | 'pull_in' | 'not_needed';
  @IsOptional() @IsString() note?: string;
}

@Controller('workspaces/:id/org/alignments')
export class AlignmentController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly alignment: OrgAlignmentService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  private async ceo(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo') throw new ForbiddenException(role === 'observer' || role === 'board' ? 'alignment is the CEO\'s: you can read it and comment' : 'you have no standing in this organisation');
    return this.orgs.actorName();
  }

  private async member(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (!role) throw new ForbiddenException('you have no standing in this organisation');
    return this.orgs.actorName();
  }

  @Get() async list(@Param('id') id: string) { return this.alignment.list(await this.oid(id)); }

  @Get('classes') async classes(@Param('id') id: string) {
    const orgId = await this.oid(id);
    const org = await this.org.get(orgId);
    const mode = await this.alignment.modeOf(org);
    return {
      mode,
      classes: ALIGNMENT_CLASS_DEFS.map((c) => ({ id: c.id, label: c.label, covers: c.covers, examples: c.examples, criteria: c.criteria, rationale: c.rationale, sources: c.sources, aligner: alignerFor(org, mode, c.id), floor: floorRequired(org, mode, c.id) })),
      criteria: ALIGNMENT_CRITERIA,
      sources: ALIGNMENT_SOURCES,
    };
  }

  @Get('spot-check') async spotCheck(@Param('id') id: string) { return this.alignment.spotCheck(await this.oid(id)); }

  @Get(':alignmentId') async one(@Param('id') id: string, @Param('alignmentId') alignmentId: string) { return this.alignment.get(await this.oid(id), alignmentId); }

  @Post(':alignmentId/comment') async comment(@Param('id') id: string, @Param('alignmentId') alignmentId: string, @Body() dto: AlignmentCommentDto) {
    const orgId = await this.oid(id);
    return this.alignment.comment(orgId, alignmentId, dto.text, await this.member(orgId));
  }

  @Post(':alignmentId/decide') async decide(@Param('id') id: string, @Param('alignmentId') alignmentId: string, @Body() dto: AlignmentDecideDto) {
    const orgId = await this.oid(id);
    const actor = await this.ceo(orgId);
    const note = (dto.note ?? '').trim();
    const v = await this.alignment.get(orgId, alignmentId);
    if (dto.decision === 'approve_with_changes' && !note) throw new BadRequestException('approve with changes needs the changes (the note)');
    if (dto.decision === 'send_back' && !note) throw new BadRequestException('send back needs your comments');
    if (v.approvalId && ['approve', 'approve_with_changes', 'send_back', 'reject'].includes(dto.decision)) {
      const decision = dto.decision === 'send_back' ? 'revise' : dto.decision === 'reject' ? 'reject' : 'approve';
      await this.orgs.decide(orgId, v.approvalId, { decision, note });
      return this.alignment.get(orgId, alignmentId);
    }
    return this.alignment.ceoAct(orgId, alignmentId, dto.decision, note, actor);
  }
}
