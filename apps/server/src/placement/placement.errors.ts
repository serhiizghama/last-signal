import { HttpException, HttpStatus } from '@nestjs/common';

// Surfaced only if `MAX_PLACEMENT_ATTEMPTS` consecutive candidate tiles all collided with an
// existing settlement — in practice this means the outer-ring band is effectively full
// (see the constant's own comment on how unlikely that is at ~150 accounts).
export class PlacementExhaustedError extends HttpException {
  constructor() {
    super(
      { error: { key: 'errors.settlement.placementExhausted', params: {} } },
      HttpStatus.CONFLICT,
    );
  }
}
