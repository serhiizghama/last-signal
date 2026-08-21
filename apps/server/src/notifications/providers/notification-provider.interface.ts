import type { Types } from 'mongoose';

import type { NotificationKind } from '../../schemas/notification.schema';

// One outbox row, reshaped for delivery — everything a provider needs to send/log a
// notification, and nothing it needs to know about how the row is stored or drained.
export interface NotificationDelivery {
  id: string;
  accountId: Types.ObjectId;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  createdAt: number;
}

// The seam M7's real Telegram bot swaps in behind, with zero change to any call site —
// mirrors `AuthProvider` (`auth/providers/auth-provider.interface.ts`) for shape and comment
// style deliberately: that interface is this codebase's existing "swappable provider"
// precedent (§13 of the M1 design record — "Telegram Login implemented behind the same
// service interface"), and §16 asks for exactly the same treatment here. `deliver` never
// returns a value: a provider either delivers (resolves) or fails (rejects) — there is no
// partial-success shape for `NotificationDispatchService` to interpret, by design (see that
// service's own comment on why a throw isolates to the one row, not the one provider call).
export interface NotificationProvider {
  // A short, stable identifier — persisted verbatim into `Notification.provider` once this
  // provider has successfully delivered a row (`NotificationDispatchService`), so it doubles
  // as the durable record of "which providers actually processed this notification".
  readonly name: string;

  deliver(notification: NotificationDelivery): Promise<void>;
}
