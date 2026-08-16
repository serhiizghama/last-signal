import { Inject, Logger } from '@nestjs/common';
import type { OnGatewayConnection, OnGatewayInit } from '@nestjs/websockets';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Types } from 'mongoose';

import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE_NAME } from '../auth/auth.constants';
import { parseCorsOrigins } from '../cors-origins';
import { parseCookieHeader } from './parse-cookie-header';

// Every account's pushes are broadcast to this one room — an account may have several tabs
// open (§ M2b.4 brief), each its own socket, all joining the same room so a single
// `emitToAccount` reaches every one of them.
function accountRoom(accountId: Types.ObjectId | string): string {
  return `account:${String(accountId)}`;
}

// The realtime layer (plan §3.4): a socket.io gateway in the same NestJS process. M2 only
// ever emits `reportArrived` (via `ReportsRealtimePublisher`); "incoming attack"/"queue
// done"/"world act changed" are named in the plan but have no producer yet — this gateway
// exists to be the one place every future producer plugs into, not to invent events nobody
// emits yet.
@WebSocketGateway({
  // Caddy's ops split (plan §3.6) reverse-proxies `/api` and `/ws` to this same process —
  // `/ws` (not socket.io's own default `/socket.io`) keeps the realtime surface under that
  // same, already-planned path prefix.
  path: '/ws',
  cors: {
    // A function, evaluated per handshake — NOT a value read once at decorator-evaluation
    // time. Decorator arguments are constructed the moment this file is imported, which
    // happens while Nest is still assembling the module graph, before `ConfigModule.forRoot()`
    // (in `main.ts`, inside `bootstrap()`) has loaded `.env` into `process.env`. Deferring the
    // actual `parseCorsOrigins` call into a closure invoked only once a real handshake
    // arrives sidesteps that ordering hazard entirely, while still matching the REST API's
    // allowed origins exactly (same helper, same env var, same rejection of a wildcard on a
    // credentialed connection).
    origin: (
      requestOrigin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      const allowedOrigins = parseCorsOrigins(process.env['CORS_ORIGINS']);
      callback(null, !requestOrigin || allowedOrigins.includes(requestOrigin));
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  // Explicit @Inject token — see `HealthController`'s comment: Vitest's esbuild transform
  // emits no decorator metadata, so DI cannot rely on `design:paramtypes`.
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  // Authenticates at the socket.io *middleware* layer, not inside `handleConnection` —
  // `server.use()` runs before the handshake completes, so a socket that fails this check
  // never receives a `connect` event at all (the client only ever sees `connect_error`),
  // rather than connecting successfully and then being kicked. Do not invent a second auth
  // mechanism here: the only credential this gateway understands is the same session cookie
  // `AuthGuard` resolves for the REST API, through the very same `AuthService`.
  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticate(socket)
        .then((accountId) => {
          if (!accountId) {
            next(new Error('unauthorized'));
            return;
          }
          // Stashed for `handleConnection` below — rooms can only be joined once the socket
          // is fully connected, which is after this middleware resolves.
          socket.data['accountId'] = accountId;
          next();
        })
        .catch((error: unknown) => {
          this.logger.error(
            'Realtime handshake authentication failed unexpectedly',
            error instanceof Error ? error.stack : String(error),
          );
          next(new Error('unauthorized'));
        });
    });
  }

  handleConnection(client: Socket): void {
    const accountId = client.data['accountId'] as string;
    void client.join(accountRoom(accountId));
  }

  private async authenticate(socket: Socket): Promise<string | null> {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      return null;
    }
    const account = await this.authService.resolveAccountForSession(sessionId, Date.now());
    return account ? String(account._id) : null;
  }

  // The small, injectable emitter API every feature module pushes through (§ M2b.4 brief) —
  // callers (`ReportsRealtimePublisher` today) never touch `Server`/rooms/socket.io beyond
  // this one method.
  emitToAccount(accountId: Types.ObjectId | string, event: string, payload: unknown): void {
    this.server.to(accountRoom(accountId)).emit(event, payload);
  }
}
