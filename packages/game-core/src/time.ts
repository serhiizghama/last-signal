/** Milliseconds remaining until `dueAt`, clamped at 0. */
export function msUntil(now: number, dueAt: number): number {
  return Math.max(0, dueAt - now);
}

/** Whole seconds remaining until `dueAt`, rounded up, clamped at 0. */
export function secondsUntil(now: number, dueAt: number): number {
  return Math.ceil(msUntil(now, dueAt) / 1000);
}

/** Format a duration in ms as `H:MM:SS` (or `MM:SS` when under an hour). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}
