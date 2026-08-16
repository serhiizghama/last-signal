import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';

import type { SessionDocument } from '../schemas/session.schema';
import { Session } from '../schemas/session.schema';
import { SESSION_ID_BYTES, SESSION_TTL_MS } from './auth.constants';

// Raw CRUD over the `sessions` collection — the write/read side `AuthService` builds
// guest-login, session-resolution and logout on top of.
@Injectable()
export class SessionService {
  constructor(@InjectModel(Session.name) private readonly sessionModel: Model<SessionDocument>) {}

  // `session` (the Mongo transaction) is optional so this can be created inside the same
  // transaction as the account it belongs to (guest login: account + session must commit or
  // abort together) or standalone.
  async create(
    accountId: Types.ObjectId,
    now: number,
    session?: ClientSession,
  ): Promise<SessionDocument> {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString('hex');
    const [created] = await this.sessionModel.create(
      [
        {
          sessionId,
          accountId,
          expiresAt: new Date(now + SESSION_TTL_MS),
          lastSeenAt: now,
        },
      ],
      { session },
    );
    if (!created) {
      // Unreachable in practice — `create([...])` with an array argument always resolves
      // one document per input element (see the same note in `EventSchedulerService`).
      throw new Error('SessionService: session creation returned no document');
    }
    return created;
  }

  // Resolves a raw session id to the account it belongs to, or `null` when the session is
  // missing, expired, or was revoked (deleted) — the three cases `AuthGuard` treats
  // identically as "not authenticated". Checks `expiresAt` against `now` explicitly rather
  // than relying solely on Mongo's TTL monitor, which sweeps on its own ~60s cadence and
  // would otherwise leave a small window where an expired-but-not-yet-swept session still
  // resolves.
  async resolveAccountId(sessionId: string, now: number): Promise<Types.ObjectId | null> {
    const doc = await this.sessionModel.findOne({ sessionId });
    if (!doc || doc.expiresAt.getTime() <= now) {
      return null;
    }
    // Best-effort bookkeeping, not part of the auth decision above — a lost update under a
    // race is harmless.
    await this.sessionModel.updateOne({ _id: doc._id }, { $set: { lastSeenAt: now } });
    return doc.accountId;
  }

  // Deletion is what makes revocation immediate (see `Session`'s schema comment) — used by
  // both explicit logout and, in tests, to simulate an admin/system revoking a session out
  // from under its owner.
  async deleteBySessionId(sessionId: string): Promise<void> {
    await this.sessionModel.deleteOne({ sessionId });
  }
}
