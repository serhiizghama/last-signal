import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../database/database.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { DevSeedController } from './dev-seed.controller';

@Module({
  // SettlementsModule for `SettlementsService.createSettlement` — the real placement +
  // creation path this dev endpoint now delegates to (see `DevSeedController`'s comment).
  imports: [ConfigModule, DatabaseModule, SettlementsModule],
  controllers: [DevSeedController],
})
export class DevSeedModule {}
