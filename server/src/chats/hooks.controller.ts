/**
 * HooksController — POST /api/hooks/:agentId/:loopName?token=<secret>: the
 * inbound end of a webhook-triggered loop (docs/triggers.md). The route is
 * public (TokenAuthStrategy.isPublic) because the caller is a third-party
 * system, not the user; the loop's own secret authenticates it, compared
 * timing-safe in LoopsService.fireWebhook, which also rate-limits 30/min per
 * hook and caps the body at 64KB. Any JSON is accepted and becomes the
 * untrusted trigger payload; the response is 202 and says nothing more.
 */
import { Body, Controller, Headers, HttpCode, Param, PayloadTooLargeException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { LoopsService, WEBHOOK_BODY_CAP } from './loops.service';

@Controller('hooks')
export class HooksController {
  constructor(private readonly loops: LoopsService) {}

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
    return this.loops.fireWebhook(agentId, loopName, token || bearer, body ?? {});
  }
}
