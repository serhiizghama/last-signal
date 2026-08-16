import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ReportsController } from './reports.controller';
import { ReportsRealtimePublisher } from './reports-realtime.publisher';
import { ReportsService } from './reports.service';

@Module({
  // DatabaseModule for `@InjectModel(Report.name)`; AuthModule for `AuthGuard` +
  // `CurrentAccount` on `ReportsController`; RealtimeModule for the `RealtimeGateway`
  // `ReportsRealtimePublisher` pushes `reportArrived` through.
  imports: [DatabaseModule, AuthModule, RealtimeModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRealtimePublisher],
})
export class ReportsModule {}
