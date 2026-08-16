import type { ReactElement } from 'react';
import { useMemo } from 'react';
import type { GameConfig, TerrainId } from '@last-signal/game-core';
import { terrainAt } from '@last-signal/game-core';

import type { Tile, TileRange, ViewportSizePx } from './mapGeometry';
import { tileTopLeftPx } from './mapGeometry';
import { MapTile } from './MapTile';

interface MapGridProps {
  config: GameConfig;
  seed: string;
  range: TileRange;
  center: Tile;
  tileSizePx: number;
  viewport: ViewportSizePx;
  /** The tap seam (M2c.2): forwarded verbatim to every `MapTile`'s own `onSelect`. */
  onSelectTile?: (tile: Tile) => void;
}

interface TileEntry {
  x: number;
  y: number;
  terrain: TerrainId;
  /** Which sides of this tile sit on the bounded grid's own boundary (§1) — drives the edge-of-the-world border in `MapTile`/`styles.css`. A corner tile has two. */
  edges: { north: boolean; south: boolean; west: boolean; east: boolean };
}

/**
 * Renders exactly the tiles inside `range` — the culled set `computeVisibleTileRange` already
 * decided on — never the whole 61x61 grid. Terrain is derived here, not carried on the wire
 * (§2): every tile calls the same `terrainAt` the server would, keyed off the world seed, so
 * client and server always agree without shipping a single terrain byte over HTTP.
 *
 * The tile list itself is memoized on `range` (not on `center`, which changes continuously
 * while dragging): panning within the same visible range only repositions existing tiles via
 * `tileTopLeftPx`, it never re-derives terrain for tiles that were already computed.
 */
export function MapGrid({
  config,
  seed,
  range,
  center,
  tileSizePx,
  viewport,
  onSelectTile,
}: MapGridProps): ReactElement {
  const tiles = useMemo<TileEntry[]>(() => {
    const { radius } = config.map;
    const entries: TileEntry[] = [];
    for (let y = range.minY; y <= range.maxY; y += 1) {
      for (let x = range.minX; x <= range.maxX; x += 1) {
        entries.push({
          x,
          y,
          terrain: terrainAt(config, seed, x, y),
          edges: {
            north: y === -radius,
            south: y === radius,
            west: x === -radius,
            east: x === radius,
          },
        });
      }
    }
    return entries;
  }, [config, seed, range.minX, range.maxX, range.minY, range.maxY]);

  return (
    <>
      {tiles.map((tile) => {
        const { left, top } = tileTopLeftPx(tile, center, tileSizePx, viewport);
        return (
          <MapTile
            key={`${tile.x}:${tile.y}`}
            x={tile.x}
            y={tile.y}
            terrain={tile.terrain}
            sizePx={tileSizePx}
            leftPx={left}
            topPx={top}
            edges={tile.edges}
            onSelect={onSelectTile}
          />
        );
      })}
    </>
  );
}
