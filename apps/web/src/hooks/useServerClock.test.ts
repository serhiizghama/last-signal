import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCountdown, useCountdownWindow, useServerClock } from './useServerClock';

afterEach(() => {
  vi.useRealTimers();
});

describe('useServerClock', () => {
  it('returns undefined until a serverTime is available', () => {
    const { result } = renderHook(() => useServerClock(undefined));
    expect(result.current).toBeUndefined();
  });

  it('anchors on performance.now() and advances with elapsed monotonic time, not wall-clock time', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useServerClock(1_000_000));

    expect(result.current).toBe(1_000_000);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(1_001_000);
  });
});

describe('useCountdown', () => {
  it('counts down to dueAt and reaches zero without going negative', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCountdown(1_000_000, 1_002_000));

    expect(result.current).toBe(2000);

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(result.current).toBe(0);
  });
});

describe('useCountdownWindow', () => {
  it('ticks down once per second, matching the original App countdown behaviour', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCountdownWindow(1_000_000, 60_000));

    expect(result.current).toBe(60_000);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(59_000);
  });
});
