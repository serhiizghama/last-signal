import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import type { AccountDocument } from '../schemas/account.schema';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME } from './auth.constants';
import { NotAuthenticatedError } from './auth.errors';

// Augments the request with the resolved account — `@CurrentAccount()` reads this back.
export type AuthenticatedRequest = Request & { account: AccountDocument };

// Resolves the session cookie -> session -> account and attaches the account to the
// request; throws `NotAuthenticatedError` (401, `errors.auth.notAuthenticated`) for a
// missing cookie, an unknown session id, an expired session, or a session that was
// revoked (deleted) — all indistinguishable to the client by design.
@Injectable()
export class AuthGuard implements CanActivate {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    const sessionId = cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      throw new NotAuthenticatedError();
    }

    const account = await this.authService.resolveAccountForSession(sessionId, Date.now());
    if (!account) {
      throw new NotAuthenticatedError();
    }

    (request as AuthenticatedRequest).account = account;
    return true;
  }
}
