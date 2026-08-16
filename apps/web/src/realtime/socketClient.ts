import { io, type Socket } from 'socket.io-client';

let socket: Socket | undefined;

/**
 * The one shared socket.io connection for the whole app (§ M2c.3 brief: "a single shared
 * connection, not one per component"). Created lazily, on the first subscriber, rather than at
 * module load — importing this module (e.g. transitively, from a test that never calls
 * `getSocket`) must never open a connection by itself. Every subscriber (today, only
 * `useReportsRealtime`) adds/removes its own listeners on this one socket rather than calling
 * `io()` itself.
 *
 * `path: '/ws'` matches the server's own gateway path (`RealtimeGateway`) and the dev proxy's
 * `/ws` entry (`vite.config.ts`) / production Caddy routing — never a hardcoded origin, same
 * relative-path convention `apiClient` uses for `/api`. No explicit URI is passed, so the
 * client connects to the page's own origin. `withCredentials: true` mirrors `apiClient`'s
 * `credentials: 'include'`: the gateway authenticates off the same httpOnly session cookie as
 * the REST API (`RealtimeGateway.authenticate`), no separate credential to attach.
 */
export function getSocket(): Socket {
  socket ??= io({ path: '/ws', withCredentials: true });
  return socket;
}

/**
 * Test-only escape hatch: drops the cached connection so the next `getSocket()` call opens a
 * fresh one. Never called from application code — only from test teardown, to isolate the
 * singleton between test cases that each mount `useReportsRealtime` themselves.
 */
export function resetSocketForTests(): void {
  socket?.disconnect();
  socket = undefined;
}
