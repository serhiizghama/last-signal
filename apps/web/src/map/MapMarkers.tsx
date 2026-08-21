import type { ReactElement } from 'react';
import { isBeginnerProtected } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { Faction, MapOasisView, MapSettlementView } from '../api/types';
import type { Tile, TileRange, ViewportSizePx } from './mapGeometry';
import { tileTopLeftPx } from './mapGeometry';

interface MapMarkersProps {
  settlements: readonly MapSettlementView[];
  oases: readonly MapOasisView[];
  /** The caller's own account id (from `GET /api/auth/me`) — matched against `ownerAccountId` to mark the player's own settlement without a second round trip (§5). */
  ownAccountId: string;
  range: TileRange;
  center: Tile;
  tileSizePx: number;
  viewport: ViewportSizePx;
  /** The server clock, ticking (`useServerClock` in `MapScreen`) — §11 requires beginner protection to be judged against it, never the browser's own clock. */
  serverNow: number;
}

function isWithinRange(range: TileRange, x: number, y: number): boolean {
  return x >= range.minX && x <= range.maxX && y >= range.minY && y <= range.maxY;
}

/** Faction -> marker tint, reusing the existing UI palette tokens rather than inventing new hex (matches `docs/ASSET_PROMPTS.md`'s own faction emblem colours: rust-red Raiders, steel-ish teal Engineers, moss-green Nomads). */
const FACTION_MODIFIER: Record<Faction, string> = {
  raiders: 'map-marker--raiders',
  engineers: 'map-marker--engineers',
  nomads: 'map-marker--nomads',
};

/**
 * The settlement + oasis marker overlay, drawn on top of `MapGrid` at the same tile
 * coordinates via the same `tileTopLeftPx` projection so both layers line up pixel-for-pixel.
 * Culled to `range` for consistency with the tile grid, even though the marker count (≤ ~160
 * settlements + 24 oases, §12) is nowhere near the tile-count concern the grid itself exists
 * to solve.
 */
export function MapMarkers({
  settlements,
  oases,
  ownAccountId,
  range,
  center,
  tileSizePx,
  viewport,
  serverNow,
}: MapMarkersProps): ReactElement {
  const { t } = useTranslation('map');

  const visibleOases = oases.filter((oasis) => isWithinRange(range, oasis.x, oasis.y));
  const visibleSettlements = settlements.filter((settlement) =>
    isWithinRange(range, settlement.x, settlement.y),
  );

  return (
    <>
      {visibleOases.map((oasis) => {
        const { left, top } = tileTopLeftPx(oasis, center, tileSizePx, viewport);
        return (
          <div
            key={`oasis:${oasis.x}:${oasis.y}`}
            className="map-marker map-marker--oasis"
            style={{ left, top, width: tileSizePx, height: tileSizePx }}
            title={t('oasisLabel')}
            data-x={oasis.x}
            data-y={oasis.y}
            data-marker="oasis"
          />
        );
      })}

      {visibleSettlements.map((settlement) => {
        const { left, top } = tileTopLeftPx(settlement, center, tileSizePx, viewport);
        const isOwn = settlement.ownerAccountId === ownAccountId;
        // §11: present on the wire only while actually still in effect (`buildMapSettlementView`'s
        // own comment), so this needs no extra "has it lapsed" check of its own — the same
        // `isBeginnerProtected(protectedUntil, serverNow)` call the tile sheet and the server
        // both use, never a re-derivation of the rule.
        const isProtected = isBeginnerProtected(settlement.protectedUntil, serverNow);
        const factionClass = settlement.ownerFaction
          ? FACTION_MODIFIER[settlement.ownerFaction]
          : '';
        const sideClass = settlement.ownerSide ? `map-marker--side-${settlement.ownerSide}` : '';
        const ownClass = isOwn ? 'map-marker--own' : '';
        const protectedClass = isProtected ? 'map-marker--protected' : '';
        const className = [
          'map-marker',
          'map-marker--settlement',
          factionClass,
          sideClass,
          ownClass,
          protectedClass,
        ]
          .filter(Boolean)
          .join(' ');
        const ownerTitle = isOwn
          ? t('ownSettlement')
          : t('settlementLabel', { name: settlement.name, owner: settlement.ownerName });

        return (
          <div
            key={settlement.id}
            className={className}
            style={{ left, top, width: tileSizePx, height: tileSizePx }}
            title={isProtected ? `${ownerTitle} — ${t('sheet.protectedBadge')}` : ownerTitle}
            data-x={settlement.x}
            data-y={settlement.y}
            data-marker="settlement"
            data-own={isOwn ? 'true' : 'false'}
            data-protected={isProtected ? 'true' : 'false'}
            data-settlement-id={settlement.id}
          />
        );
      })}
    </>
  );
}
