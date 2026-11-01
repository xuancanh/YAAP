/**
 * HooksController — POST /api/hooks/:agentId/:loopName?token=<secret>: the
 * inbound end of a webhook-triggered loop (docs/triggers.md). The route is
 * public (isPublicRoute) because the caller is a third-party system, not the
 * user; the loop's own secret authenticates it, compared timing-safe in
 * LoopsService.fireWebhook, which also rate-limits 30/min per hook and caps
 * the body at 64KB. Any JSON is accepted and becomes the untrusted trigger
 * payload; the response is 202 and says nothing more.
 *
 * Tenancy: no account is signed in here, so the account is the one that owns
 * the agent (resolved unscoped), and the fire runs under it. An unknown agent
 * still goes through fireWebhook so the answer is the same 401.
 */
import { Body, Controller, Headers, HttpCode, Optional, Param, PayloadTooLargeException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { LoopsService, WEBHOOK_BODY_CAP } from './loops.service';
import { AccountsService } from '../accounts/accounts.service';
import { runWithAccount } from '../accounts/account-context';

@Controller('hooks')
export class HooksController {
  constructor(
    private readonly loops: LoopsService,
    /** Optional so test constructors keep working; without it the fire runs
     *  in the current (single) account. */
    @Optional() private readonly accounts?: AccountsService,
  ) {}

  @Post(':agentId/:loopName')
  @HttpCode(202)
  async post(
    @Param('agentId') agentId: string,
    @Param('loopName') loopName: string,
    @Query('token') token: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > WEBHOOK_BODY_CAP) throw new PayloadTooLargeException(`webhook body must be ≤${WEBHOOK_BODY_CAP} bytes`);
    // `?token=` is the documented form; a bearer header works for senders
    // that cannot put secrets in URLs.
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const fire = () => this.loops.fireWebhook(agentId, loopName, token || bearer, body ?? {});
    const accountId = this.accounts ? await this.accounts.accountOfAgent(agentId) : null;
    return accountId ? runWithAccount(accountId, fire) : fire();
  }
}
