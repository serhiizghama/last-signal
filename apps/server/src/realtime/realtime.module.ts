import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  // AuthModule for `AuthService` — the handshake authenticates through the exact same
  // session-cookie resolution the REST API's `AuthGuard` uses (see `RealtimeGateway`'s own
  // comment on why this isn't a second auth mechanism).
  imports: [AuthModule],
  providers: [RealtimeGateway],
  // Feature modules (`ReportsModule` today) import this to inject `RealtimeGateway` and call
  // `.emitToAccount(...)` — the one seam between game logic and socket.io.
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
