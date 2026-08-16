import type { GameConfig, Tile } from '@last-signal/game-core';
import { isInGrid } from '@last-signal/game-core';

export type { Tile };

/** CSS-pixel size of a rendered element (the map viewport, most of the time). */
export interface ViewportSizePx {
  widthPx: number;
  heightPx: number;
}

/** Inclusive tile-coordinate range the viewport-culling function decides to render. */
export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The 3 zoom steps (M2 §11, draft): half, base and double the 32px reference tile. Index into
 * this array is the map screen's zoom state — a small closed set rather than a continuous
 * scale, matching the design record's "3 zoom steps" decision exactly.
 */
export const ZOOM_STEPS = [0.5, 1, 2] as const;
export type ZoomIndex = 0 | 1 | 2;
export const DEFAULT_ZOOM_INDEX: ZoomIndex = 1;
export const BASE_TILE_SIZE_PX = 32;

/** The rendered tile size in CSS px for a given zoom step. */
export function tileSizeForZoom(zoomIndex: ZoomIndex): number {
  return BASE_TILE_SIZE_PX * ZOOM_STEPS[zoomIndex];
}

/** Steps zoom by one increment, clamped at either end (does not wrap past 0.5x or 2x). */
export function cycleZoom(zoomIndex: ZoomIndex, direction: 1 | -1): ZoomIndex {
  const next = zoomIndex + direction;
  return Math.min(ZOOM_STEPS.length - 1, Math.max(0, next)) as ZoomIndex;
}

/**
 * Clamps a pan centre to the bounded, non-wrapping grid (§1): panning can bring the centre
 * right up to an edge, never past it — "clamp at the edges, not scroll into the void".
 */
export function clampCenter(config: GameConfig, center: Tile): Tile {
  const { radius } = config.map;
  return {
    x: Math.min(radius, Math.max(-radius, center.x)),
    y: Math.min(radius, Math.max(-radius, center.y)),
  };
}

/** Extra tiles rendered past the strict viewport edge, so a tile straddling the boundary never pops in/out abruptly. */
const CULL_PAD_TILES = 1;

/**
 * The load-bearing culling function for the whole Map screen: given the current pan centre,
 * the active zoom's tile size and the viewport's CSS-pixel size, returns the inclusive tile
 * range that's actually visible (plus a 1-tile pad), clamped to the bounded grid. 61x61 =
 * 3721 tiles must never all mount — this is the pure function that keeps the DOM to only the
 * tiles a phone-sized viewport can actually show, independent of any component or event
 * handling.
 */
export function computeVisibleTileRange(
  config: GameConfig,
  center: Tile,
  tileSizePx: number,
  viewport: ViewportSizePx,
): TileRange {
  const halfTilesX = viewport.widthPx / tileSizePx / 2;
  const halfTilesY = viewport.heightPx / tileSizePx / 2;
  const { radius } = config.map;

  return {
    minX: Math.max(-radius, Math.floor(center.x - halfTilesX) - CULL_PAD_TILES),
    maxX: Math.min(radius, Math.ceil(center.x + halfTilesX) + CULL_PAD_TILES),
    minY: Math.max(-radius, Math.floor(center.y - halfTilesY) - CULL_PAD_TILES),
    maxY: Math.min(radius, Math.ceil(center.y + halfTilesY) + CULL_PAD_TILES),
  };
}

/** How many tiles a range covers — the number the Map screen's DOM must never approach 3721 of. */
export function tileCountInRange(range: TileRange): number {
  const width = Math.max(0, range.maxX - range.minX + 1);
  const height = Math.max(0, range.maxY - range.minY + 1);
  return width * height;
}

/** Which sides of a visible tile range actually sit on the bounded grid's boundary (§1) — the wasteland has an edge, and the viewport can be showing it on any combination of sides at once (a corner shows two). */
export interface EdgeClamp {
  north: boolean;
  south: boolean;
  west: boolean;
  east: boolean;
}

/**
 * True on whichever sides `range` touches `config.map.radius` — i.e. the world's edge is
 * inside the viewport on that side, so the "beyond the map" void treatment (a distinct void
 * background plus a boundary line on the last real row/column of tiles, see `styles.css`'s
 * `.map-viewport`/`.map-tile--edge-*` rules) needs to read as deliberate there, not as a
 * rendering gap. Whether `range` reached the boundary by clamping or simply landed there
 * doesn't matter — either way the edge is visible, so the treatment should show.
 */
export function computeEdgeClamp(config: GameConfig, range: TileRange): EdgeClamp {
  const { radius } = config.map;
  return {
    north: range.minY <= -radius,
    south: range.maxY >= radius,
    west: range.minX <= -radius,
    east: range.maxX >= radius,
  };
}

/** True when the viewport is showing the world's edge on at least one side. */
export function isAtGridEdge(clamp: EdgeClamp): boolean {
  return clamp.north || clamp.south || clamp.west || clamp.east;
}

/**
 * Converts a mouse/touch drag delta (CSS px, screen-down/right positive) into a new, clamped
 * pan centre. Dragging the map right/down reveals tiles to the left/up, so the centre moves
 * opposite the drag direction — the same convention every pannable map UI uses.
 */
export function panCenterFromDrag(
  config: GameConfig,
  center: Tile,
  tileSizePx: number,
  deltaPxX: number,
  deltaPxY: number,
): Tile {
  return clampCenter(config, {
    x: center.x - deltaPxX / tileSizePx,
    y: center.y - deltaPxY / tileSizePx,
  });
}

/** Top-left CSS position (px, relative to the viewport container) for a `tileSizePx`-square element centred on `tile`, given the current pan centre. Shared by tiles and markers so both layers line up pixel-for-pixel. */
export function tileTopLeftPx(
  tile: Tile,
  center: Tile,
  tileSizePx: number,
  viewport: ViewportSizePx,
): { left: number; top: number } {
  return {
    left: viewport.widthPx / 2 + (tile.x - center.x) * tileSizePx - tileSizePx / 2,
    top: viewport.heightPx / 2 + (tile.y - center.y) * tileSizePx - tileSizePx / 2,
  };
}

/**
 * Parses a jump-to-coordinates text field: `null` for empty/non-integer input, the integer
 * value otherwise. Kept separate from grid-bounds validation (`isValidJumpTarget` below) so a
 * malformed string and an out-of-range coordinate can be reported identically by the caller
 * without duplicating the "is this even a number" check.
 */
export function parseCoordinateInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/** True when `{x, y}` is an in-grid tile a jump-to-coordinates action may centre on. */
export function isValidJumpTarget(config: GameConfig, x: number, y: number): boolean {
  return isInGrid(config, { x, y });
}

export interface PointPx {
  x: number;
  y: number;
}

/** Euclidean distance between two pointer positions, for pinch-to-zoom. */
export function pointerDistance(a: PointPx, b: PointPx): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Finger-spread change (px) that registers as one discrete pinch zoom step. */
const PINCH_ZOOM_THRESHOLD_PX = 40;

/**
 * Given the pointer spread distance at the start of a pinch gesture (or since the last step)
 * and the current distance, returns the zoom step delta to apply once the spread has crossed
 * the threshold in either direction, or 0 if it hasn't yet. Only 3 zoom steps exist, so pinch
 * is discrete like the +/- buttons, not a continuous scale — callers should reset their
 * "start" reference to the current distance after acting on a non-zero result, so each further
 * threshold crossing fires exactly once.
 */
export function pinchZoomDelta(startDistancePx: number, currentDistancePx: number): -1 | 0 | 1 {
  const delta = currentDistancePx - startDistancePx;
  if (delta > PINCH_ZOOM_THRESHOLD_PX) {
    return 1;
  }
  if (delta < -PINCH_ZOOM_THRESHOLD_PX) {
    return -1;
  }
  return 0;
}
