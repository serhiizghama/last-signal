import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { io } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPORTS_QUERY_KEY, REPORTS_UNREAD_QUERY_KEY } from '../reports/useReportsQuery';
import { resetSocketForTests } from './socketClient';
import { useReportsRealtime } from './useReportsRealtime';

// The fake socket behind `io` comes from the global mock in `setupTests.ts` (see its own
// comment) — every assertion here reads the fake socket instance that mock created, never a
// real connection.
interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  __emitServerEvent: (event: string, payload?: unknown) => void;
}

function latestFakeSocket(): FakeSocket {
  const socket = vi.mocked(io).mock.results.at(-1)?.value as FakeSocket | undefined;
  if (!socket) {
    throw new Error('io() was never called — useReportsRealtime did not mount its socket');
  }
  return socket;
}

function Harness(): null {
  useReportsRealtime();
  return null;
}

function renderHarness(queryClient: QueryClient): ReturnType<typeof render> {
  function Wrapper(): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    );
  }
  return render(<Wrapper />);
}

afterEach(() => {
  resetSocketForTests();
  vi.clearAllMocks();
});

describe('useReportsRealtime', () => {
  it('subscribes to reportArrived on the shared socket and invalidates the reports queries when it fires', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHarness(queryClient);

    const socket = latestFakeSocket();
    expect(socket.on).toHaveBeenCalledWith('reportArrived', expect.any(Function));

    socket.__emitServerEvent('reportArrived', { id: 'rep-1', type: 'scout', createdAt: 0 });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REPORTS_QUERY_KEY });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: REPORTS_UNREAD_QUERY_KEY });
    });
  });

  it('cleans up its listeners on unmount', () => {
    const queryClient = new QueryClient();
    const { unmount } = renderHarness(queryClient);

    const socket = latestFakeSocket();
    unmount();

    expect(socket.off).toHaveBeenCalledWith('reportArrived', expect.any(Function));
  });

  it('does not throw when the connection fails (connect_error)', () => {
    const queryClient = new QueryClient();
    renderHarness(queryClient);
    const socket = latestFakeSocket();

    expect(() => {
      socket.__emitServerEvent('connect_error', new Error('handshake rejected'));
    }).not.toThrow();
  });
});
