import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';

import type { AccountDocument } from '../schemas/account.schema';
import type { AuthenticatedRequest } from './auth.guard';

// The account `AuthGuard` resolved for this request. Only valid on routes guarded by
// `AuthGuard` — using it without the guard is a route-wiring bug (caught here rather than
// silently returning `undefined`), not a client-facing error.
export const CurrentAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccountDocument => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.account) {
      throw new Error('CurrentAccount: no account on request — is AuthGuard applied?');
    }
    return request.account;
  },
);
