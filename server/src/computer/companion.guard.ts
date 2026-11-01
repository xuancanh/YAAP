/**
 * CompanionGuard — the second bearer kind on the API. The paired companion's
 * token (sha256 stored in `computer_runners.tokenHash`) authenticates ONLY
 * the three routes this guard sits on: GET /api/computer/work,
 * POST /api/computer/result/:id and POST /api/computer/heartbeat. It cannot
 * reach any user route — TokenAuthStrategy marks exactly those paths public
 * for the user-token check, and nothing else — so a leaked companion token
 * lets an attacker pull queued actions, not drive the app.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ComputerService } from './computer.service';
import type { computerRunners } from '../database/schema';

export interface CompanionRequest extends Request {
  companion: typeof computerRunners.$inferSelect;
}

@Injectable()
export class CompanionGuard implements CanActivate {
  constructor(private readonly computer: ComputerService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CompanionRequest>();
    req.companion = await this.computer.authenticateCompanion(req.headers.authorization);
    return true;
  }
}
