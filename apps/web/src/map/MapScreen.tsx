import type { FormEvent, PointerEvent, ReactElement } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { DEFAULT_CONFIG } from '@last-signal/game-core';
import { useTranslation } from 'react-i18next';

import type { AccountView, SettlementStateView } from '../api/types';
import type { NavTab } from '../base/BottomNav';
import { BottomNav } from '../base/BottomNav';
import { ErrorPanel, LoadingPanel } from '../components/StatusPanels';
import { useServerClock } from '../hooks/useServerClock';
import { MapGrid } from './MapGrid';
import { MapMarkers } from './MapMarkers';
import { MovementsOverlay } from './MovementsOverlay';
import { TileInfoSheet } from './TileInfoSheet';
import type { PointPx, Tile, ZoomIndex } from './mapGeometry';
import {
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
  tileSizeForZoom,
  DEFAULT_ZOOM_INDEX,
  ZOOM_STEPS,
} from './mapGeometry';
import { useElementSize } from './useElementSize';
import { useMapQuery } from './useMapQuery';

interface MapScreenProps {
  account: AccountView;
  settlement: SettlementStateView;
  onNavigateTab: (tab: NavTab) => void;
}

/**
 * The Map tab: a DOM tile grid with viewport culling (see `MapGrid`/`mapGeometry`), drag/pinch
 * pan + explicit zoom controls, jump-to-coordinates and recentre-on-own-settlement (M2c.1),
 * plus the tap-a-tile info sheet, send-scout flow and own-movements overlay (M2c.2). Owns the
 * pan/zoom state and which tile (if any) is selected; everything spatial (culling, panning,
 * zoom stepping, pixel projection) is delegated to the pure functions in `mapGeometry.ts` so it
 * stays unit-testable independent of gesture wiring. The `settlement` prop — already the full
 * `SettlementStateView` the caller (`Onboarding`'s `SettlementGate`) fetched for the base
 * screen — is reused as-is for the scout form's origin/troops rather than fetched a second
 * time, same one-source-of-truth convention `BaseScreen` follows.
 */
export function MapScreen({ account, settlement, onNavigateTab }: MapScreenProps): ReactElement {
  const { t } = useTranslation('map');
  const mapQuery = useMapQuery();
  const [containerRef, viewport] = useElementSize<HTMLDivElement>();
  // §11: beginner protection is judged against the server clock, never the browser's own —
  // anchored on the map payload's own `world.serverTime` (the same convention
  // `MovementsOverlay` already uses for its own countdowns) and threaded down to both
  // `MapMarkers`' protection badge and `TileInfoSheet`'s so the two can never disagree about
  // "now". Falls back to 0 only before the first `GET /api/map` response lands, at which
  // point neither consumer is actually rendered yet (both are gated on `mapQuery.data`).
  const serverNow = useServerClock(mapQuery.data?.world.serverTime) ?? 0;

  const [center, setCenter] = useState<Tile>({ x: settlement.x, y: settlement.y });
  const [zoomIndex, setZoomIndex] = useState<ZoomIndex>(DEFAULT_ZOOM_INDEX);
  const [jumpX, setJumpX] = useState('');
  const [jumpY, setJumpY] = useState('');
  const [jumpError, setJumpError] = useState(false);
  const [selectedTile, setSelectedTile] = useState<Tile | null>(null);

  const tileSizePx = tileSizeForZoom(zoomIndex);

  // Gesture bookkeeping lives in refs, never state: every pointermove would otherwise trigger
  // a re-render just to remember "where the drag started", on top of the one `setCenter`
  // already causes.
  const pointers = useRef<Map<number, PointPx>>(new Map());
  const dragOrigin = useRef<PointPx | null>(null);
  const pinchOrigin = useRef<number | null>(null);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);

    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      if (a && b) {
        pinchOrigin.current = pointerDistance(a, b);
      }
      dragOrigin.current = null;
    } else if (pointers.current.size === 1) {
      dragOrigin.current = { x: event.clientX, y: event.clientY };
    }
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!pointers.current.has(event.pointerId)) {
        return;
      }
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.current.size === 2 && pinchOrigin.current !== null) {
        const [a, b] = Array.from(pointers.current.values());
        if (!a || !b) {
          return;
        }
        const distance = pointerDistance(a, b);
        const delta = pinchZoomDelta(pinchOrigin.current, distance);
        if (delta !== 0) {
          setZoomIndex((z) => cycleZoom(z, delta));
          pinchOrigin.current = distance;
        }
        return;
      }

      if (pointers.current.size === 1 && dragOrigin.current) {
        const deltaX = event.clientX - dragOrigin.current.x;
        const deltaY = event.clientY - dragOrigin.current.y;
        dragOrigin.current = { x: event.clientX, y: event.clientY };
        setCenter((c) => panCenterFromDrag(DEFAULT_CONFIG, c, tileSizePx, deltaX, deltaY));
      }
    },
    [tileSizePx],
  );

  const endPointer = useCallback((event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    dragOrigin.current = null;
    pinchOrigin.current = null;
  }, []);

  const handleZoom = useCallback((direction: 1 | -1) => {
    setZoomIndex((z) => cycleZoom(z, direction));
  }, []);

  // The tap seam (M2c.2): opens the bottom info sheet for the tapped tile's coordinates.
  const handleSelectTile = useCallback((tile: Tile) => {
    setSelectedTile(tile);
  }, []);

  const handleRecentre = useCallback(() => {
    setCenter(clampCenter(DEFAULT_CONFIG, { x: settlement.x, y: settlement.y }));
  }, [settlement.x, settlement.y]);

  const handleJumpSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const x = parseCoordinateInput(jumpX);
      const y = parseCoordinateInput(jumpY);
      if (x === null || y === null || !isValidJumpTarget(DEFAULT_CONFIG, x, y)) {
        setJumpError(true);
        return;
      }
      setJumpError(false);
      setCenter({ x, y });
    },
    [jumpX, jumpY],
  );

  const range = useMemo(
    () => computeVisibleTileRange(DEFAULT_CONFIG, center, tileSizePx, viewport),
    [center, tileSizePx, viewport],
  );
  // The bounded map has a deliberate edge (§1) — when the viewport is showing it, the
  // viewport frame itself gets a visual cue on top of the per-tile boundary line (see
  // `.map-viewport--at-edge` / `.map-tile--edge-*` in styles.css) so it reads as "you've
  // reached the edge of the wasteland", not as a rendering gap.
  const atGridEdge = isAtGridEdge(computeEdgeClamp(DEFAULT_CONFIG, range));

  return (
    <div className="map-screen">
      <header className="panel screen">
        <h2 className="screen__title">{t('title')}</h2>
        {mapQuery.data && (
          <p className="screen__description">
            {t('worldInfo', {
              round: mapQuery.data.world.roundNumber,
              act: mapQuery.data.world.act,
            })}
          </p>
        )}
      </header>

      <div className="map-controls panel">
        <form className="map-jump" onSubmit={handleJumpSubmit}>
          <span className="field__label">{t('jumpLabel')}</span>
          <input
            className="field__input map-jump__input"
            inputMode="numeric"
            aria-label={t('jumpX')}
            placeholder={t('jumpX')}
            value={jumpX}
            onChange={(event) => setJumpX(event.target.value)}
          />
          <input
            className="field__input map-jump__input"
            inputMode="numeric"
            aria-label={t('jumpY')}
            placeholder={t('jumpY')}
            value={jumpY}
            onChange={(event) => setJumpY(event.target.value)}
          />
          <button type="submit" className="button">
            {t('jumpSubmit')}
          </button>
        </form>
        {jumpError && <p className="map-jump__error">{t('jumpInvalid')}</p>}

        <div className="map-controls__row">
          <button type="button" className="button" onClick={handleRecentre}>
            {t('recentre')}
          </button>
          <div className="map-zoom">
            <button
              type="button"
              className="button map-zoom__button"
              onClick={() => handleZoom(-1)}
              disabled={zoomIndex === 0}
              aria-label={t('zoomOut')}
            >
              −
            </button>
            <span className="map-zoom__level">
              {t('zoomLevel', { scale: ZOOM_STEPS[zoomIndex] })}
            </span>
            <button
              type="button"
              className="button map-zoom__button"
              onClick={() => handleZoom(1)}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              aria-label={t('zoomIn')}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {mapQuery.isPending && <LoadingPanel />}
      {mapQuery.isError && (
        <ErrorPanel error={mapQuery.error} onRetry={() => void mapQuery.refetch()} />
      )}

      {mapQuery.data && (
        <div
          ref={containerRef}
          className={`map-viewport${atGridEdge ? ' map-viewport--at-edge' : ''}`}
          role="group"
          aria-label={t('viewport')}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={endPointer}
        >
          <MapGrid
            config={DEFAULT_CONFIG}
            seed={mapQuery.data.world.seed}
            range={range}
            center={center}
            tileSizePx={tileSizePx}
            viewport={viewport}
            onSelectTile={handleSelectTile}
          />
          <MapMarkers
            settlements={mapQuery.data.settlements}
            oases={mapQuery.data.oases}
            ownAccountId={account.id}
            range={range}
            center={center}
            tileSizePx={tileSizePx}
            viewport={viewport}
            serverNow={serverNow}
          />
        </div>
      )}

      <MovementsOverlay />

      {mapQuery.data && selectedTile && (
        <TileInfoSheet
          mapView={mapQuery.data}
          account={account}
          settlement={settlement}
          tile={selectedTile}
          serverNow={serverNow}
          onClose={() => setSelectedTile(null)}
        />
      )}

      <BottomNav active="map" onNavigate={onNavigateTab} />
    </div>
  );
}
