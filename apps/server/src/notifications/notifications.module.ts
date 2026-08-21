import type { OnModuleInit } from '@nestjs/common';
import { Inject, Module } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { DatabaseModule } from '../database/database.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EventHandlerRegistry } from '../scheduler/event-handler.registry';
import { EventSchedulerService } from '../scheduler/event-scheduler.service';
import { SchedulerModule } from '../scheduler/scheduler.module';
import type { GameEventDocument } from '../schemas/event.schema';
import { GameEvent } from '../schemas/event.schema';
import { NotificationDispatchHandler } from './handlers/notification-dispatch.handler';
import { NOTIFICATION_DISPATCH_EVENT_TYPE } from './notifications.constants';
import { NotificationsService } from './notifications.service';
import { InAppNotificationProvider } from './providers/in-app-notification.provider';
import { TelegramNotificationProvider } from './providers/telegram-notification.provider';

@Module({
  // DatabaseModule for `@InjectModel(Notification.name)`/`@InjectModel(Account.name)`/
  // `@InjectModel(GameEvent.name)` (Nest DI is per-module — see `database.module.ts`'s own
  // comment); RealtimeModule for `RealtimeGateway`, `InAppNotificationProvider`'s one
  // dependency; SchedulerModule for `EventHandlerRegistry` + `EventSchedulerService`, the
  // drain loop's own driving mechanism (`NotificationDispatchHandler`'s class comment).
  imports: [DatabaseModule, RealtimeModule, SchedulerModule],
  providers: [
    NotificationsService,
    InAppNotificationProvider,
    TelegramNotificationProvider,
    NotificationDispatchHandler,
  ],
  // `MovementsModule` (the `incomingAttack` trigger) and `SettlementsModule`
  // (`buildComplete`/`trainingComplete`/`troopsStarving`) both import this module to inject
  // `NotificationsService` — a leaf feature module, like `GameConfigModule`/`AuthModule`,
  // with nothing of its own that could ever need to import either of them back.
  exports: [NotificationsService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    @Inject(EventHandlerRegistry) private readonly registry: EventHandlerRegistry,
    @Inject(NotificationDispatchHandler)
    private readonly dispatchHandler: NotificationDispatchHandler,
    @Inject(EventSchedulerService) private readonly eventScheduler: EventSchedulerService,
    @InjectModel(GameEvent.name) private readonly eventModel: Model<GameEventDocument>,
  ) {}

  // Registers `notificationDispatch` with the shared scheduler registry (the pattern every
  // other feature module's `onModuleInit` already establishes — see `SettlementsModule`'s own
  // comment), then seeds the very first tick on a cold boot.
  //
  // **The bootstrap seed, and why it's safe.** `NotificationDispatchHandler` always
  // reschedules its own successor (its class comment: "the heartbeat never stops"), so once a
  // world has processed even one dispatch tick, this branch never fires again — there is
  // always a `due`/`processing` `notificationDispatch` event in flight. The ONLY moment none
  // exists is a genuinely empty database (a fresh world, or this feature's very first
  // deploy), which is exactly when this check matters. `Date.now()` here is a one-time
  // process-bootstrap timestamp, not a step in any replay-sensitive resolution path — the
  // same category of wall-clock read `WorldService.bootstrap`/`NpcSeederService` already use
  // at genesis, not the §18 determinism rule (which governs *handlers* resolving already-
  // scheduled game events, not the one-time act of scheduling the first one). Two processes
  // racing this on the same empty database is not a correctness hazard either: at worst two
  // `notificationDispatch` events both go `due`, and the scheduler's own atomic
  // `findOneAndUpdate` claim (`SchedulerService.claimNextDueEvent`) means only one is ever
  // claimed at a time regardless — the second is simply drained (and, since its own `handle`
  // finds nothing new to do beyond what the first already drained, reschedules a normal-
  // interval successor) rather than causing any double-delivery.
  async onModuleInit(): Promise<void> {
    this.registry.register(this.dispatchHandler);

    const existing = await this.eventModel.findOne({
      type: NOTIFICATION_DISPATCH_EVENT_TYPE,
      status: { $in: ['due', 'processing'] },
    });
    if (!existing) {
      await this.eventScheduler.scheduleEvent({
        type: NOTIFICATION_DISPATCH_EVENT_TYPE,
        dueAt: Date.now(),
        payload: {},
      });
    }
  }
}
