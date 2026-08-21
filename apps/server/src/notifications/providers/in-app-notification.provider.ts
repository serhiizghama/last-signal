import { Inject, Injectable } from '@nestjs/common';

import { RealtimeGateway } from '../../realtime/realtime.gateway';
import type { NotificationDelivery, NotificationProvider } from './notification-provider.interface';

// The live provider (§16: "an in-app/WS provider (live, reuses the M2b.4 gateway)"). Reuses
// `RealtimeGateway.emitToAccount` exactly the way `ReportsRealtimePublisher` already does for
// `reportArrived` — this is the second, not the first, feature to push through that gateway.
// A distinct WS event name (`notification`, not `reportArrived`) keeps the two payload shapes
// (a notification's `{kind, payload}` vs. a report's `{id, type, createdAt}`) from ever being
// confused client-side.
//
// Fire-and-forget by construction, same as `ReportsRealtimePublisher`'s own push: `emitToAccount`
// broadcasts to a room that may hold zero sockets (the account is offline) without throwing or
// signalling that fact in any way — socket.io does not distinguish "delivered to a live client"
// from "broadcast to an empty room". §16 does not ask for anything beyond the outbox row itself
// existing (no store-and-forward requirement), so this provider's "delivered" means exactly
// "handed to the gateway", never "seen by a connected player" — an offline player simply never
// receives this particular push, the same accepted gap `ReportsRealtimePublisher` already has
// for `reportArrived`. The durable outbox row is what makes this an acceptable cost rather than
// silent data loss: the notification's *existence* is never lost, only this one delivery
// attempt's liveness.
@Injectable()
export class InAppNotificationProvider implements NotificationProvider {
  readonly name = 'in-app';

  constructor(@Inject(RealtimeGateway) private readonly gateway: RealtimeGateway) {}

  deliver(notification: NotificationDelivery): Promise<void> {
    this.gateway.emitToAccount(notification.accountId, 'notification', {
      id: notification.id,
      kind: notification.kind,
      payload: notification.payload,
      createdAt: notification.createdAt,
    });
    return Promise.resolve();
  }
}
