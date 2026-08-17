import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { stationedContingentKey, upkeepTroopsOf } from './settlements.util';

// Unit-level coverage for the one thing `upkeepTroopsOf` promises (M3a.4,
// `docs/M3_DESIGN_DECISIONS.md` §3): the union of `troops`/`awayTroops`/every
// `stationedTroops` contingent, in one place, so the four upkeep call sites can never
// disagree. `unionTroops` itself (catalogue ordering, zero-drop, non-mutation) is already
// covered exhaustively in `packages/game-core/src/units/troops.test.ts` — this file only
// proves the reshape from a settlement-document-shaped input feeds it correctly, including
// the one list no command writes yet (`stationedTroops`, M3c).
describe('upkeepTroopsOf', () => {
  it('sums home, away and every stationed contingent into one union, in catalogue order', () => {
    const doc = {
      troops: [{ unitType: 'lookout', count: 2 }],
      awayTroops: [
        { unitType: 'lookout', count: 1 },
        { unitType: 'brute', count: 3 },
      ],
      stationedTroops: [
        { troops: [{ unitType: 'brute', count: 2 }] },
        { troops: [{ unitType: 'lookout', count: 1 }] },
      ],
    };
    // brute (3+2=5) sorts before lookout (2+1+1=4) in `UNIT_TYPES` catalogue order.
    expect(upkeepTroopsOf(doc)).toEqual([
      { unitType: 'brute', count: 5 },
      { unitType: 'lookout', count: 4 },
    ]);
  });

  it('is [] when all three lists are empty', () => {
    expect(upkeepTroopsOf({ troops: [], awayTroops: [], stationedTroops: [] })).toEqual([]);
  });

  it('a stationed contingent alone (no home, no away troops) still counts — the host pays its Food', () => {
    const doc = {
      troops: [],
      awayTroops: [],
      stationedTroops: [{ troops: [{ unitType: 'torcher', count: 4 }] }],
    };
    expect(upkeepTroopsOf(doc)).toEqual([{ unitType: 'torcher', count: 4 }]);
  });
});

// Coverage for `stationedContingentKey` (M3a.6, `docs/M3_DESIGN_DECISIONS.md` §4) — the
// opaque `key` `StarvationTickHandler` builds per stationed contingent before calling
// `resolveStarvation`. The property that actually matters is "two different (owner, origin)
// pairs never collide, and the same pair always reproduces the same key" — everything below
// is a direct check of that.
describe('stationedContingentKey', () => {
  it('is stable for the same (ownerAccountId, fromSettlementId) pair', () => {
    const owner = new Types.ObjectId();
    const origin = new Types.ObjectId();
    expect(stationedContingentKey(owner, origin)).toBe(stationedContingentKey(owner, origin));
  });

  it('differs when either half of the pair differs', () => {
    const ownerA = new Types.ObjectId();
    const ownerB = new Types.ObjectId();
    const originA = new Types.ObjectId();
    const originB = new Types.ObjectId();
    expect(stationedContingentKey(ownerA, originA)).not.toBe(
      stationedContingentKey(ownerB, originA),
    );
    expect(stationedContingentKey(ownerA, originA)).not.toBe(
      stationedContingentKey(ownerA, originB),
    );
  });

  it('never collides across a swapped owner/origin pair (fixed-width halves, unambiguous join)', () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    expect(stationedContingentKey(a, b)).not.toBe(stationedContingentKey(b, a));
  });
});
