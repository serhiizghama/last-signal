// The `NotificationDispatchHandler` event type (`NotificationDispatchService`'s own comment
// explains why a self-rescheduling `GameEvent`, not a change stream or a hook off
// `SchedulerService`, drives the drain loop).
export const NOTIFICATION_DISPATCH_EVENT_TYPE = 'notificationDispatch';

// How often the dispatcher drains the outbox once it's caught up — short enough that an
// in-app push still feels live (§16/§20's acceptance bullet: "an in-app notification fires"),
// long enough that an idle world (no notifications at all, the common case between rounds of
// activity) costs one cheap indexed query every couple of seconds rather than a tight loop.
// Same order of magnitude as `SchedulerService`'s own 1s poll — see that constant's comment
// ("load is ~0.2 events/sec, so a 1s poll is ample") for the same reasoning applied here.
export const NOTIFICATION_DISPATCH_INTERVAL_MS = 2_000;

// Bounds how many undelivered rows one dispatch tick reads/writes, so a backlog (e.g. after
// downtime) can never turn a single tick's transaction into an unbounded one. At this
// project's scale (§19.14: "load is ~0.2 events/sec") a backlog this large would mean the
// dispatcher was down for a long time; draining it over a handful of back-to-back ticks
// (each one reschedules immediately once it is full — see `NotificationDispatchHandler`) is
// an acceptable tradeoff for keeping every single tick's transaction small and fast.
export const NOTIFICATION_DISPATCH_BATCH_SIZE = 200;
