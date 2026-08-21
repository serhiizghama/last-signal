import { Injectable, Logger } from '@nestjs/common';

import type { NotificationDelivery, NotificationProvider } from './notification-provider.interface';

// Stub only — lands for real in M7 (§16 of the M3 design record: "a Telegram provider stub
// that logs the exact payload it would send. The real bot is wired and smoke-tested on the
// VPS before M7, exactly the treatment TG auth already has", M1 §13). Registered as a real DI
// provider now (see `notifications.module.ts`) so wiring it up later is a provider swap, not
// new plumbing — mirrors `TelegramAuthProvider`'s own stub deliberately, down to this comment
// shape, since that class is this codebase's existing precedent for "a provider that is
// obviously a placeholder, not a silently-broken implementation". No bot token, no HTTP call,
// no formatting — just the exact payload, logged, so a developer (or `tools/sim`) reading the
// server log can already see what M7's bot would have sent.
@Injectable()
export class TelegramNotificationProvider implements NotificationProvider {
  readonly name = 'telegram';

  private readonly logger = new Logger(TelegramNotificationProvider.name);

  deliver(notification: NotificationDelivery): Promise<void> {
    this.logger.log(
      `[stub] would send Telegram notification to account ${String(notification.accountId)}: ` +
        JSON.stringify({ kind: notification.kind, payload: notification.payload }),
    );
    return Promise.resolve();
  }
}
