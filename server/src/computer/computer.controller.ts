/**
 * /api/computer — two audiences on one controller (docs/computer-control.md):
 *
 *  User (app bearer / single-user):   pair-code, status, pause, resume,
 *                                     disconnect, scopes (narrow only), actions
 *  Companion (code, then its token):  pair (code-protected, public),
 *                                     work (long poll), result/:id, heartbeat
 *
 * The companion routes carry CompanionGuard; TokenAuthStrategy lists them as
 * public so the user-token check steps aside for exactly these paths.
 */
import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { ComputerService } from './computer.service';
import { CompanionGuard, CompanionRequest } from './companion.guard';

/** How long GET /work holds the connection before answering 204. */
const WORK_POLL_MS = 25_000;

class PairDto {
  @IsString() @MaxLength(32) code!: string;
  @IsString() @MaxLength(80) name!: string;
  @IsString() @MaxLength(20) platform!: string;
  @IsArray() scopes!: string[];
}

class ScopesDto {
  @IsArray() scopes!: string[];
}

class ResultDto {
  @IsBoolean() ok!: boolean;
  @IsOptional() @IsString() output?: string;
  @IsOptional() @IsString() pngBase64?: string;
  @IsOptional() @IsInt() width?: number;
  @IsOptional() @IsInt() height?: number;
}

@Controller('computer')
export class ComputerController {
  constructor(private readonly svc: ComputerService) {}

  // ---- user ----

  @Post('pair-code') pairCode() { return this.wrap(() => this.svc.mintPairCode()); }
  @Get('status') status() { return this.svc.status(); }
  @Post('pause') pause() { return this.svc.pause(); }
  @Post('resume') resume() { return this.svc.resume(); }
  @Post('disconnect') disconnect() { return this.svc.disconnect(); }
  @Post('scopes') scopes(@Body() dto: ScopesDto) { return this.wrap(() => this.svc.narrowScopes(dto.scopes)); }
  @Get('actions') actions(@Query('limit') limit?: string) { return this.svc.actions(limit ? Number(limit) : 50); }

  // ---- companion ----

  /** Public (no app bearer): protected by the 10-minute code alone. */
  @Post('pair')
  pair(@Body() dto: PairDto) {
    return this.wrap(() => this.svc.pair(dto));
  }

  @UseGuards(CompanionGuard)
  @Get('work')
  async work(@Req() req: CompanionRequest, @Res() res: Response) {
    const item = await this.svc.nextWork(req.companion, WORK_POLL_MS);
    if (!item) { res.status(204).end(); return; }
    res.json(item);
  }

  @UseGuards(CompanionGuard)
  @Post('result/:id')
  result(@Req() req: CompanionRequest, @Param('id') id: string, @Body() dto: ResultDto) {
    return this.svc.submitResult(req.companion, id, dto);
  }

  @UseGuards(CompanionGuard)
  @Post('heartbeat')
  heartbeat(@Req() req: CompanionRequest) {
    return this.svc.heartbeat(req.companion);
  }

  /** Plain validation errors from the service become 400s, not 500s. */
  private async wrap<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error && !('getStatus' in err)) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
