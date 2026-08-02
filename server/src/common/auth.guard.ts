/**
 * AuthGuard — delegates to whichever AuthStrategy is bound and attaches the
 * resolved identity to `request.userId`.
 *
 * The guard is provider-agnostic, mirroring the shape the rest of the product
 * suite uses (docs/shared-accounts.md, phase 5): replacing the identity model
 * means binding a different AUTH_STRATEGY, not editing anything here. The
 * default binding is TokenAuthStrategy — one optional shared bearer token,
 * the right trust boundary for a single-user self-hosted app.
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_STRATEGY, AuthStrategy } from './auth-strategy.interface';

export interface AuthenticatedRequest extends Request {
  userId: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_STRATEGY) private readonly strategy: AuthStrategy) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.strategy.isPublic?.(request)) return true;
    request.userId = this.strategy.authenticate(request);
    return true;
  }
}
