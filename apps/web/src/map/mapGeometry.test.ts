import { DEFAULT_CONFIG } from '@last-signal/game-core';
import { describe, expect, it } from 'vitest';

import {
  BASE_TILE_SIZE_PX,
  DEFAULT_ZOOM_INDEX,
  ZOOM_STEPS,
  clampCenter,
  computeEdgeClamp,
  computeVisibleTileRange,
  cycleZoom,
  isAtGridEdge,
  isValidJumpTarget,
  panCenterFromDrag,
  parseCoordinateInput,
  pinchZoomDelta,
  pointerDistance,
  tileCountInRange,
  tileSizeForZoom,
  tileTopLeftPx,
} from './mapGeometry';

const { radius } = DEFAULT_CONFIG.map;
// The phone-sized fallback viewport `useElementSize` hands the Map screen when nothing has
// been really laid out yet (its own tests exercise it directly) — reused here so the culling
// bound below is checked against the exact size the real component starts from.
const PHONE_VIEWPORT = { widthPx: 360, heightPx: 480 };
const GRID_TILE_COUNT = (2 * radius + 1) * (2 * radius + 1);

describe('tileSizeForZoom / cycleZoom', () => {
  it('maps each zoom index to the base tile size scaled by its zoom step', () => {
    expect(tileSizeForZoom(0)).toBe(BASE_TILE_SIZE_PX * ZOOM_STEPS[0]);
    expect(tileSizeForZoom(1)).toBe(BASE_TILE_SIZE_PX * ZOOM_STEPS[1]);
    expect(tileSizeForZoom(2)).toBe(BASE_TILE_SIZE_PX * ZOOM_STEPS[2]);
  });

  it('steps by one and clamps at either end rather than wrapping', () => {
    expect(cycleZoom(DEFAULT_ZOOM_INDEX, 1)).toBe(2);
    expect(cycleZoom(2, 1)).toBe(2);
    expect(cycleZoom(DEFAULT_ZOOM_INDEX, -1)).toBe(0);
    expect(cycleZoom(0, -1)).toBe(0);
  });
});

describe('clampCenter', () => {
  it('leaves an in-grid centre untouched', () => {
    expect(clampCenter(DEFAULT_CONFIG, { x: 5, y: -5 })).toEqual({ x: 5, y: -5 });
  });

  it('clamps a centre beyond the grid edge back onto the boundary, on both axes independently', () => {
    expect(clampCenter(DEFAULT_CONFIG, { x: radius + 50, y: 0 })).toEqual({ x: radius, y: 0 });
    expect(clampCenter(DEFAULT_CONFIG, { x: 0, y: -radius - 50 })).toEqual({ x: 0, y: -radius });
    expect(clampCenter(DEFAULT_CONFIG, { x: radius + 1, y: -radius - 1 })).toEqual({
      x: radius,
      y: -radius,
    });
  });
});

describe('computeVisibleTileRange', () => {
  it('returns a range centred on the pan centre, sized from the viewport and tile size', () => {
    const tileSizePx = tileSizeForZoom(1);
    const range = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: 0, y: 0 },
      tileSizePx,
      PHONE_VIEWPORT,
    );
    expect(range.minX).toBeLessThan(0);
    expect(range.maxX).toBeGreaterThan(0);
    expect(range.minY).toBeLessThan(0);
    expect(range.maxY).toBeGreaterThan(0);
    // Symmetric around a centred origin.
    expect(range.maxX).toBe(-range.minX);
    expect(range.maxY).toBe(-range.minY);
  });

  it('clamps the range at the grid edge instead of asking for out-of-grid tiles', () => {
    const tileSizePx = tileSizeForZoom(0);
    const range = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: radius, y: -radius },
      tileSizePx,
      PHONE_VIEWPORT,
    );
    expect(range.maxX).toBe(radius);
    expect(range.minY).toBe(-radius);
    expect(range.minX).toBeGreaterThanOrEqual(-radius);
    expect(range.maxY).toBeLessThanOrEqual(radius);
  });

  it('never returns anywhere close to the whole grid for a phone-sized viewport, at any zoom step', () => {
    for (const zoomIndex of [0, 1, 2] as const) {
      const tileSizePx = tileSizeForZoom(zoomIndex);
      const range = computeVisibleTileRange(
        DEFAULT_CONFIG,
        { x: 0, y: 0 },
        tileSizePx,
        PHONE_VIEWPORT,
      );
      const count = tileCountInRange(range);
      expect(count).toBeLessThan(1000);
      expect(count).toBeLessThan(GRID_TILE_COUNT / 3);
    }
  });

  it('shrinks the tile range as zoom increases (fewer, bigger tiles visible)', () => {
    const rangeZoomedOut = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: 0, y: 0 },
      tileSizeForZoom(0),
      PHONE_VIEWPORT,
    );
    const rangeZoomedIn = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: 0, y: 0 },
      tileSizeForZoom(2),
      PHONE_VIEWPORT,
    );
    expect(tileCountInRange(rangeZoomedIn)).toBeLessThan(tileCountInRange(rangeZoomedOut));
  });
});

describe('computeEdgeClamp / isAtGridEdge', () => {
  it('reports no edge on any side when the range is fully interior', () => {
    const range = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: 0, y: 0 },
      tileSizeForZoom(1),
      PHONE_VIEWPORT,
    );
    const clamp = computeEdgeClamp(DEFAULT_CONFIG, range);
    expect(clamp).toEqual({ north: false, south: false, west: false, east: false });
    expect(isAtGridEdge(clamp)).toBe(false);
  });

  it('reports the east edge when the range is clamped against the +x boundary', () => {
    const range = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: radius, y: 0 },
      tileSizeForZoom(1),
      PHONE_VIEWPORT,
    );
    const clamp = computeEdgeClamp(DEFAULT_CONFIG, range);
    expect(clamp.east).toBe(true);
    expect(clamp.west).toBe(false);
    expect(isAtGridEdge(clamp)).toBe(true);
  });

  it('reports two edges at once for a corner', () => {
    const range = computeVisibleTileRange(
      DEFAULT_CONFIG,
      { x: -radius, y: radius },
      tileSizeForZoom(1),
      PHONE_VIEWPORT,
    );
    const clamp = computeEdgeClamp(DEFAULT_CONFIG, range);
    expect(clamp.west).toBe(true);
    expect(clamp.south).toBe(true);
    expect(clamp.north).toBe(false);
    expect(clamp.east).toBe(false);
    expect(isAtGridEdge(clamp)).toBe(true);
  });
});

describe('panCenterFromDrag', () => {
  it('moves the centre opposite the drag direction, scaled by tile size', () => {
    const tileSizePx = tileSizeForZoom(1);
    const next = panCenterFromDrag(
      DEFAULT_CONFIG,
      { x: 0, y: 0 },
      tileSizePx,
      tileSizePx * 2,
      -tileSizePx,
    );
    expect(next).toEqual({ x: -2, y: 1 });
  });

  it('clamps the resulting centre at the grid edge', () => {
    const tileSizePx = tileSizeForZoom(1);
    const next = panCenterFromDrag(
      DEFAULT_CONFIG,
      { x: radius, y: 0 },
      tileSizePx,
      -tileSizePx * 1000,
      0,
    );
    expect(next.x).toBe(radius);
  });
});

describe('tileTopLeftPx', () => {
  it('positions the tile at the centre coordinate in the middle of the viewport', () => {
    const tileSizePx = 32;
    const { left, top } = tileTopLeftPx({ x: 5, y: 5 }, { x: 5, y: 5 }, tileSizePx, PHONE_VIEWPORT);
    expect(left).toBe(PHONE_VIEWPORT.widthPx / 2 - tileSizePx / 2);
    expect(top).toBe(PHONE_VIEWPORT.heightPx / 2 - tileSizePx / 2);
  });

  it('offsets by exactly one tile size per tile of distance from the centre', () => {
    const tileSizePx = 32;
    const center = { x: 0, y: 0 };
    const a = tileTopLeftPx({ x: 1, y: 0 }, center, tileSizePx, PHONE_VIEWPORT);
    const b = tileTopLeftPx({ x: 0, y: 0 }, center, tileSizePx, PHONE_VIEWPORT);
    expect(a.left - b.left).toBe(tileSizePx);
  });
});

describe('parseCoordinateInput / isValidJumpTarget', () => {
  it('parses a plain integer, including negative and zero', () => {
    expect(parseCoordinateInput('12')).toBe(12);
    expect(parseCoordinateInput('-7')).toBe(-7);
    expect(parseCoordinateInput('0')).toBe(0);
  });

  it('rejects empty, non-numeric and fractional input', () => {
    expect(parseCoordinateInput('')).toBeNull();
    expect(parseCoordinateInput('  ')).toBeNull();
    expect(parseCoordinateInput('abc')).toBeNull();
    expect(parseCoordinateInput('12.5')).toBeNull();
  });

  it('accepts coordinates inside the grid and rejects coordinates outside it', () => {
    expect(isValidJumpTarget(DEFAULT_CONFIG, 0, 0)).toBe(true);
    expect(isValidJumpTarget(DEFAULT_CONFIG, radius, -radius)).toBe(true);
    expect(isValidJumpTarget(DEFAULT_CONFIG, radius + 1, 0)).toBe(false);
    expect(isValidJumpTarget(DEFAULT_CONFIG, 0, -radius - 1)).toBe(false);
  });
});

describe('pointerDistance / pinchZoomDelta', () => {
  it('computes the Euclidean distance between two points', () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('reports no zoom step change below the threshold', () => {
    expect(pinchZoomDelta(100, 110)).toBe(0);
    expect(pinchZoomDelta(100, 90)).toBe(0);
  });

  it('reports a zoom-in step once the spread grows past the threshold', () => {
    expect(pinchZoomDelta(100, 200)).toBe(1);
  });

  it('reports a zoom-out step once the spread shrinks past the threshold', () => {
    expect(pinchZoomDelta(200, 100)).toBe(-1);
  });
});
