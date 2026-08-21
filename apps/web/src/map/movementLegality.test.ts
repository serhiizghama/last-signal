import { describe, expect, it } from 'vitest';

import type { MapSettlementView, MapOasisView } from '../api/types';
import { legalAttackTypesForTarget } from './movementLegality';
import type { TileSelection } from './tileSelection';

function settlementView(overrides: Partial<MapSettlementView> = {}): MapSettlementView {
  return {
    id: 'set-target',
    x: 3,
    y: -2,
    name: 'Форпост',
    ownerAccountId: 'acc-other',
    ownerName: 'Странник',
    ...overrides,
  };
}

const OASIS: MapOasisView = { x: -4, y: 5, type: 'farm' };

describe('legalAttackTypesForTarget (§9/§10/§8/M3c.6)', () => {
  it('an oasis accepts raid and assault, never support (§10: nothing there to hold)', () => {
    const selection: TileSelection = { kind: 'oasis', x: OASIS.x, y: OASIS.y, oasis: OASIS };
    expect(legalAttackTypesForTarget(selection, 'set-own')).toEqual(['raid', 'assault']);
  });

  it('a foreign settlement accepts all three (§9)', () => {
    const selection: TileSelection = {
      kind: 'settlement',
      x: 3,
      y: -2,
      settlement: settlementView(),
      isOwn: false,
    };
    expect(legalAttackTypesForTarget(selection, 'set-own')).toEqual(['raid', 'assault', 'support']);
  });

  it("another of the caller's own settlements accepts support only (§8)", () => {
    const selection: TileSelection = {
      kind: 'settlement',
      x: 3,
      y: -2,
      settlement: settlementView({ id: 'set-other-own' }),
      isOwn: true,
    };
    expect(legalAttackTypesForTarget(selection, 'set-own')).toEqual(['support']);
  });

  it('the literal origin settlement accepts nothing (M3c.6: targetIsOrigin)', () => {
    const selection: TileSelection = {
      kind: 'settlement',
      x: 0,
      y: 0,
      settlement: settlementView({ id: 'set-own' }),
      isOwn: true,
    };
    expect(legalAttackTypesForTarget(selection, 'set-own')).toEqual([]);
  });
});
