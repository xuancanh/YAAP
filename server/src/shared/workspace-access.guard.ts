/**
 * WorkspaceAccessGuard — `withWorkspaceAccess` for every route at once
 * (docs/shared-agents.md §2).
 *
 * Runs after AuthGuard has bound the caller's own account. When the request
 * names a workspace (`X-Yaam-Workspace` header; the SPA sends it for the
 * workspace it is showing) that the caller does not own but is a member of,
 * the guard rebinds the account context to the *owner's* account — so every
 * repository read and write lands in the owner's data — and attaches a
 * `Viewer { memberAccountId, role }` to the context and the request. Then it
 * enforces the role on the HTTP shape of the request:
 *
 *   viewer  → GET only;
 *   member  → everything but the owner-only routes (settings, budgets,
 *             members, rules, agents' definitions, connections of others);
 *   owner   → everything (a member row can carry the owner role too).
 *
 * Finer checks that need the row (is this *my* connection, *my* private
 * proposal, *my* routed approval) live in the services. A header naming a
 * workspace the caller has no relation to is a 403; one naming no workspace
 * at all is ignored (stale client state, not an attack).
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { bindAccount, bindViewer, type MemberRole, type Viewer } from '../accounts/account-context';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { SharedService } from './shared.service';

export const WORKSPACE_HEADER = 'x-yaam-workspace';

export interface ViewerRequest extends AuthenticatedRequest { viewer?: Viewer }

/** Routes a `member` may not call: the owner's settings surface. Everything
 *  here is a write; reads are open to members and viewers alike. */
export function isOwnerOnlyRoute(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const p = path.replace(/\/+$/, '');
  if (/^\/api\/workspaces$/.test(p)) return true;
  if (/^\/api\/workspaces\/[^/]+$/.test(p)) return true;
  if (/^\/api\/workspaces\/[^/]+\/(members|invites|flow-rules)(\/|$)/.test(p)) return true;
  // Plugins (docs/plugins.md §6.1): installs, bindings, grants, policies and
  // plugin settings are the owner's; so is the key on a change record.
  if (/^\/api\/workspaces\/[^/]+\/(plugins|interfaces|interface-policies|plugin-settings)(\/|$)/.test(p)) return true;
  if (/^\/api\/workspaces\/[^/]+\/changes\/[^/]+\/keys$/.test(p)) return true;
  // Archive, restore and delete the company (docs/owners-seat.md "Archive or delete the company").
  if (/^\/api\/workspaces\/[^/]+\/org\/(archive|restore)$/.test(p)) return true;
  if (method === 'DELETE' && /^\/api\/workspaces\/[^/]+\/org$/.test(p)) return true;
  if (/^\/api\/(settings|agent-types|mcp|skills|connections|computer|harness|registry|market|push|admin)(\/|$)/.test(p)) return true;
  if (/^\/api\/agents$/.test(p)) return true;
  if (/^\/api\/agents\/[^/]+$/.test(p)) return true;
  if (/^\/api\/agents\/[^/]+\/(lessons|tools|import|apps|loops)(\/|$)/.test(p)) return true;
  if (/^\/api\/orgs(\/|$)/.test(p)) {
    // Humans in an organisation decide through the org controller, which
    // checks org_humans roles itself; everything else about the company is
    // the CEO's (the owner's).
    return !/^\/api\/orgs\/[^/]+\/(approvals\/[^/]+\/decide|brief\/reply|messages)$/.test(p);
  }
  return false;
}

/** The pure decision, exported for tests: what a role may do with a request. */
export function checkRole(role: MemberRole, method: string, path: string): void {
  if (role === 'owner') return;
  if (role === 'viewer') {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') throw new ForbiddenException('viewers have read-only access to this workspace');
    return;
  }
  if (isOwnerOnlyRoute(method, path)) throw new ForbiddenException('only the workspace owner can change this');
}

export function workspaceIdOf(request: Pick<Request, 'headers'>): string {
  const h = request.headers[WORKSPACE_HEADER];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' ? v.trim() : '';
}

@Injectable()
export class WorkspaceAccessGuard implements CanActivate {
  constructor(private readonly shared: SharedService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ViewerRequest>();
    if (!request.accountId) return true; // public route: AuthGuard bound nobody
    const workspaceId = workspaceIdOf(request);
    if (!workspaceId) return true;
    const access = await this.shared.resolveAccess(workspaceId, request.accountId);
    if (access === undefined) return true; // no such workspace: ignore the header
    if (access === null) throw new ForbiddenException('you are not a member of this workspace');
    if (!access.viewer) return true; // the owner, in their own account
    checkRole(access.viewer.role, request.method, request.path);
    // Act inside the owner's account as this member, for the rest of the request.
    request.accountId = access.ownerAccountId;
    request.viewer = access.viewer;
    bindAccount(access.ownerAccountId);
    bindViewer(access.viewer);
    return true;
  }
}
