import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ViewportSizePx } from './mapGeometry';

/**
 * A phone-sized default (§11: the Map screen is designed viewport-first for a phone). Used
 * both as the initial state before the first `ResizeObserver` callback fires in a real browser
 * and as the permanent value in any environment that never lays elements out at all (this
 * project's Vitest + happy-dom test environment has no real layout engine, so
 * `ResizeObserver` either never fires or reports 0x0) — the culling math always needs *some*
 * sane, non-zero viewport to cull against.
 */
const FALLBACK_SIZE: ViewportSizePx = { widthPx: 360, heightPx: 480 };

/**
 * Tracks a ref'd element's content-box size for the Map screen's viewport-culling
 * calculation. Ignores any report of a zero-sized box (real in a test environment, degenerate
 * in a real browser before first paint) and keeps the last known-good size instead.
 */
export function useElementSize<T extends Element>(): [RefObject<T>, ViewportSizePx] {
  // The `useRef<T>(null)` overload (as opposed to `useRef<T | null>(null)`) is what yields a
  // `RefObject<T>` the JSX `ref` attribute accepts directly, per React's own typings.
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ViewportSizePx>(FALLBACK_SIZE);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setSize({ widthPx: width, heightPx: height });
      }
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return [ref, size];
}
