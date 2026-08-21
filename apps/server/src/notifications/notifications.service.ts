import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';

import type { AccountDocument } from '../schemas/account.schema';
import { Account } from '../schemas/account.schema';
import type { NotificationDocument, NotificationKind } from '../schemas/notification.schema';
import {
  NOTIFICATION_KIND_BATTLE_REPORT_ARRIVED,
  Notification,
} from '../schemas/notification.schema';
import type { ReportDocument } from '../schemas/report.schema';
import { isNotificationKindEnabled } from './notifications.util';

// The write side of the outbox (§16, `docs/M3_DESIGN_DECISIONS.md`): every trigger site in
// §16's table (`MovementsService.sendMovement`, `BuildCompleteHandler`,
// `TrainingCompleteHandler`, `StarvationTickHandler`, `SettleArrivalResolver`,
// `BattleArrivalResolver`/`OasisBattleArrivalResolver`) calls `enqueue` (or, for the five
// "battle report" kinds, `enqueueForReports`) as the very last thing it does with the
// session it already holds — never opens its own transaction, never commits anything on its
// own. This mirrors `EventSchedulerService.scheduleEvent`'s own shape deliberately: a small,
// stateless write helper that every command/handler funnels its own kind of "schedule a
// side effect" through, always riding the caller's existing session.
@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(Account.name) private readonly accountModel: Model<AccountDocument>,
  ) {}

  // Enqueues one outbox row for `accountId`, unless that account has explicitly disabled
  // `kind` (§16: "per-kind toggles live in the existing account.settings").
  //
  // **Read at enqueue time, not at delivery time — deliberately, and this is the load-bearing
  // ordering decision the brief calls out.** The alternative (always write the row, let
  // `NotificationDispatchService` check the toggle right before calling a provider) would
  // still stop a disabled kind from ever reaching a player, but it would leave a permanent,
  // ever-growing trail of "never going to be delivered" rows in the outbox for any account
  // that disables a frequent kind (e.g. `buildComplete` during an active building spree) —
  // rows this collection's whole design (a small, ever-shrinking undelivered set, see
  // `NotificationSchema`'s own partial-index comment) assumes never accumulate. Checking here
  // means a disabled kind costs one indexed `findById` and nothing else: no row, no dispatcher
  // work, no data to ever clean up. The cost is that a toggle flipped ON *after* an effect
  // already ran can never retroactively produce that notification — an acceptable trade, since
  // §16 describes toggles as an enable/disable switch for future events, not a filter replayed
  // over history.
  async enqueue(
    accountId: Types.ObjectId,
    kind: NotificationKind,
    payload: Record<string, unknown>,
    session: ClientSession,
  ): Promise<void> {
    // Defensive-permissive on a missing account (mirrors every other handler's "settlements/
    // accounts are never deleted in v1, but a scheduler-driven write must not assume a
    // foreign document it doesn't own can never be gone" convention, e.g.
    // `SettleArrivalResolver`'s own account lookup): proceeds as enabled rather than silently
    // dropping a notification over a lookup that should never actually miss.
    const account = await this.accountModel.findById(accountId, 'settings', { session });
    if (account && !isNotificationKindEnabled(account.settings, kind)) {
      return;
    }

    await this.notificationModel.create([{ accountId, kind, payload }], { session });
  }

  // The one hook every combat-report writer calls (`BattleArrivalResolver`,
  // `OasisBattleArrivalResolver`) so "battle report arrived" is defined once, here, rather
  // than re-derived at each of the four sites that write a `raid`/`assault`/`defense`/
  // `supportLoss`/`oasisRaid`/`buildingDestroyed` report. Takes the already-created report
  // documents (never a raw payload) — `reportModel.create([...], { session })`'s own return
  // value — so a notification's `reportId` can never disagree with the report it names.
  async enqueueForReports(
    reports: ReadonlyArray<ReportDocument>,
    session: ClientSession,
  ): Promise<void> {
    for (const report of reports) {
      await this.enqueue(
        report.accountId,
        NOTIFICATION_KIND_BATTLE_REPORT_ARRIVED,
        { reportId: String(report._id), reportType: report.type },
        session,
      );
    }
  }
}
