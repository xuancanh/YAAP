/**
 * ArchivedOrgGuard — an archived company is read-only through
 * `/api/orgs/:id/...` (docs/owners-seat.md "Archive or delete the company"):
 * reads pass, so the "Archived company" view and exports work; any write is
 * refused with how to bring the company back. The workspace-scoped routes
 * never reach an archived org (they resolve the live one), and its agents'
 * seats are suspended, so this is the one door left to close.
 */
import { CanActivate, ConflictException, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { OrgService } from './org.service';

@Injectable()
export class ArchivedOrgGuard implements CanActivate {
  constructor(private readonly org: OrgService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    const id = typeof req.params?.id === 'string' ? req.params.id : '';
    if (!id) return true;
    const org = await this.org.get(id).catch(() => null);
    if (org?.status === 'archived') throw new ConflictException(`"${org.name}" is archived and read-only — restore it from Settings → Workspace → Organization first`);
    return true;
  }
}
