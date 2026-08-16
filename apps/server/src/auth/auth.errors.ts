import { HttpException, HttpStatus } from '@nestjs/common';

// No valid session cookie (missing, unknown, expired, or revoked) — `AuthGuard` throws this
// for every protected route; the client should send the caller back through
// `POST /api/auth/guest` (or, later, Telegram Login).
export class NotAuthenticatedError extends HttpException {
  constructor() {
    super({ error: { key: 'errors.auth.notAuthenticated', params: {} } }, HttpStatus.UNAUTHORIZED);
  }
}
