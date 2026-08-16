import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { WorldModule } from '../world/world.module';
import { MapController } from './map.controller';
import { MapService } from './map.service';

// `GET /api/map` (M2a.6). DatabaseModule for `@InjectModel(Settlement.name)` /
// `@InjectModel(Account.name)` (Nest DI is per-module — see the comment in
// `database.module.ts`); WorldModule for `WorldService` (world header + oases — reused, not
// re-implemented here, see `MapService`'s own comment); AuthModule for `AuthGuard` on
// `MapController`.
@Module({
  imports: [DatabaseModule, WorldModule, AuthModule],
  controllers: [MapController],
  providers: [MapService],
})
export class MapModule {}
