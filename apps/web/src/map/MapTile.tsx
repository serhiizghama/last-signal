import type { ReactElement } from 'react';
import { memo } from 'react';
import type { TerrainId } from '@last-signal/game-core';

import { TERRAIN_COLORS } from './terrainPalette';

export interface MapTileSelection {
  x: number;
  y: number;
}

export interface MapTileEdges {
  north: boolean;
  south: boolean;
  west: boolean;
  east: boolean;
}

const NO_EDGES: MapTileEdges = { north: false, south: false, west: false, east: false };

interface MapTileProps {
  x: number;
  y: number;
  terrain: TerrainId;
  sizePx: number;
  leftPx: number;
  topPx: number;
  /** Which sides of this tile sit on the bounded grid's boundary (§1) — draws the "edge of the wasteland" border instead of leaving the void beyond it looking like a rendering gap. */
  edges?: MapTileEdges;
  /**
   * The tap seam (M2c.2): opens the bottom info sheet for this tile's coordinates. Wired by
   * `MapGrid`/`MapScreen`, which is why the callback only ever needs `{x, y}` here — the sheet
   * itself re-classifies the tile against the already-loaded map payload (`classifyTile`).
   */
  onSelect?: (tile: MapTileSelection) => void;
}

function edgeClassName(edges: MapTileEdges): string {
  const classes = [
    edges.north && 'map-tile--edge-n',
    edges.south && 'map-tile--edge-s',
    edges.west && 'map-tile--edge-w',
    edges.east && 'map-tile--edge-e',
  ].filter(Boolean);
  return classes.length > 0 ? ` ${classes.join(' ')}` : '';
}

function MapTileImpl({
  x,
  y,
  terrain,
  sizePx,
  leftPx,
  topPx,
  edges = NO_EDGES,
  onSelect,
}: MapTileProps): ReactElement {
  return (
    <div
      className={`map-tile${edgeClassName(edges)}`}
      data-x={x}
      data-y={y}
      data-terrain={terrain}
      style={{
        width: sizePx,
        height: sizePx,
        left: leftPx,
        top: topPx,
        backgroundColor: TERRAIN_COLORS[terrain],
      }}
      onClick={onSelect ? () => onSelect({ x, y }) : undefined}
    />
  );
}

/** Memoized: only its own props changing (not every re-render of the grid) should re-render a tile. */
export const MapTile = memo(MapTileImpl);
