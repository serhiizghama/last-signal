import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import type { PlacementCounterDocument } from '../schemas/placement-counter.schema';
import { PlacementCounter } from '../schemas/placement-counter.schema';
import { PLACEMENT_COUNTER_KEY } from './placement.constants';
import type { Tile } from './placement.geometry';
import { pickOuterRingTile } from './placement.geometry';

// Thin DB-backed wrapper around the pure geometry in `placement.geometry.ts`: owns the
// per-world counter that seeds the deterministic tile mapping. Kept deliberately small so
// the geometry itself stays unit-testable with zero DB dependency (see
// `placement.geometry.spec.ts`).
@Injectable()
export class PlacementService {
  constructor(
    @InjectModel(PlacementCounter.name)
    private readonly counterModel: Model<PlacementCounterDocument>,
  ) {}

  // Pure — exposed on the service too so callers don't need to import the geometry module
  // directly.
  pickTile(counter: number): Tile {
    return pickOuterRingTile(counter);
  }

  // Atomically increments and returns the shared counter. Deliberately NOT run inside the
  // caller's settlement-creation transaction: if that transaction later aborts (e.g. the
  // chosen tile collided with the unique `{x,y}` index), the `$inc` below would be rolled
  // back right along with it — meaning a retry would draw the *same* counter value again
  // and recompute the *same* candidate tile, looping forever on the same collision. Bumping
  // the counter as its own tiny, always-committed operation guarantees every retry attempt
  // (see `SettlementsService.createSettlement`) advances to a genuinely new tile. Gaps in
  // the counter sequence from a failed/retried attempt are harmless — nothing requires it to
  // be dense, only monotonically increasing and never reused.
  async nextCounter(): Promise<number> {
    const doc = await this.counterModel.findOneAndUpdate(
      { key: PLACEMENT_COUNTER_KEY },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!doc) {
      // Unreachable: `upsert: true` + `returnDocument: 'after'` always returns a document.
      throw new Error('PlacementService: counter increment returned no document');
    }
    return doc.value;
  }
}
