import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';

// Every component under test can call `useTranslation()` without each test file wiring up
// i18next itself — same reason `main.tsx` imports this before the first render.
import './i18n/config';

// With `globals: false` (see vite.config.ts), Testing Library's automatic
// afterEach cleanup isn't registered implicitly, so it's wired up explicitly.
afterEach(() => {
  cleanup();
});

// A global stand-in for the realtime socket (M2c.3): `socketClient.ts`'s `getSocket()` is a
// module-level singleton reached from `Onboarding`'s `SettlementGate` (mounted by every test
// that renders past the settlement gate — `BaseScreen.test.tsx`, `MapScreen.test.tsx`,
// `Onboarding.test.tsx`, this module's own `ReportsScreen.test.tsx`/`useReportsRealtime.test.tsx`
// — not just the realtime-specific tests), so this has to live here rather than in any one of
// those files: without it, every one of them would open (or try to open) a real socket.io
// connection, exactly what "the socket stubbed/mocked — do not open a real network connection
// in a unit test" forbids. Each call to `io()` returns a fresh fake, event-emitter-like
// socket; `on`/`off`/`emit`/`connect`/`disconnect` are `vi.fn()`s so a test can assert on how
// they were called, and `__emitServerEvent` lets a test simulate a server push (e.g.
// `reportArrived`) without any real transport.
vi.mock('socket.io-client', () => {
  function createFakeSocket(): Record<string, unknown> {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket: Record<string, unknown> = {
      connected: false,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(handler);
        return socket;
      }),
      off: vi.fn((event: string, handler?: (...args: unknown[]) => void) => {
        if (handler) {
          listeners.get(event)?.delete(handler);
        } else {
          listeners.delete(event);
        }
        return socket;
      }),
      emit: vi.fn(() => socket),
      connect: vi.fn(() => socket),
      disconnect: vi.fn(() => socket),
      __emitServerEvent: (event: string, payload?: unknown) => {
        for (const handler of listeners.get(event) ?? []) {
          handler(payload);
        }
      },
    };
    return socket;
  }

  return { io: vi.fn(() => createFakeSocket()) };
});
