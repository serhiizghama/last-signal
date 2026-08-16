import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { AccountView } from '../accounts/account.view';
import { buildAccountView } from '../accounts/account.view';
import type { AccountDocument } from '../schemas/account.schema';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './auth.constants';
import { CurrentAccount } from './current-account.decorator';

@Controller('auth')
export class AuthController {
  // Explicit @Inject tokens — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  // 201 (Nest's default for POST): a genuinely new account (and session) is created every
  // call, unlike `register`/`build`, which mutate an existing resource — see those
  // controllers' comments on why they override to 200.
  @Post('guest')
  async guest(@Res({ passthrough: true }) res: Response): Promise<AccountView> {
    const { account, session } = await this.authService.loginAsGuest(Date.now());
    this.setSessionCookie(res, session.sessionId, session.expiresAt);
    // Never the raw session id in the body — it only ever travels as the httpOnly cookie.
    return buildAccountView(account);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentAccount() account: AccountDocument): AccountView {
    return buildAccountView(account);
  }

  // No `@UseGuards(AuthGuard)`: logging out with no cookie, an already-expired cookie, or an
  // already-revoked session is a no-op, not an error — it still clears the cookie and
  // returns 200, so a client never needs to special-case "am I currently logged in" before
  // calling this.
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const cookies = req.cookies as Record<string, string | undefined> | undefined;
    const sessionId = cookies?.[SESSION_COOKIE_NAME];
    if (sessionId) {
      await this.authService.logout(sessionId);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }

  private setSessionCookie(res: Response, sessionId: string, expiresAt: Date): void {
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      // Only required over HTTPS — the dev server runs plain HTTP, so this stays off there.
      secure: this.configService.get<string>('NODE_ENV', 'development') === 'production',
      expires: expiresAt,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }
}
