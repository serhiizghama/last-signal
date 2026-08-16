import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { AuthProvider, ExternalIdentity } from './auth-provider.interface';

// Guest identities have nothing to verify — this always succeeds, minting a fresh
// provider-scoped id per call. `credentials` is accepted (and ignored) purely to satisfy
// the shared `AuthProvider` interface, so `AuthService`'s call site stays provider-agnostic
// (see that interface's comment).
@Injectable()
export class GuestAuthProvider implements AuthProvider {
  // No `credentials` parameter: nothing to verify, and TypeScript allows an implementation
  // with fewer parameters than the `AuthProvider` interface declares (callers still may
  // pass one; it's simply ignored).
  verify(): Promise<ExternalIdentity> {
    return Promise.resolve({ provider: 'guest', externalId: randomUUID() });
  }
}
