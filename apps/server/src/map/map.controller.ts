import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../auth/auth.guard';
import { MapService } from './map.service';
import type { MapView } from './map.view';

// `GET /api/map` (M2a.6, `docs/M2_DESIGN_DECISIONS.md` §5). The map's *content* is public
// between players — every settlement's coordinates, name, owner name, faction and side are
// visible to everyone, no fog of war — but the *route* still requires an authenticated
// session, like every other game route (a guest session satisfies `AuthGuard` just as well as
// a registered one). "Public" here means "public between players", not "public to the
// internet": unauthenticated requests still 401 with `errors.auth.notAuthenticated`, same as
// every other guarded route.
@Controller('map')
@UseGuards(AuthGuard)
export class MapController {
  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(MapService) private readonly mapService: MapService) {}

  @Get()
  async getMap(): Promise<MapView> {
    return this.mapService.getMapView(Date.now());
  }
}
