import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { PlacementService } from './placement.service';

@Module({
  // DatabaseModule for `@InjectModel(PlacementCounter.name)` (Nest DI is per-module — see
  // the comment in `database.module.ts`).
  imports: [DatabaseModule],
  providers: [PlacementService],
  exports: [PlacementService],
})
export class PlacementModule {}
