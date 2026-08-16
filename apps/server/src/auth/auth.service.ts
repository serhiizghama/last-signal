import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';

import { isDuplicateKeyError } from '../database/mongo-errors.util';
import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { SessionDocument } from '../schemas/session.schema';
import { MAX_GUEST_NAME_ATTEMPTS } from './auth.constants';
import type { AuthProvider } from './providers/auth-provider.interface';
import { GUEST_AUTH_PROVIDER } from './auth.tokens';
import { SessionService } from './session.service';

export interface GuestLoginResult {
  account: AccountDocument;
  session: SessionDocument;
}

// Placeholder guest display name: `Guest-<8 random hex chars>`. Never shown as anything
// meaningful in v1 (no rename endpoint exists yet) — it only has to be unique against the
// `Account.name` index (see that schema's comment) and reasonably not-ugly as a fallback.
function randomGuestName(): string {
  return `Guest-${randomBytes(4).toString('hex')}`;
}

// Orchestrates login/logout/session-resolution on top of `SessionService` (session CRUD)
// and an injected `AuthProvider` (identity verification — see that interface's comment for
// why guest and Telegram both go through the same seam).
@Injectable()
export class AuthService {
  constructor(
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(SessionService) private readonly sessionService: SessionService,
    @Inject(GUEST_AUTH_PROVIDER) private readonly guestAuthProvider: AuthProvider,
  ) {}

  // Mints a brand-new guest account + session, atomically (one commits with the other or
  // neither does). Every call creates a fresh account — guest `ExternalIdentity`s are never
  // looked up against an existing account (unlike Telegram's `tgId`, guests have no
  // cross-round identity to resolve to; see §13 of the M1 design record).
  async loginAsGuest(now: number): Promise<GuestLoginResult> {
    // Routed through the provider purely to keep this call site provider-agnostic (see the
    // `AuthProvider` interface comment); the identity itself isn't persisted for guests.
    await this.guestAuthProvider.verify({});

    for (let attempt = 1; attempt <= MAX_GUEST_NAME_ATTEMPTS; attempt += 1) {
      const session = await this.connection.startSession();
      try {
        let result: GuestLoginResult | undefined;
        await session.withTransaction(async () => {
          const [account] = await this.accountModel.create(
            [{ name: randomGuestName(), isGuest: true }],
            { session },
          );
          if (!account) {
            throw new Error('AuthService: guest account creation returned no document');
          }
          const sessionDoc = await this.sessionService.create(account._id, now, session);
          result = { account, session: sessionDoc };
        });
        return result as GuestLoginResult;
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        // The random guest name collided with an existing account name — retry with a
        // fresh one (see `randomGuestName`'s comment on how unlikely this is).
      } finally {
        await session.endSession();
      }
    }
    throw new Error('AuthService: failed to allocate a unique guest name after several attempts');
  }

  // Resolves a raw session id (from the cookie) to the `Account` it belongs to, or `null`
  // when unauthenticated for any reason (see `SessionService.resolveAccountId`) — including
  // the edge case of a session whose account was deleted out from under it.
  async resolveAccountForSession(sessionId: string, now: number): Promise<AccountDocument | null> {
    const accountId = await this.sessionService.resolveAccountId(sessionId, now);
    if (!accountId) {
      return null;
    }
    return this.accountModel.findById(accountId);
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionService.deleteBySessionId(sessionId);
  }
}
