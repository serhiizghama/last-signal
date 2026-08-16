import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { GUEST_AUTH_PROVIDER, TELEGRAM_AUTH_PROVIDER } from './auth.tokens';
import { GuestAuthProvider } from './providers/guest-auth.provider';
import { TelegramAuthProvider } from './providers/telegram-auth.provider';
import { SessionService } from './session.service';

@Module({
  // DatabaseModule for `@InjectModel(Account.name)` / `@InjectModel(Session.name)` /
  // `@InjectConnection()`; ConfigModule (global already, imported for clarity) for
  // `AuthController`'s NODE_ENV-gated cookie `secure` flag.
  imports: [ConfigModule, DatabaseModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    AuthGuard,
    GuestAuthProvider,
    TelegramAuthProvider,
    { provide: GUEST_AUTH_PROVIDER, useExisting: GuestAuthProvider },
    // Unused by any call site yet (M7 wires it up — see `TelegramAuthProvider`'s comment);
    // registered now so that landing it later is a call-site change only, not new DI plumbing.
    { provide: TELEGRAM_AUTH_PROVIDER, useExisting: TelegramAuthProvider },
  ],
  // `AuthGuard` + `AuthService` so other feature modules (`AccountsModule`,
  // `SettlementsModule`) can `@UseGuards(AuthGuard)` / `@CurrentAccount()` on their own
  // controllers by importing this module, without re-declaring the auth wiring themselves.
  exports: [AuthGuard, AuthService],
})
export class AuthModule {}
