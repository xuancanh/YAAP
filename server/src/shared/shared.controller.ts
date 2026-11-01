/**
 * SharedController — the HTTP surface of shared workspaces (docs/shared-agents.md).
 *
 *  GET    /api/workspaces/shared                       workspaces shared with me (picker)
 *  GET    /api/workspaces/:id/me                       who am I here: actor id, role, display names
 *  GET    /api/workspaces/:id/members                  members (owner, member, viewer may read)
 *  PATCH  /api/workspaces/:id/members/:memberId        { role }            owner only (guard)
 *  DELETE /api/workspaces/:id/members/:memberId                            owner only (guard)
 *  GET    /api/workspaces/:id/invites                  pending invitations  owner only (guard on writes)
 *  POST   /api/workspaces/:id/invites                  { email, role }     owner only (guard)
 *  DELETE /api/workspaces/:id/invites/:inviteId                            owner only (guard)
 *  GET    /api/invites/accept?token=                   the mailed link; signed in as the invitee
 *  GET    /api/workspaces/:id/flow-rules               information-flow rules
 *  POST   /api/workspaces/:id/flow-rules               { fromMember, toMember?, effect?, kind }  owner only
 *  DELETE /api/workspaces/:id/flow-rules/:ruleId                           owner only
 *  GET    /api/workspaces/:id/my-connections           the caller's own connections (their account), for granting
 *  GET    /api/workspaces/:id/member-grants            grants that use members' connections
 *  POST   /api/workspaces/:id/member-grants            { connectionId, agentId, service, level } — your own connection only
 *  DELETE /api/workspaces/:id/member-grants/:grantId   your own, or any as owner
 *  GET    /api/workspaces/:id/channels                 my channel pairings here (all, as owner)
 *  DELETE /api/workspaces/:id/channels/:kind           unpair my channel
 *
 * The WorkspaceAccessGuard has already put a member inside the owner's
 * account by the time a handler runs; `actorId()` says who they are.
 */
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Patch, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { actorId, currentAccountId, currentViewer, type MemberRole } from '../accounts/account-context';
import { AccountsService } from '../accounts/accounts.service';
import { ConnectionsService } from '../connections/connections.service';
import type { ConnectionService as ServiceName } from '../connections/connections.tools';
import { SharedService, type FlowKind } from './shared.service';

class InviteDto {
  @IsString() email!: string;
  @IsOptional() @IsIn(['member', 'viewer']) role?: 'member' | 'viewer';
}
class RoleDto { @IsIn(['owner', 'member', 'viewer']) role!: MemberRole }
class FlowRuleDto {
  @IsString() fromMember!: string;
  @IsOptional() @IsString() toMember?: string;
  @IsOptional() @IsIn(['allow', 'deny']) effect?: 'allow' | 'deny';
  @IsIn(['lessons', 'connections', 'files']) kind!: FlowKind;
}
class MemberGrantDto {
  @IsString() connectionId!: string;
  @IsString() agentId!: string;
  @IsIn(['calendar', 'gmail', 'drive']) service!: ServiceName;
  @IsIn(['read', 'write']) level!: 'read' | 'write';
}

@Controller('workspaces')
export class SharedController {
  constructor(
    private readonly shared: SharedService,
    private readonly connections: ConnectionsService,
  ) {}

  @Get('shared') sharedWithMe() { return this.shared.sharedWithMe(); }

  @Get(':id/me')
  async me(@Param('id') id: string) {
    const viewer = currentViewer();
    const names = await this.shared.displayNames(id);
    return {
      actorId: actorId(),
      role: viewer?.role ?? 'owner',
      ownerAccountId: currentAccountId(),
      names: Object.fromEntries(names),
      hasMembers: await this.shared.hasMembers(id),
    };
  }

  @Get(':id/members') members(@Param('id') id: string) { return this.shared.members(id); }
  @Patch(':id/members/:memberId') setRole(@Param('id') id: string, @Param('memberId') memberId: string, @Body() dto: RoleDto) { return this.shared.setRole(id, memberId, dto.role); }
  @Delete(':id/members/:memberId') removeMember(@Param('id') id: string, @Param('memberId') memberId: string) { return this.shared.removeMember(id, memberId); }

  @Get(':id/invites') invites(@Param('id') id: string) { return this.shared.invites(id); }
  @Post(':id/invites') invite(@Param('id') id: string, @Body() dto: InviteDto) { return this.shared.invite(id, dto); }
  @Delete(':id/invites/:inviteId') revokeInvite(@Param('id') id: string, @Param('inviteId') inviteId: string) { return this.shared.revokeInvite(id, inviteId); }

  @Get(':id/flow-rules') flowRules(@Param('id') id: string) { return this.shared.flowRules(id); }
  @Post(':id/flow-rules') addFlowRule(@Param('id') id: string, @Body() dto: FlowRuleDto) { return this.shared.addFlowRule(id, dto); }
  @Delete(':id/flow-rules/:ruleId') removeFlowRule(@Param('id') id: string, @Param('ruleId') ruleId: string) { return this.shared.removeFlowRule(id, ruleId); }

  // ---- per-member connection grants ----

  /** The caller's own connections (in their own account), redacted. */
  @Get(':id/my-connections') myConnections() { return this.connections.listOwnedBy(actorId()); }

  @Get(':id/member-grants') memberGrants() { return this.connections.memberGrants(); }

  @Post(':id/member-grants')
  async setMemberGrant(@Param('id') id: string, @Body() dto: MemberGrantDto) {
    const me = actorId();
    if (!(await this.shared.hasMembers(id)) && !currentViewer()) {
      throw new BadRequestException('this workspace has no members yet; grant connections on the agent instead');
    }
    // A member grants their own connection; the owner may grant their own too
    // (that is the ordinary agent grant) but never someone else's.
    return this.connections.setGrant(dto.connectionId, dto.agentId, dto.service, dto.level, { memberAccountId: me });
  }

  @Delete(':id/member-grants/:grantId')
  async removeMemberGrant(@Param('grantId') grantId: string) {
    const viewer = currentViewer();
    return this.connections.removeMemberGrant(grantId, viewer ? viewer.memberAccountId : undefined);
  }

  // ---- per-member channel pairings (pairing codes: POST /api/channels/telegram/pair-code
  //      with the workspace header mints a member code; see telegram.service.ts) ----

  @Get(':id/channels') myChannels(@Param('id') id: string) {
    const viewer = currentViewer();
    return this.shared.channels(id, viewer?.memberAccountId);
  }

  @Delete(':id/channels/:kind')
  unpairChannel(@Param('id') id: string, @Param('kind') kind: string) {
    if (kind !== 'telegram' && kind !== 'email') throw new BadRequestException('kind must be telegram or email');
    const viewer = currentViewer();
    if (!viewer) throw new ForbiddenException('members unpair their own channels here; the owner uses Settings → Channels');
    return this.shared.unpairChannel(id, viewer.memberAccountId, kind);
  }
}

@Controller('invites')
export class InvitesController {
  constructor(private readonly shared: SharedService, private readonly accounts: AccountsService, private readonly config: ConfigService) {}

  /** The mailed link. Authenticated by the global guard (session cookie);
   *  redirects into the app on success, or renders the reason. */
  @Get('accept')
  async accept(@Query('token') token: string | undefined, @Req() req: Request, @Res() res: Response) {
    const appUrl = (this.config.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
    const wantsJson = (req.headers.accept ?? '').includes('application/json');
    try {
      const me = await this.accounts.current();
      const joined = await this.shared.acceptInvite(token ?? '', me);
      if (wantsJson) { res.json(joined); return; }
      res.redirect(302, `${appUrl}/?workspace=${encodeURIComponent(joined.workspaceId)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not accept the invitation';
      const status = (err as { getStatus?: () => number }).getStatus?.() ?? 400;
      if (wantsJson) { res.status(status).json({ message }); return; }
      res.status(status).type('text/html').send(
        `<!doctype html><meta charset="utf-8"><title>Invitation</title><body style="font-family:system-ui;padding:40px;text-align:center"><h3>That invitation did not work</h3><p>${message.replace(/[<>&]/g, '')}</p><p><a href="${appUrl}/">Open the app</a></p></body>`,
      );
    }
  }
}
