import { Body, Controller, Inject, NotFoundException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RegenerateWorldDto } from './world-regenerate.dto';
import { WorldService } from './world.service';

export interface RegenerateWorldResult {
  seed: string;
  oasisCount: number;
}

// Dev-only: wipes the world and every oasis, then bootstraps a fresh one — optionally from a
// caller-supplied seed (see `WorldService.regenerate`'s comment on why this must never be
// called against a world with real players in it). Same production guard as
// `DevSeedController` (`apps/server/src/dev/dev-seed.controller.ts`): returns a plain `404`
// once `NODE_ENV=production`, so a scanner cannot even tell the route exists.
@Controller('dev/world')
export class WorldDevController {
  constructor(
    @Inject(WorldService) private readonly worldService: WorldService,
    @Inject(ConfigService) private readonly configService: ConfigService,
  ) {}

  @Post('regenerate')
  async regenerate(@Body() dto: RegenerateWorldDto): Promise<RegenerateWorldResult> {
    if (this.configService.get<string>('NODE_ENV', 'development') === 'production') {
      throw new NotFoundException();
    }

    const world = await this.worldService.regenerate(dto.seed, Date.now());
    const oases = await this.worldService.listOases();
    return { seed: world.seed, oasisCount: oases.length };
  }
}
