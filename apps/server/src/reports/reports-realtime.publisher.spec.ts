import { EventEmitter } from 'node:events';

import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ReportDocument } from '../schemas/report.schema';
import { ReportsRealtimePublisher } from './reports-realtime.publisher';

// A minimal stand-in for mongoose's `ChangeStream` (itself an `EventEmitter` — see
// `mongoose/lib/cursor/changeStream.js`): real enough for `ReportsRealtimePublisher` to drive
// through `.on('change'|'error'|'close'|'ready', ...)` and `.close()`, with nothing else it
// doesn't use. `close` is a `vi.fn()` so tests can assert the publisher actually tries to
// clean up a dead stream before reconnecting (`handleStreamDown`'s "best effort" close).
class FakeChangeStream extends EventEmitter {
  readonly close = vi.fn(() => Promise.resolve());
}

// Proves the M2b.4 follow-up fix: a change-stream `error`/`close` must not permanently kill
// realtime pushes (the real-world failure this test guards against: a transient Mongo
// connection-pool blip silently stopped `reportArrived` for the rest of the process's life —
// see the reconnect-supervisor comment on `ReportsRealtimePublisher` itself). Pure unit test,
// no Mongo/Nest DI involved: `reportModel.watch`/`gateway.emitToAccount` are the only two
// surface points this class touches, so both are hand-rolled fakes, and reconnect timing is
// driven with fake timers rather than real sleeps (recovering for real takes up to 30s at the
// backoff cap — unusable in a test otherwise).
describe('ReportsRealtimePublisher (reconnect supervisor)', () => {
  let watchMock: ReturnType<typeof vi.fn>;
  let emitToAccountMock: ReturnType<typeof vi.fn>;
  let streams: FakeChangeStream[];
  let publisher: ReportsRealtimePublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    streams = [];
    watchMock = vi.fn(() => {
      const stream = new FakeChangeStream();
      streams.push(stream);
      return stream;
    });
    emitToAccountMock = vi.fn();

    const fakeReportModel = { watch: watchMock } as unknown as Model<ReportDocument>;
    const fakeGateway = { emitToAccount: emitToAccountMock } as unknown as RealtimeGateway;
    publisher = new ReportsRealtimePublisher(fakeReportModel, fakeGateway);
  });

  afterEach(async () => {
    await publisher.onModuleDestroy();
    vi.useRealTimers();
  });

  function emitInsert(stream: FakeChangeStream, accountId: Types.ObjectId): void {
    stream.emit('change', {
      operationType: 'insert',
      fullDocument: { _id: new Types.ObjectId(), accountId, type: 'scout', createdAt: 123 },
    });
  }

  it('happy path: forwards an insert as reportArrived with the minimal payload', () => {
    publisher.onModuleInit();
    expect(watchMock).toHaveBeenCalledTimes(1);
    const [stream] = streams;
    if (!stream) throw new Error('unreachable');

    const accountId = new Types.ObjectId();
    emitInsert(stream, accountId);

    expect(emitToAccountMock).toHaveBeenCalledTimes(1);
    const [emittedAccountId, event, payload] = emitToAccountMock.mock.calls[0] as [
      Types.ObjectId,
      string,
      { id: string; type: string; createdAt: number },
    ];
    expect(emittedAccountId).toBe(accountId);
    expect(event).toBe('reportArrived');
    expect(payload).toMatchObject({ type: 'scout', createdAt: 123 });
  });

  it('recovers after an error: reopens once after the backoff, not before, and keeps working', () => {
    publisher.onModuleInit();
    expect(watchMock).toHaveBeenCalledTimes(1);
    const [firstStream] = streams;
    if (!firstStream) throw new Error('unreachable');

    firstStream.emit('error', new Error('PoolClearedOnNetworkError: server monitor timeout'));

    // Best-effort close attempted on the dead stream, but no immediate reopen — a reconnect is
    // scheduled, not fired synchronously.
    expect(firstStream.close).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Not yet at the backoff boundary — still no reopen.
    vi.advanceTimersByTime(999);
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Crosses the (first, base) backoff — exactly one new stream opens.
    vi.advanceTimersByTime(1);
    expect(watchMock).toHaveBeenCalledTimes(2);
    const secondStream = streams[1];
    if (!secondStream) throw new Error('unreachable');

    // Recovery isn't just "watch() got called again" — the new stream must actually work.
    secondStream.emit('ready');
    const accountId = new Types.ObjectId();
    emitInsert(secondStream, accountId);
    expect(emitToAccountMock).toHaveBeenCalledTimes(1);
    expect(emitToAccountMock.mock.calls[0]?.[0]).toBe(accountId);
  });

  it('backs off exponentially across consecutive failures, capped, and resets after a real recovery', () => {
    publisher.onModuleInit();
    const [stream1] = streams;
    if (!stream1) throw new Error('unreachable');

    stream1.emit('error', new Error('down'));
    vi.advanceTimersByTime(1_000); // 1st backoff: base delay
    expect(watchMock).toHaveBeenCalledTimes(2);

    const stream2 = streams[1];
    if (!stream2) throw new Error('unreachable');
    stream2.emit('error', new Error('still down'));
    vi.advanceTimersByTime(1_999);
    expect(watchMock).toHaveBeenCalledTimes(2); // 2nd backoff hasn't elapsed yet (2x base)
    vi.advanceTimersByTime(1);
    expect(watchMock).toHaveBeenCalledTimes(3);

    const stream3 = streams[2];
    if (!stream3) throw new Error('unreachable');
    // A genuine recovery resets the backoff back to the base delay.
    stream3.emit('ready');
    stream3.emit('error', new Error('flaked again'));
    vi.advanceTimersByTime(999);
    expect(watchMock).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(watchMock).toHaveBeenCalledTimes(4);
  });

  it('never overlaps two reconnect schedules when error and close both fire for the same failure', () => {
    publisher.onModuleInit();
    const [stream] = streams;
    if (!stream) throw new Error('unreachable');

    stream.emit('error', new Error('down'));
    stream.emit('close');

    vi.advanceTimersByTime(1_000);
    // Exactly one reopen, not two — `error` and `close` for the same dead stream must not
    // double-schedule.
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it('an unexpected close with no prior error also triggers recovery', () => {
    publisher.onModuleInit();
    const [stream] = streams;
    if (!stream) throw new Error('unreachable');

    stream.emit('close');
    vi.advanceTimersByTime(1_000);
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy stops the supervisor: no leaked reconnect timer, no stream reopened afterward', async () => {
    publisher.onModuleInit();
    const [stream] = streams;
    if (!stream) throw new Error('unreachable');

    stream.emit('error', new Error('down'));
    expect(watchMock).toHaveBeenCalledTimes(1); // reconnect is pending, not yet fired

    await publisher.onModuleDestroy();
    expect(stream.close).toHaveBeenCalled();

    // If the pending reconnect timer had survived shutdown, this would open a second stream.
    vi.advanceTimersByTime(60_000);
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy closes a healthy (never-errored) stream and schedules no reconnect for that close', async () => {
    publisher.onModuleInit();
    const [stream] = streams;
    if (!stream) throw new Error('unreachable');

    await publisher.onModuleDestroy();
    expect(stream.close).toHaveBeenCalledTimes(1);

    // `onModuleDestroy`'s own close would otherwise fire this stream's `close` listener too —
    // must not be mistaken for an unexpected drop and reconnected.
    stream.emit('close');
    vi.advanceTimersByTime(60_000);
    expect(watchMock).toHaveBeenCalledTimes(1);
  });
});
