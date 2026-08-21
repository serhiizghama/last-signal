import type { NotificationKind } from '../schemas/notification.schema';

// The typed shape of the `notifications` subtree inside `Account.settings` (§16: "Per-kind
// toggles live in the existing account.settings" — a `Mixed` map today, see that field's own
// comment). Every key is optional and every kind defaults to enabled when absent — see
// `isNotificationKindEnabled` below for why "absent" and "explicitly enabled" must mean the
// same thing here.
export interface NotificationToggleSettings {
  incomingAttack?: boolean;
  buildComplete?: boolean;
  trainingComplete?: boolean;
  battleReportArrived?: boolean;
  troopsStarving?: boolean;
  settlementFounded?: boolean;
}

// Reads one kind's toggle out of an account's raw `settings` blob. `settings` is untyped
// (`Record<string, unknown>` — `Account.settings`'s own declared shape) because it is a
// grab-bag the rest of the app also writes to; this function is the one place that knows how
// to read the `notifications` subtree out of it, so nothing else has to re-derive the
// "default enabled, `false` is the only way to opt out" rule below.
//
// Default-enabled, not default-disabled: a brand-new account (or one that predates this
// feature entirely) has no `settings.notifications` at all, and §16 never asks for an
// opt-in flow — every player who has never touched their notification settings should keep
// getting every kind, exactly as if the toggle grid didn't exist yet. Only an explicit
// `false` ever suppresses a kind; anything else (missing key, missing subtree, a stray
// non-boolean value from a future schema change) reads as enabled rather than being treated
// as a malformed-settings error — this function is read on the hot path of every single
// notification trigger (§16: "read at enqueue time"), so it fails open rather than throwing.
export function isNotificationKindEnabled(
  settings: Record<string, unknown> | undefined,
  kind: NotificationKind,
): boolean {
  const raw = settings?.['notifications'];
  if (typeof raw !== 'object' || raw === null) {
    return true;
  }
  return (raw as Record<string, unknown>)[kind] !== false;
}
