const RU_LOCALE = 'ru-RU';

/**
 * Absolute wall-clock formatting for a report's `createdAt`/`payload.at` — unlike every other
 * timestamp in this app (a countdown *to* a future `dueAt`, always run against
 * `useServerClock`, e.g. `useCountdown`), a report is history: there is nothing left to count
 * down to, so this renders it as a fixed local date+time string instead.
 */
export function formatReportTime(ms: number): string {
  return new Date(ms).toLocaleString(RU_LOCALE);
}
