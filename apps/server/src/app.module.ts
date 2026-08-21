import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import cookieParser from 'cookie-parser';

import { AccountsModule } from './accounts/accounts.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { DevSeedModule } from './dev/dev-seed.module';
import { GameConfigModule } from './game-config/game-config.module';
import { HealthModule } from './health/health.module';
import { MapModule } from './map/map.module';
import { MarketModule } from './market/market.module';
import { MovementsModule } from './movements/movements.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NpcModule } from './npc/npc.module';
import { PlacementModule } from './placement/placement.module';
import { RealtimeModule } from './realtime/realtime.module';
import { ReportsModule } from './reports/reports.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SettlementsModule } from './settlements/settlements.module';
import { WorldModule } from './world/world.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    GameConfigModule,
    HealthModule,
    SchedulerModule,
    PlacementModule,
    AuthModule,
    AccountsModule,
    SettlementsModule,
    MovementsModule,
    WorldModule,
    NpcModule,
    MapModule,
    MarketModule,
    RealtimeModule,
    ReportsModule,
    NotificationsModule,
    DevSeedModule,
  ],
})
export class AppModule implements NestModule {
  // Wired here (rather than `app.use(cookieParser())` in `main.ts`) so every test that
  // boots `AppModule` directly (the whole integration-spec convention — see
  // `health.integration.spec.ts`) gets cookie parsing too, without each spec file having to
  // remember to add it. `AuthGuard` reads `request.cookies`, populated by this middleware.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('*');
  }
}
