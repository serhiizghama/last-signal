import { Injectable } from '@nestjs/common';

import type { AuthProvider, ExternalIdentity } from './auth-provider.interface';

// Stub only — lands for real in M7 (§13 of the M1 design record). Registered as a DI
// provider now (see `auth.module.ts`) so wiring it up later is a provider swap, not new
// plumbing; no crypto is faked here.
//
// Telegram Login Widget verification contract, for M7 to implement:
// - The widget posts `{ id, first_name, last_name?, username?, photo_url?, auth_date, hash }`.
// - Recompute the check string: every field except `hash`, formatted as `key=value`, sorted
//   alphabetically by key, joined with `\n`.
// - `secret = SHA256(bot_token)`; expected hash = `HMAC-SHA256(check_string, secret)`, hex.
// - Compare `hash` to the expected value in constant time; reject on mismatch.
// - Reject if `auth_date` is older than Telegram's recommended freshness window (~24h) —
//   otherwise a captured payload could be replayed indefinitely.
// - Reference: https://core.telegram.org/widgets/login#checking-authorization
@Injectable()
export class TelegramAuthProvider implements AuthProvider {
  // No `credentials` parameter — see `GuestAuthProvider`'s comment on why that's allowed.
  verify(): Promise<ExternalIdentity> {
    return Promise.reject(new Error('TelegramAuthProvider: not implemented (lands in M7)'));
  }
}
