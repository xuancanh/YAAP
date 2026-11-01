/**
 * AuthGuard — delegates to whichever AuthStrategy is bound, attaches the
 * resolved identity to `request.userId`, and binds the account every query
 * in this request is scoped to (accounts/account-context.ts).
 *
 * The guard is provider-agnostic, mirroring the shape the rest of the product
 * suite uses (docs/shared-accounts.md, phase 5): replacing the identity model
 * means binding a different AUTH_STRATEGY in AppModule, not editing anything
 * here. The identity *is* the account id, except that the single-user
 * identity (SINGLE_USER) maps onto the 'single' account that owns every row
 * of a one-user install.
 *
 * Synchronous strategies stay synchronous (the token guard is used in unit
 * tests without a promise in sight); a strategy that looks a session up in
 * the database returns a promise and the guard follows suit.
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AUTH_STRATEGY, AuthStrategy, SINGLE_USER } from './auth-strategy.interface';
import { SINGLE_ACCOUNT, bindAccount } from '../accounts/account-context';

export interface AuthenticatedRequest extends Request {
  userId: string;
  accountId: string;
}

/** The account an identity works in. */
export const accountIdOf = (userId: string): string => (userId === SINGLE_USER ? SINGLE_ACCOUNT : userId);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH_STRATEGY) private readonly strategy: AuthStrategy) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.strategy.isPublic?.(request)) return true;
    const resolved = this.strategy.authenticate(request);
    if (resolved instanceof Promise) return resolved.then((id) => this.attach(request, id));
    return this.attach(request, resolved);
  }

  private attach(request: AuthenticatedRequest, userId: string): true {
    request.userId = userId;
    request.accountId = accountIdOf(userId);
    // False only when no request store is open (a guard built outside the
    // middleware, i.e. unit tests) — then there is nothing to scope.
    bindAccount(request.accountId);
    return true;
  }
}
