// Env var names + defaults for the scheduler worker, read through
// ConfigService so tests/deploys can override without code changes.
export const SCHEDULER_ENABLED_KEY = 'SCHEDULER_ENABLED';
export const SCHEDULER_POLL_INTERVAL_MS_KEY = 'SCHEDULER_POLL_INTERVAL_MS';
export const SCHEDULER_LEASE_TIMEOUT_MS_KEY = 'SCHEDULER_LEASE_TIMEOUT_MS';
export const SCHEDULER_MAX_ATTEMPTS_KEY = 'SCHEDULER_MAX_ATTEMPTS';

// Load is ~0.2 events/sec, so a 1s poll is ample — see the design record's
// "Scheduler failure semantics" section.
export const DEFAULT_SCHEDULER_ENABLED = true;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_LEASE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
