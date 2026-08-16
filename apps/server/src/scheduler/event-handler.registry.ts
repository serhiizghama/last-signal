import { Injectable } from '@nestjs/common';

import type { EventHandler } from './event-handler.interface';

// Where feature modules plug event handlers into the scheduler. A single
// shared instance (exported by `SchedulerModule`) — feature modules import
// `SchedulerModule` and call `register()` from their own `onModuleInit`.
@Injectable()
export class EventHandlerRegistry {
  private readonly handlersByType = new Map<string, EventHandler>();

  // Throws on a duplicate `type` so a copy-paste mistake fails loudly at
  // boot instead of silently shadowing an existing handler.
  register(handler: EventHandler): void {
    const existing = this.handlersByType.get(handler.type);
    if (existing) {
      throw new Error(
        `EventHandlerRegistry: a handler for event type "${handler.type}" is already registered`,
      );
    }
    this.handlersByType.set(handler.type, handler);
  }

  get(type: string): EventHandler | undefined {
    return this.handlersByType.get(type);
  }
}
