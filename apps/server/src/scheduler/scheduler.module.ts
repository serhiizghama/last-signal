import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module';
import { EventHandlerRegistry } from './event-handler.registry';
import { EventSchedulerService } from './event-scheduler.service';
import { SchedulerService } from './scheduler.service';

@Module({
  // DatabaseModule for `@InjectModel(GameEvent.name)` / `@InjectConnection()`
  // (Nest DI is per-module, so this needs its own import even though
  // AppModule already imports DatabaseModule too — see the comment in
  // database.module.ts). ConfigModule is global already, imported here only
  // for clarity at the call site.
  imports: [ConfigModule, DatabaseModule],
  providers: [EventHandlerRegistry, EventSchedulerService, SchedulerService],
  // `EventHandlerRegistry` so feature modules can register handlers, and
  // `EventSchedulerService` so they can enqueue events — both are the
  // surface later steps (buildComplete, ...) plug into.
  exports: [EventHandlerRegistry, EventSchedulerService],
})
export class SchedulerModule {}
