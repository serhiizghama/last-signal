import { describe, expect, it } from 'vitest';
import { formatDuration, msUntil, secondsUntil } from './time.js';

describe('msUntil', () => {
  it('returns the remaining milliseconds when dueAt is in the future', () => {
    expect(msUntil(1000, 5000)).toBe(4000);
  });

  it('clamps to 0 when dueAt equals now', () => {
    expect(msUntil(1000, 1000)).toBe(0);
  });

  it('clamps to 0 when dueAt is in the past', () => {
    expect(msUntil(5000, 1000)).toBe(0);
  });
});

describe('secondsUntil', () => {
  it('rounds up partial seconds', () => {
    expect(secondsUntil(0, 1001)).toBe(2);
  });

  it('does not round up when exactly on a second boundary', () => {
    expect(secondsUntil(0, 2000)).toBe(2);
  });

  it('returns 0 when dueAt equals now', () => {
    expect(secondsUntil(1000, 1000)).toBe(0);
  });

  it('clamps to 0 for an expired duration', () => {
    expect(secondsUntil(5000, 1000)).toBe(0);
  });

  it('rounds up a single millisecond over zero', () => {
    expect(secondsUntil(0, 1)).toBe(1);
  });
});

describe('formatDuration', () => {
  it('formats a sub-minute duration as MM:SS', () => {
    expect(formatDuration(45_000)).toBe('00:45');
  });

  it('formats an exact-zero duration as 00:00', () => {
    expect(formatDuration(0)).toBe('00:00');
  });

  it('clamps a negative duration to 00:00', () => {
    expect(formatDuration(-5000)).toBe('00:00');
  });

  it('formats a multi-minute, sub-hour duration as MM:SS', () => {
    expect(formatDuration(5 * 60_000 + 9_000)).toBe('05:09');
  });

  it('formats an over-an-hour duration as H:MM:SS', () => {
    expect(formatDuration(2 * 3_600_000 + 3 * 60_000 + 4_000)).toBe('2:03:04');
  });

  it('formats an exact-hour duration with zeroed minutes and seconds', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
  });

  it('rounds up sub-second remainders to the next whole second', () => {
    expect(formatDuration(59_500)).toBe('01:00');
  });
});
