import { HttpException, HttpStatus } from '@nestjs/common';

// Surfaced only when `pickSpawnTile` (game-core) returns `null` from
// `PlacementService.findTile` — i.e. the center-out annulus search grew all the way out to
// `config.map.radius` and still never found a single legal tile anywhere on the grid. In
// practice this means the grid is effectively full (net of toxic lakes and oases), not merely
// "this one candidate collided": a genuine collision on the unique `{x, y}` index is a much
// more common, expected event, handled entirely by `SettlementsService.createSettlement`'s own
// bounded retry loop (draw a fresh candidate and try again) — that path never throws this.
export class PlacementExhaustedError extends HttpException {
  constructor() {
    super(
      { error: { key: 'errors.settlement.placementExhausted', params: {} } },
      HttpStatus.CONFLICT,
    );
  }
}
