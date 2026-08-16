import type { MapOasisView, MapSettlementView, MapView } from '../api/types';

/**
 * Which of the four tile kinds the info sheet (§11) distinguishes, plus exactly the data each
 * one needs to render. A pure classification of coordinates against the already-loaded map
 * payload — no I/O, no `game-core` formulas (terrain is derived separately by the caller via
 * `terrainAt`, since that needs the world seed the sheet already has from `MapView.world`).
 */
export type TileSelection =
  | { kind: 'empty'; x: number; y: number }
  | { kind: 'oasis'; x: number; y: number; oasis: MapOasisView }
  | { kind: 'settlement'; x: number; y: number; settlement: MapSettlementView; isOwn: boolean };

/**
 * Classifies a tapped tile. A settlement takes priority over an oasis at the same coordinate
 * (never both in practice — §2/§3 guarantee a settlement is never founded on an oasis tile —
 * but the settlement check runs first regardless, so the branch order itself can't hide a
 * data bug). `isOwn` mirrors `MapMarkers`'s own `ownerAccountId === ownAccountId` check, so the
 * sheet and the marker overlay never disagree about which settlement is "yours".
 */
export function classifyTile(
  mapView: Pick<MapView, 'settlements' | 'oases'>,
  ownAccountId: string,
  x: number,
  y: number,
): TileSelection {
  const settlement = mapView.settlements.find((s) => s.x === x && s.y === y);
  if (settlement) {
    return {
      kind: 'settlement',
      x,
      y,
      settlement,
      isOwn: settlement.ownerAccountId === ownAccountId,
    };
  }

  const oasis = mapView.oases.find((o) => o.x === x && o.y === y);
  if (oasis) {
    return { kind: 'oasis', x, y, oasis };
  }

  return { kind: 'empty', x, y };
}
